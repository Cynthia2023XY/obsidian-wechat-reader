import { FileSystemAdapter, Modal, Notice } from 'obsidian';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type WeChatReaderPlugin from '../main';
import { collectCacheProtection } from '../cache/protection';

/** 采集服务返回的共享正文预览，仅包含公众号身份和大小。 */
interface CleanupPreview { id: string; articles: number; bytes: number; accounts: Array<{ accountId: string; articles: number; bytes: number }> }

/** 共享缓存预览与确认窗口，不自动删除已有数据。 */
export class CacheModal extends Modal {
    /** 预览期间持有租约，避免服务退出导致预览失效。 */
    private release?: () => void;
    /** 仅当前窗口保留短期预览标识。 */
    private preview?: CleanupPreview;
    /** 确认前要求已核对的其他笔记库数量保持不变。 */
    private previewVaults = 0;
    /** 窗口关闭后不再更新控件。 */
    private closed = false;
    /** 绑定当前库及其阅读保护信息。 */
    constructor(private plugin: WeChatReaderPlugin) { super(plugin.app); }
    /** 检查其他已登记笔记库的收藏与归档。 */
    private protection() {
        if (!(this.plugin.app.vault.adapter instanceof FileSystemAdapter)) throw new Error('需要桌面本机笔记库');
        return collectCacheProtection(join(homedir(), 'Library/Application Support/obsidian/obsidian.json'), this.plugin.app.vault.adapter.getBasePath(), this.plugin.data);
    }
    /** 选择日期并先预览，确认后才清理共享正文。 */
    onOpen(): void {
        this.contentEl.createEl('h2', { text: '管理公众号共享缓存' });
        this.contentEl.createEl('p', { text: '清理指定日期（UTC）之前的共享正文和图片，保留文章索引、已读状态和归档笔记。其他笔记库和本机 RSS 也会失去这些文章的共享离线正文，可稍后重试获取。' });
        this.contentEl.createEl('p', { text: '已登记笔记库中收藏或归档的文章会排除。请先关闭其他笔记库；未登记或无法检测的笔记库可能使用共享正文，请确认其数据不受影响。' });
        // 由用户选择日期，不自动执行删除。
        const date = this.contentEl.createEl('input', { type: 'date' });
        // 结果区使用文本渲染，避免公众号名称被当作 HTML。
        const output = this.contentEl.createDiv();
        // 未获得有效预览时不能执行清理。
        const confirm = this.contentEl.createEl('button', { text: '确认清理共享正文' });
        confirm.disabled = true;
        // 每次预览重新计算可清理内容。
        const preview = this.contentEl.createEl('button', { text: '预览清理范围' });
        date.addEventListener('change', () => { this.preview = undefined; confirm.disabled = true; output.empty(); });
        preview.addEventListener('click', () => { void (async () => {
            preview.disabled = true; confirm.disabled = true; this.preview = undefined; output.empty();
            try {
                if (!this.release) this.release = await this.plugin.runtime.acquire();
                if (this.closed) { this.release?.(); this.release = undefined; return; }
                // 预览和确认时分别核对所有已登记库。
                const protection = await this.protection();
                // 防止预览期间修改日期导致展示与请求条件不一致。
                const before = date.value;
                // 服务返回短期有效的预览及各公众号的占用。
                const result = await (await this.plugin.provider()).call<CleanupPreview>('/v1/cache/preview', 'POST', { before, protectedIds: protection.protectedIds });
                if (this.closed || date.value !== before) return;
                this.preview = result; this.previewVaults = protection.otherVaults;
                output.createEl('p', { text: `共 ${result.articles} 篇，预计释放 ${(result.bytes / 1024 ** 2).toFixed(1)} MB；已核对 ${protection.otherVaults} 个其他已安装本插件的笔记库。` });
                for (const row of result.accounts) {
                    // 找不到名称时只展示安全的公众号标识。
                    const name = this.plugin.service.feeds().find(feed => feed.id === row.accountId)?.title || row.accountId;
                    output.createEl('p', { text: `${name}：${row.articles} 篇，${(row.bytes / 1024 ** 2).toFixed(1)} MB` });
                }
                confirm.disabled = !result.articles;
            } catch (error) { if (!this.closed) new Notice(error instanceof Error ? error.message : '预览失败'); }
            finally { preview.disabled = false; }
        })(); });
        confirm.addEventListener('click', () => { void (async () => {
            if (!this.preview) return;
            confirm.disabled = true; preview.disabled = true;
            try {
                // 再次读取保护列表，收藏变化将使旧预览失效。
                const protection = await this.protection();
                if (protection.otherVaults !== this.previewVaults) throw new Error('其他笔记库状态已变化，请重新预览');
                // 确认请求使用刚核对的保护项。
                const result = await (await this.plugin.provider()).call<{ articles: number; bytes: number }>('/v1/cache/clean', 'POST', { id: this.preview.id, protectedIds: protection.protectedIds });
                this.preview = undefined;
                // 清理已经完成，后续刷新失败不能误报删除失败。
                const refreshed = await this.plugin.service.refreshWeChat().then(() => true, () => false);
                new Notice(`已清理 ${result.articles} 篇共享正文，约 ${(result.bytes / 1024 ** 2).toFixed(1)} MB${refreshed ? '' : '；列表刷新失败，请稍后重试'}`);
                this.close();
            } catch (error) { this.preview = undefined; new Notice(error instanceof Error ? error.message : '清理失败，请重新预览'); }
            finally { preview.disabled = false; }
        })(); });
    }
    /** 关闭窗口释放预览租约。 */
    onClose(): void { this.closed = true; this.release?.(); this.release = undefined; this.contentEl.empty(); }
}
