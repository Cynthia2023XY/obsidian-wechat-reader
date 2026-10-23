import { Modal, Notice } from 'obsidian';
import TurndownService from 'turndown';
import type WeChatReaderPlugin from '../main';
import type { Article } from '../collector/types';
import { archiveArticle, cleanArticle, passiveMarkdown } from '../archive/archive';
import { ConfirmModal } from './wechat-modals';
/** 将文章转换成可分享 Markdown，不泄露本机访问令牌 */
export function clipboardMarkdown(article: Article): string {
    // 剪贴板内容使用原始公开图片地址，不复制 blob 或鉴权资源地址。
    const document = new DOMParser().parseFromString(cleanArticle(article.html || ''), 'text/html');
    for (const image of Array.from(document.querySelectorAll('img'))) {
        // 只允许当前文章声明的资源。
        const asset = article.assets.find(asset => image.getAttribute('src') === `asset:${asset.id}`);
        if (asset?.sourceUrl && /^https?:\/\//i.test(asset.sourceUrl) && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(asset.sourceUrl).hostname))
            image.setAttribute('src', asset.sourceUrl);
        else
            image.replaceWith(document.createTextNode('[图片请查看原文或本地归档]'));
    }
    // Markdown 结构在远端 HTML 清理后产生。
    const body = passiveMarkdown(new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(document.body));
    return `# ${article.title.replace(/[\r\n]/g, ' ')}\n\n${article.publishedAt || ''}\n\n${body}\n\n[阅读原文](${article.url})`;
}
/** 独立阅读弹窗，导航队列与侧栏已读筛选保持解耦 */
export class ArticleReaderModal extends Modal {
    /** 当前打开时冻结的文章队列，后台刷新不会插队 */
    private queue: string[];
    /** 当前队列位置 */
    private index: number;
    /** 当前异步选择序号，旧响应不能覆盖新文章 */
    private sequence = 0;
    /** 模态关闭后不再读写界面 */
    private closed = false;
    /** 当前显示成功的完整文章 */
    private article?: Article;
    /** 当前文章的受控本地图片 URL */
    private resources: string[] = [];
    /** 标题和正文的滚动容器 */
    private body!: HTMLElement;
    /** 顶部来源名称 */
    private source!: HTMLElement;
    /** 底部序号 */
    private position!: HTMLElement;
    /** 上一篇按钮 */
    private previous!: HTMLButtonElement;
    /** 下一篇按钮 */
    private next!: HTMLButtonElement;
    /** 需要正文就绪后才能执行的顶部操作 */
    private actions: HTMLButtonElement[] = [];
    /** 收藏状态按钮 */
    private star!: HTMLButtonElement;
    /** 当前上下文和关闭后恢复焦点的回调 */
    constructor(private plugin: WeChatReaderPlugin, ids: string[], initialId: string, private done: () => void) { super(plugin.app); plugin.register(() => { if (!this.closed) this.close(); }); this.queue = [...ids]; this.index = Math.max(0, this.queue.indexOf(initialId)); }
    /** 创建原生模态布局与独立键盘作用域 */
    onOpen(): void {
        this.modalEl.addClass('wr-article-modal');
        this.contentEl.empty();
        this.contentEl.addClass('wr-modal-layout');
        // 顶部工具栏始终可见，文章切换不重建原生模态。
        const toolbar = this.contentEl.createDiv({ cls: 'wr-modal-toolbar' });
        this.source = toolbar.createDiv({ cls: 'wr-modal-source', text: '正在读取…' });
        this.actions.push(this.button(toolbar, '保存为 MD', () => this.saveArticle(), 'wr-save'));
        this.actions.push(this.button(toolbar, '复制文章', async () => { await navigator.clipboard.writeText(clipboardMarkdown(this.article!)); new Notice('文章 Markdown 已复制'); }, 'wr-copy'));
        this.star = this.button(toolbar, '☆', async () => {
            if (!this.article)
                return;
            // 当前库对此文章的收藏及归档状态。
            const state = this.plugin.data.reading[this.article.id] ||= {};
            state.starred = !state.starred;
            await this.plugin.persist();
            this.updateStar();
            this.plugin.service.onChange();
        }, 'wr-star');
        this.actions.push(this.star);
        this.button(toolbar, '↗', () => { if (this.article)
            window.open(this.article.url, '_blank', 'noopener'); }, 'wr-original').setAttribute('aria-label', '阅读原文');
        this.body = this.contentEl.createDiv({ cls: 'wr-modal-body' });
        this.body.tabIndex = 0;
        // 底部方向操作保持稳定，滚动只发生在正文区。
        const footer = this.contentEl.createDiv({ cls: 'wr-modal-footer' });
        this.previous = this.button(footer, '← 上一篇', () => this.navigate(-1), 'wr-prev');
        this.position = footer.createSpan({ cls: 'wr-position' });
        this.next = this.button(footer, '下一篇 →', () => this.navigate(1), 'wr-next');
        footer.createDiv({ cls: 'wr-keyboard-hint', text: '← / → 切换文章　↑ / ↓ 滚动正文　Esc 关闭' });
        this.scope.register([], 'ArrowLeft', event => { if (this.ignoreKey(event))
            return; void this.navigate(-1); return false; });
        this.scope.register([], 'ArrowRight', event => { if (this.ignoreKey(event))
            return; void this.navigate(1); return false; });
        this.scope.register([], 'ArrowUp', event => { if (this.ignoreKey(event))
            return; this.body.scrollBy({ top: -80 }); return false; });
        this.scope.register([], 'ArrowDown', event => { if (this.ignoreKey(event))
            return; this.body.scrollBy({ top: 80 }); return false; });
        void this.show();
    }
    /** 关闭释放图片资源，原生 Modal 自动退出键盘作用域 */
    onClose(): void { this.closed = true; this.sequence++; this.release(); this.contentEl.empty(); this.done(); }
    /** 输入或其他弹窗获得焦点时不劫持方向键 */
    private ignoreKey(event: KeyboardEvent): boolean {
        // 长按不产生无限待处理切换，输入法组合也应交还原生控件。
        const target = event.target as HTMLElement | null;
        return this.closed || event.isComposing || event.repeat || !!target?.closest('input,textarea,select,[contenteditable="true"]') || (target !== null && !this.modalEl.contains(target));
    }
    /** 按固定队列切换，首尾不循环 */
    async navigate(direction: number): Promise<void> {
        // 固定阅读队列内的目标位置，首尾不循环。
        const index = this.index + direction;
        if (index < 0 || index >= this.queue.length)
            return;
        this.index = index;
        await this.show();
    }
    /** 当前文章正文与资源展示成功后才更新本库已读 */
    private async show(): Promise<void> {
        // 快速切换时仅最新请求可以更新阅读状态。
        const sequence = ++this.sequence;
        this.release();
        this.article = undefined;
        this.body.empty();
        this.body.scrollTop = 0;
        this.body.createEl('p', { text: '正在读取正文…', cls: 'wr-placeholder' });
        this.position.setText(`${this.index + 1} / ${this.queue.length}`);
        this.previous.disabled = this.index === 0;
        this.next.disabled = this.index === this.queue.length - 1;
        for (const button of this.actions)
            button.disabled = true;
        try {
            // 统一读取 RSS 本地缓存或公众号共享正文。
            const article = await this.plugin.service.article(this.queue[this.index]);
            if (this.closed || sequence !== this.sequence)
                return;
            this.article = article;
            this.body.empty();
            this.source.setText(this.plugin.service.feeds().find(feed => feed.id === article.accountId)?.title || 'RSS 阅读');
            this.body.createDiv({ cls: 'wr-source-badge', text: article.id.startsWith('rss_') ? 'RSS 订阅' : '微信公众号' });
            this.body.createEl('h1', { text: article.title });
            this.body.createDiv({ cls: 'wr-article-meta', text: `${article.publishedAt ? new Date(article.publishedAt).toLocaleString() : '发布时间未知'} · ${article.contentKind === 'summary' ? '该订阅仅提供摘要' : '正文'}${article.author ? ` · ${article.author}` : ''}` });
            if (article.state !== 'ready' || !article.html) {
                this.body.createEl('p', { text: article.error?.message || '正文尚未就绪，请刷新或查看原文', cls: 'wr-error' });
                return;
            }
            // HTML 先清理，所有图片移除远端 src 后再挂载。
            const document = new DOMParser().parseFromString(cleanArticle(article.html), 'text/html');
            for (const link of Array.from(document.querySelectorAll('a'))) {
                if (!/^https?:\/\//i.test(link.getAttribute('href') || ''))
                    link.removeAttribute('href');
                link.setAttribute('rel', 'noopener noreferrer');
            }
            // 资源占位始终限定于当前文章。
            const tasks = Array.from(document.querySelectorAll('img')).map(image => {
                // 不可信图片地址不直接进入文档。
                const id = image.getAttribute('src')?.replace(/^asset:/, '');
                image.removeAttribute('src');
                // 普通 RSS 的资源首次读取时才下载。
                const asset = article.assets.find(asset => asset.id === id && ['ready', 'remote'].includes(asset.state));
                if (!asset) {
                    image.replaceWith(document.createTextNode('[图片未完整，可查看原文]'));
                    return null;
                }
                return { image, asset };
            }).filter(task => task !== null);
            // 清理后的正文节点采用与主题一致的阅读样式。
            const content = this.body.createDiv({ cls: 'wr-content' });
            content.append(...Array.from(document.body.childNodes));
            this.plugin.data.reading[article.id] = { ...this.plugin.data.reading[article.id], read: true };
            await this.plugin.persist();
            this.plugin.service.onChange();
            if (this.closed || sequence !== this.sequence)
                return;
            for (const button of this.actions)
                button.disabled = false;
            this.updateStar();
            for (const task of tasks) {
                try {
                    // 图片下载串行，不阻塞正文成为可读状态。
                    const bytes = await this.plugin.service.contentProvider().asset(article.id, task.asset);
                    if (this.closed || sequence !== this.sequence)
                        return;
                    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'].includes(task.asset.mime))
                        throw new Error();
                    // blob URL 仅在本弹窗生命周期内有效。
                    const url = URL.createObjectURL(new Blob([bytes], { type: task.asset.mime }));
                    this.resources.push(url);
                    task.image.src = url;
                }
                catch {
                    task.image.replaceWith(document.createTextNode('[图片读取失败，可查看原文]'));
                }
            }
        }
        catch (error) {
            if (!this.closed && sequence === this.sequence) {
                this.body.empty();
                this.body.createEl('p', { cls: 'wr-error', text: error instanceof Error ? error.message : '文章读取失败' });
            }
        }
    }
    /** 将文章归档，保存完成不切走当前阅读 */
    private async saveArticle(copy = false): Promise<void> {
        if (!this.article)
            return;
        // 保存使用操作开始时的文章，切换后也不会关联到另一篇。
        const article = this.article;
        // 当前本库归档状态不影响其他笔记库。
        const state = this.plugin.data.reading[article.id] || {};
        if (state.archive && state.version !== article.contentVersion && !copy) {
            new ConfirmModal(this.app, '正文有更新。另存新副本会保留原笔记及其附件。', () => this.saveArticle(true)).open();
            return;
        }
        this.plugin.data.reading[article.id] = await archiveArticle(this.app, this.plugin.service.contentProvider(), article, this.plugin.service.feeds().find(feed => feed.id === article.accountId)?.title || 'RSS', this.plugin.data.archiveFolder, copy ? { ...state, archive: undefined } : state, false);
        await this.plugin.persist();
        new Notice(state.archive && !copy ? '已保存过该文章，原笔记保持不变' : 'Markdown 与本地图片已保存');
    }
    /** 收藏按钮表达当前库的状态 */
    private updateStar(): void { this.star.setText(this.article && this.plugin.data.reading[this.article.id]?.starred ? '★' : '☆'); this.star.setAttribute('aria-label', '切换收藏'); }
    /** 操作期间禁用当前按钮，失败保持弹窗与滚动位置 */
    private button(parent: HTMLElement, text: string, action: () => unknown | Promise<unknown>, cls: string): HTMLButtonElement {
        // 顶部和底部按钮的事件都归属于当前模态。
        const button = parent.createEl('button', { text, cls });
        button.addEventListener('click', async () => { button.disabled = true; try {
            await action();
        }
        catch (error) {
            new Notice(error instanceof Error ? error.message : '操作失败');
        }
        finally {
            if (!this.closed)
                button.disabled = button === this.previous ? this.index === 0 : button === this.next ? this.index === this.queue.length - 1 : false;
        } });
        return button;
    }
    /** 切换或关闭时释放已创建图片资源 */
    private release(): void { for (const url of this.resources)
        URL.revokeObjectURL(url); this.resources = []; }
}
