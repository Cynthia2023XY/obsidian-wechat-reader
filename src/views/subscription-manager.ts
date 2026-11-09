import { Menu, Modal, Notice } from 'obsidian';
import type WeChatReaderPlugin from '../main';
import type { Account, Feed, Page } from '../collector/types';
import { subscriptionLink, SubscriptionImportModal, renderSubscriptionLinks } from './subscription-settings';
import { AddFeedModal, FeedSettingsModal, ImportOpmlModal } from './feed-modals';
import { AccountModal, ConfirmModal, SubscribeModal } from './wechat-modals';

/** 来源管理统一入口，设置页与阅读器共用同一窗口 */
export class SubscriptionManagerModal extends Modal {
    /** 按名称、分组或地址搜索 */
    private query = '';
    /** 当前刷新状态筛选 */
    private status = 'all';
    /** 搜索结果区域，筛选时保留输入焦点 */
    private results!: HTMLElement;
    /** 已展开详情的来源身份 */
    private expanded = new Set<string>();
    /** 操作期间禁止重复提交 */
    private busy = false;
    /** 数据变化后刷新列表的事件监听 */
    private changed = (): void => this.render();
    /** 当前笔记库插件服务 */
    constructor(private plugin: WeChatReaderPlugin) { super(plugin.app); }
    /** 构建紧凑列表及来源配置入口 */
    onOpen(): void {
        this.modalEl.classList.add('wr-manager-modal');
        this.contentEl.createEl('h2', { text: '订阅管理' });
        // 控制条与结果区域分开，输入时不重建搜索框。
        const toolbar = this.contentEl.createDiv({ cls: 'wr-manager-toolbar' });
        // 搜索输入保持焦点，筛选时只更新结果区。
        const search = toolbar.createEl('input', { attr: { type: 'search', placeholder: '搜索名称、分组或链接', 'aria-label': '搜索订阅' } });
        search.addEventListener('input', () => { this.query = search.value; this.render(); });
        // 按自动更新状态筛选来源。
        const status = toolbar.createEl('select', { attr: { 'aria-label': '筛选订阅状态' } });
        // 状态选项与自动更新开关保持一致。
        for (const [value, text] of [['all', '全部'], ['enabled', '订阅中'], ['paused', '已暂停']]) status.createEl('option', { value, text });
        status.addEventListener('change', () => { this.status = status.value; this.render(); });
        toolbar.createEl('button', { text: '添加订阅', cls: 'mod-cta' }).addEventListener('click', () => new AddFeedModal(this.plugin, async () => this.render()).open());
        toolbar.createEl('button', { text: '更多', attr: { 'aria-label': '导入和导出订阅' } }).addEventListener('click', event => {
            new Menu()
                .addItem(item => item.setTitle('导入订阅配置').onClick(() => new SubscriptionImportModal(this.plugin, () => this.render()).open()))
                .addItem(item => item.setTitle('导入 OPML').onClick(() => new ImportOpmlModal(this.plugin).open()))
                .addItem(item => item.setTitle('导出订阅配置').onClick(() => this.run(() => this.plugin.exportSubscriptionConfiguration())))
                .showAtMouseEvent(event);
        });
        this.contentEl.createEl('p', { cls: 'wr-placeholder', text: '暂停保留来源入口；移除后从列表隐藏，历史文章、已读、收藏与归档保留。' });
        this.results = this.contentEl.createDiv({ cls: 'wr-manager-results' });
        window.addEventListener('wechat-reader:subscriptions-changed', this.changed);
        this.render();
    }
    /** 仅在窗口存活时响应后台快照及其他入口的修改 */
    onClose(): void {
        window.removeEventListener('wechat-reader:subscriptions-changed', this.changed);
        this.contentEl.empty();
    }
    /** 名称、状态和分组优先显示，完整链接按需展开 */
    private render(): void {
        if (!this.results) return;
        this.results.empty();
        // 状态筛选和文本搜索共同约束当前列表。
        const feeds = this.plugin.service.feeds().filter(feed => (this.status === 'all' || feed.enabled === (this.status === 'enabled')) && `${feed.title} ${feed.folder} ${subscriptionLink(feed) || ''}`.toLocaleLowerCase().includes(this.query.trim().toLocaleLowerCase()));
        this.results.createEl('p', { cls: 'wr-placeholder', text: `共 ${feeds.length} 个订阅` });
        if (!feeds.length) this.results.createEl('p', { text: '没有符合条件的订阅。' });
        for (const feed of feeds) {
            // 每个来源使用独立行承载详情与操作。
            const row = this.results.createDiv({ cls: 'wr-manager-row' });
            // 来源名称、状态与操作按钮共用紧凑标题行。
            const heading = row.createDiv({ cls: 'wr-manager-heading' });
            // 点击名称展开链接详情，默认收起节省空间。
            const title = heading.createEl('button', { text: feed.title, cls: 'wr-manager-title', attr: { 'aria-expanded': String(this.expanded.has(feed.id)) } });
            title.addEventListener('click', () => { if (this.expanded.has(feed.id)) this.expanded.delete(feed.id); else this.expanded.add(feed.id); this.render(); });
            heading.createSpan( { cls: 'wr-placeholder', text: `${feed.kind === 'wechat' ? '公众号' : feed.kind.toUpperCase()} · ${feed.folder || '未分组'} · ${feed.enabled ? '订阅中' : '已暂停'}` });
            // 来源配置和更多操作的按钮区域。
            const actions = heading.createDiv({ cls: 'wr-manager-actions' });
            actions.createEl('button', { text: '设置' }).addEventListener('click', () => { void this.run(() => this.settings(feed)); });
            actions.createEl('button', { text: '更多', attr: { 'aria-label': `管理${feed.title}` } }).addEventListener('click', event => {
                new Menu()
                    .addItem(item => item.setTitle(feed.enabled ? '暂停自动更新' : '恢复自动更新').onClick(() => this.run(() => this.plugin.service.setEnabled(feed, !feed.enabled))))
                    .addItem(item => item.setTitle('立即刷新').onClick(() => this.run(() => this.plugin.service.refresh(feed))))
                    .addItem(item => item.setTitle('移除订阅').setIcon('trash-2').onClick(() => confirmSubscriptionRemoval(this.plugin, feed)))
                    .showAtMouseEvent(event);
            });
            // 执行期间阻止同一窗口重复提交。
            for (const button of Array.from(actions.querySelectorAll('button'))) button.disabled = this.busy;
            if (this.expanded.has(feed.id)) {
                // 完整地址和刷新配置按需展示。
                const detail = row.createDiv({ cls: 'wr-manager-detail' });
                detail.createEl('p', { text: feed.kind === 'wechat' ? '恢复用原文链接' : '订阅地址' });
                renderSubscriptionLinks(detail.createDiv(), [feed]);
                detail.createEl('p', { cls: 'wr-placeholder', text: `刷新间隔：${feed.intervalMinutes / 60} 小时${feed.kind === 'wechat' && feed.wechat ? `～${feed.wechat.intervalMax / 60} 小时（随机）` : ''}` });
                if (feed.error) detail.createEl('p', { cls: 'wr-error', text: feed.error });
                if (feed.kind === 'wechat' && feed.missingLocalData) detail.createEl('button', { text: '补充恢复链接' }).addEventListener('click', () => new SubscribeModal(this.plugin, async () => this.render(), feed).open());
            }
        }
    }
    /** 复用现有配置表单，关闭表单后由服务通知更新 */
    private async settings(feed: Feed): Promise<void> {
        if (feed.kind !== 'wechat') { new FeedSettingsModal(this.plugin, feed).open(); return; }
        // 缺失本机信息时提供可操作的恢复入口。
        if (feed.missingLocalData) { new SubscribeModal(this.plugin, async () => this.render(), feed).open(); return; }
        // 读取共享账户的最新配置后打开表单。
        const account = (await (await this.plugin.provider()).call<Page<Account>>('/v1/accounts')).items.find(item => item.id === feed.id);
        if (!account) throw new Error('本机公众号信息缺失，请先恢复订阅');
        new AccountModal(this.plugin, account, async () => { await this.plugin.service.refreshWeChat(); this.render(); }).open();
    }
    /** 集中处理异步失败并在请求期间锁定重复操作 */
    private async run(action: () => Promise<void>): Promise<void> {
        if (this.busy) return;
        this.busy = true; this.render();
        try { await action(); }
        catch (error) { new Notice(error instanceof Error ? error.message : '操作失败'); }
        finally { this.busy = false; this.render(); }
    }
}

/** 所有入口共用明确的移除确认，不删除历史或归档文件 */
export function confirmSubscriptionRemoval(plugin: WeChatReaderPlugin, feed: Feed): void {
    new ConfirmModal(plugin.app, `移除「${feed.title}」？来源将从本库订阅列表隐藏，历史文章、已读、收藏和归档笔记保留。${feed.kind === 'wechat' ? '将同时停止此公众号的本机共享采集，其他笔记库也会停止自动更新。' : '后续不再自动刷新。'}重新添加相同来源可恢复入口。`, () => plugin.service.removeSubscription(feed)).open();
}
