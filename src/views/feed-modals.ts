import { intervalMinutes, intervalHours, nextRefresh } from '../feeds/interval';
import { Modal, Notice, Setting } from 'obsidian';
import type WeChatReaderPlugin from '../main';
import type { Feed, ImportFeed } from '../collector/types';
import { parseOpml } from '../feeds/parser';
import { SubscribeModal } from './wechat-modals';
/** 统一添加入口，普通 RSS 与公众号互不要求对方登录 */
export class AddFeedModal extends Modal {
    /** 当前输入的订阅地址 */
    private url = '';
    /** 用户选择的分组 */
    private folder = 'RSS 订阅';
    /** 当前插件与侧栏刷新回调 */
    constructor(private plugin: WeChatReaderPlugin, private done: () => Promise<void>) { super(plugin.app); }
    /** 展示清晰的 RSS 与公众号两种添加方式 */
    onOpen(): void {
        this.contentEl.createEl('h2', { text: '添加订阅' });
        new Setting(this.contentEl).setName('RSS / Atom 地址').addText(text => text.setPlaceholder('https://example.com/feed.xml').onChange(value => { this.url = value; }));
        new Setting(this.contentEl).setName('分组').addText(text => text.setValue(this.folder).onChange(value => { this.folder = value; }));
        new Setting(this.contentEl).addButton(button => button.setButtonText('添加 RSS 订阅').setCta().onClick(async () => { button.setDisabled(true); try {
            await this.plugin.service.add(this.url, '', this.folder);
            this.close();
            await this.done();
        }
        catch (error) {
            new Notice(error instanceof Error ? error.message : '添加失败');
            button.setDisabled(false);
        } }));
        new Setting(this.contentEl).setName('微信公众号').setDesc('使用文章链接添加，需要微信读书授权。').addButton(button => button.setButtonText('添加公众号').onClick(async () => { button.setDisabled(true); try {
            await this.plugin.service.enableWeChat();
            this.close();
            new SubscribeModal(this.plugin, this.done).open();
        }
        catch (error) {
            new Notice(error instanceof Error ? error.message : '连接失败');
            button.setDisabled(false);
        } }));
    }
}
/** OPML 导入先预览再执行，每个条目独立记录结果 */
export class ImportOpmlModal extends Modal {
    /** 导入预览中的有效、重复和无效条目 */
    private items: ImportFeed[] = [];
    /** 用户选择的本地清单只在当前窗口内读取 */
    constructor(private plugin: WeChatReaderPlugin) { super(plugin.app); }
    /** 文件选择不依赖额外文件系统权限或外部上传 */
    onOpen(): void {
        this.contentEl.createEl('h2', { text: '导入 OPML 订阅清单' });
        // 只选择清单文件，不将内容上传服务器。
        const file = this.contentEl.createEl('input', { type: 'file', attr: { accept: '.opml,.xml,text/xml,application/xml' } });
        // 预览区采用文本，防止清单中的名称被当作 HTML。
        const preview = this.contentEl.createDiv({ cls: 'wr-import-preview' });
        file.addEventListener('change', async () => { try {
            this.items = parseOpml(await file.files![0].text(), this.plugin.service.feeds());
            preview.empty();
            for (const item of this.items)
                preview.createEl('p', { text: `${item.error ? '无效' : item.duplicate ? '重复' : '新增'} · ${item.folder ? `${item.folder} / ` : ''}${item.title}${item.error ? `：${item.error}` : ''}` });
        }
        catch (error) {
            new Notice(error instanceof Error ? error.message : '清单读取失败');
        } });
        new Setting(this.contentEl).addButton(button => button.setButtonText('确认导入').setCta().onClick(async () => {
            button.setDisabled(true);
            // 每个订阅独立执行，错误不会影响其余条目。
            let success = 0, failed = 0;
            for (const item of this.items.filter(item => !item.error && !item.duplicate)) {
                try {
                    await this.plugin.service.add(item.url, item.title, item.folder || 'RSS 订阅');
                    success++;
                }
                catch (error) {
                    failed++;
                    preview.createEl('p', { cls: 'wr-error', text: `${item.title}：${error instanceof Error ? error.message : '导入失败'}` });
                }
            }
            new Notice(`导入完成：成功 ${success}，失败 ${failed}`);
            button.setDisabled(false);
            if (!failed)
                this.close();
        }));
    }
}
/** 修改普通源名称和分组不改变源和历史文章 ID */
export class FeedSettingsModal extends Modal {
    /** 当前普通 RSS 源 */
    constructor(private plugin: WeChatReaderPlugin, private feed: Feed) { super(plugin.app); }
    /** 原生设置表单继承 Obsidian 深浅色主题 */
    onOpen(): void {
        this.contentEl.createEl('h2', { text: '订阅设置' });
        // 所有修改先暂存，点击保存后再更新配置。
        let title = this.feed.title, folder = this.feed.folder, interval = intervalHours(this.feed.intervalMinutes), enabled = this.feed.enabled;
        new Setting(this.contentEl).setName('名称').addText(text => text.setValue(title).onChange(value => { title = value; }));
        new Setting(this.contentEl).setName('分组').addText(text => text.setValue(folder).onChange(value => { folder = value; }));
        new Setting(this.contentEl).setName('自动刷新').addToggle(toggle => toggle.setValue(enabled).onChange(value => { enabled = value; }));
        new Setting(this.contentEl).setName('刷新间隔（小时）').setDesc('默认 1 小时；可输入小数，最低 5 分钟，精确到整分钟。').addText(text => text.setValue(interval).onChange(value => { interval = value; }));
        this.contentEl.createEl('p', { text: nextRefresh(this.feed.retryAt || ((this.feed.checkedAt || Date.now()) + this.feed.intervalMinutes * 60000), !!this.feed.retryAt) });
        new Setting(this.contentEl).addButton(button => button.setButtonText('保存').setCta().onClick(async () => {
            try {
                if (!title.trim()) throw new Error('名称不能为空');
                await this.plugin.service.update(this.feed, { title: title.trim(), folder, intervalMinutes: intervalMinutes(interval), enabled });
                this.close();
            } catch (error) { new Notice(error instanceof Error ? error.message : '保存失败'); }
        }));
    }
}
