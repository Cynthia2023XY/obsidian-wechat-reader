import { Modal, Notice } from 'obsidian';
import type WeChatReaderPlugin from '../main';
import type { Feed } from '../collector/types';
import { subscriptionForFeed } from '../collector/subscriptions';
import { parseSubscriptionConfiguration, planSubscriptionImport } from '../feeds/configuration';

export function subscriptionLink(feed: Feed): string | undefined {
    return feed.kind === 'wechat' ? subscriptionForFeed(feed)?.articleUrl : feed.url;
}
/** 设置中仅展示、选择和复制链接，不提供编辑入口或启动服务。 */
export function renderSubscriptionLinks(parent: HTMLElement, feeds: Feed[]): void {
    parent.empty();
    if (!feeds.length) { parent.createEl('p', { cls: 'wr-placeholder', text: '还没有订阅。' }); return; }
    for (const feed of feeds) {
        const row = parent.createDiv({ cls: 'wr-subscription-setting-row' });
        row.createEl('strong', { text: feed.title });
        row.createEl('small', { cls: 'wr-placeholder', text: `${feed.kind === 'wechat' ? '微信公众号原文链接' : feed.kind === 'atom' ? 'Atom 订阅地址' : 'RSS 订阅地址'} · ${feed.folder || '未分组'}${feed.enabled ? '' : ' · 自动刷新已暂停'}` });
        const control = row.createDiv({ cls: 'wr-subscription-link-control' });
        const input = control.createEl('textarea', { cls: 'wr-subscription-link', attr: { 'aria-label': `${feed.title}的链接（只读）`, rows: '2' } });
        input.readOnly = true;
        input.spellcheck = false;
        const url = subscriptionLink(feed);
        input.value = url || '';
        input.placeholder = subscriptionForFeed(feed) ? '未保存原文链接；已保存公众号身份，可用于恢复订阅。' : '未保存原文链接；请在侧栏右键公众号，补充恢复链接。';
        const copy = control.createEl('button', { text: '复制链接', attr: { 'aria-label': `复制${feed.title}的链接` } });
        copy.disabled = !url;
        copy.addEventListener('click', async () => {
            try { if (url) { await navigator.clipboard.writeText(url); new Notice('链接已复制'); } }
            catch { new Notice('复制失败，请手动选择并复制链接'); }
        });
    }
}
export function appendSubscriptionSettings(parent: HTMLElement, plugin: WeChatReaderPlugin, onImported: () => void): HTMLElement {
    parent.createEl('h3', { text: '订阅配置' });
    parent.createEl('p', { cls: 'wr-placeholder', text: '导出名称、链接、分组、开关和刷新间隔，支持 RSS、Atom 和公众号。登录凭据、文章缓存和阅读记录不包含在内。' });
    const actions = parent.createDiv({ cls: 'wr-subscription-config-actions' });
    const exportButton = actions.createEl('button', { text: '导出订阅配置' });
    exportButton.addEventListener('click', async () => {
        exportButton.disabled = true;
        try { await plugin.exportSubscriptionConfiguration(); }
        catch (error) { new Notice(error instanceof Error ? error.message : '导出失败'); }
        finally { exportButton.disabled = false; }
    });
    actions.createEl('button', { text: '导入订阅配置' }).addEventListener('click', () => new SubscriptionImportModal(plugin, onImported).open());
    parent.createEl('h3', { text: '当前订阅链接（只读）' });
    parent.createEl('p', { cls: 'wr-placeholder', text: '包含已暂停的订阅。公众号显示已保存、用于恢复订阅的原文链接；未保存的链接会明确提示。' });
    const list = parent.createDiv({ cls: 'wr-subscription-settings-list' });
    renderSubscriptionLinks(list, plugin.service.feeds());
    return list;
}
/** JSON 文件完全验证后预览，点击确认时重新按最新本库状态合并。 */
export class SubscriptionImportModal extends Modal {
    private text?: string;
    private sequence = 0;
    private closed = false;
    private preview!: HTMLElement;
    private confirm!: HTMLButtonElement;
    constructor(private plugin: WeChatReaderPlugin, private imported: () => void) { super(plugin.app); }
    onOpen(): void {
        this.contentEl.createEl('h2', { text: '导入订阅配置' });
        this.contentEl.createEl('p', { text: '选择本插件导出的 JSON 文件。合并新增订阅，保留已有订阅的设置，补齐缺失的公众号恢复信息；不会替换阅读记录。导入后按计划刷新，公众号需在本机登录后恢复。' });
        const file = this.contentEl.createEl('input', { attr: { accept: '.json,application/json', 'aria-label': '选择订阅配置文件' } });
        file.type = 'file';
        this.preview = this.contentEl.createDiv({ cls: 'wr-import-preview' });
        const actions = this.contentEl.createDiv({ cls: 'wr-subscription-config-actions' });
        actions.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
        this.confirm = actions.createEl('button', { text: '确认导入', cls: 'mod-cta' });
        this.confirm.disabled = true;
        file.addEventListener('change', async () => {
            const sequence = ++this.sequence;
            this.text = undefined; this.confirm.disabled = true; this.preview.empty();
            const selected = file.files?.[0];
            if (!selected) return;
            try {
                if (selected.size > 5 * 1024 * 1024) throw new Error('订阅配置不能超过 5 MB');
                const text = await selected.text();
                if (this.closed || sequence !== this.sequence) return;
                this.previewConfiguration(text);
            } catch (error) {
                if (!this.closed && sequence === this.sequence) this.preview.createEl('p', { cls: 'wr-error', text: error instanceof Error ? error.message : '文件读取失败' });
            }
        });
        this.confirm.addEventListener('click', async () => {
            if (this.text === undefined) return;
            this.confirm.disabled = true; file.disabled = true;
            try {
                const result = await this.plugin.service.importConfiguration(this.text);
                this.imported();
                new Notice(`导入完成：新增 ${result.added} 个，补齐 ${result.updated} 个，跳过重复 ${result.skipped} 个${result.needsLink ? `；${result.needsLink} 个旧公众号需补充恢复链接` : ''}`);
                this.close();
            } catch (error) { new Notice(error instanceof Error ? error.message : '导入失败'); }
            finally { if (!this.closed) { this.confirm.disabled = false; file.disabled = false; } }
        });
    }
    previewConfiguration(text: string): void {
        this.text = undefined; this.confirm.disabled = true; this.preview.empty();
        const feeds = parseSubscriptionConfiguration(text);
        const plan = planSubscriptionImport(this.plugin.data, feeds);
        this.preview.createEl('p', { text: `新增 ${plan.added} 个，补齐恢复信息 ${plan.updated} 个，跳过重复 ${plan.skipped} 个。` });
        for (const feed of feeds) this.preview.createEl('p', { text: `${feed.kind === 'wechat' ? '公众号' : feed.kind.toUpperCase()} · ${feed.folder || '未分组'} / ${feed.title} · ${subscriptionLink(feed) || '未保存原文链接'}` });
        if (plan.needsLink) this.preview.createEl('p', { text: `${plan.needsLink} 个旧公众号没有完整恢复信息，导入后需右键补充恢复链接。` });
        this.text = text;
        this.confirm.disabled = !plan.added && !plan.updated;
    }
    onClose(): void { this.closed = true; ++this.sequence; this.text = undefined; this.contentEl.empty(); }
}
