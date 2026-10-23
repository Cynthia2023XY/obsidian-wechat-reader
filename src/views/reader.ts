import { ItemView, Menu, Notice, setIcon, WorkspaceLeaf } from 'obsidian';
import type WeChatReaderPlugin from '../main';
import type { Account, Article, Feed, Page } from '../collector/types';
import { ArticleReaderModal } from './article-modal';
import { AddFeedModal, FeedSettingsModal, ImportOpmlModal } from './feed-modals';
import { AccountModal, LoginModal } from './wechat-modals';
/** 保留一期视图 ID，使原有工作区可以平滑恢复 */
export const VIEW_TYPE = 'wechat-reader-view';
/** 右侧简约订阅树，文章点击后交给独立阅读弹窗 */
export class ReaderView extends ItemView {
    /** 展开的源不随后台刷新重置 */
    private expanded = new Set<string>();
    /** 每个源已显示的文章条数 */
    private limits = new Map<string, number>();
    /** 当前聚合筛选条件 */
    private filter = 'all';
    /** 当前被选中的文章 */
    private selected = '';
    /** 公众号状态轮询只在侧栏显示时执行 */
    private timer?: ReturnType<typeof setInterval>;
    /** 生命周期标识阻止关闭后更新 DOM */
    private closed = false;
    /** 防止公众号读取未结束时重复刷新 */
    private refreshing = false;
    /** 订阅与文章列表容器 */
    private list!: HTMLElement;
    /** 顶部来源连接状态 */
    private status!: HTMLElement;
    /** 绑定当前库的阅读服务 */
    constructor(leaf: WorkspaceLeaf, private plugin: WeChatReaderPlugin) { super(leaf); }
    /** Obsidian 工作区恢复使用的固定类型 */
    getViewType(): string { return VIEW_TYPE; }
    /** 侧栏标题与标签名称 */
    getDisplayText(): string { return 'RSS 阅读'; }
    /** 侧栏使用原生 RSS 图标 */
    getIcon(): string { return 'rss'; }
    /** 创建紧凑的原生侧栏，不占用中心笔记区域 */
    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass('wr-sidebar-view');
        this.closed = false;
        // 顶部只保留刷新、添加和更多操作。
        const toolbar = this.contentEl.createDiv({ cls: 'wr-sidebar-toolbar' });
        toolbar.createEl('strong', { text: 'RSS 阅读' });
        this.iconButton(toolbar, 'refresh-cw', '刷新订阅', () => this.refreshAll());
        this.iconButton(toolbar, 'plus', '添加订阅', () => new AddFeedModal(this.plugin, () => this.refresh()).open());
        this.iconButton(toolbar, 'more-vertical', '更多操作', event => this.menu(event));
        this.status = this.contentEl.createDiv({ cls: 'wr-sidebar-status' });
        this.list = this.contentEl.createDiv({ cls: 'wr-subscriptions' });
        // 底部保持导入入口可发现，正常读取不要求附属程序。
        const footer = this.contentEl.createDiv({ cls: 'wr-sidebar-bottom' });
        this.textButton(footer, '＋ 添加订阅', () => new AddFeedModal(this.plugin, () => this.refresh()).open());
        this.textButton(footer, '导入 OPML', () => new ImportOpmlModal(this.plugin).open());
        this.render();
        this.timer = setInterval(() => { if (this.containerEl.isShown() && this.plugin.data.wechatEnabled)
            void this.refresh(); }, 5000);
    }
    /** 关闭只停止 UI 轮询，订阅后台刷新由各自调度器负责 */
    async onClose(): Promise<void> { this.closed = true; if (this.timer)
        clearInterval(this.timer); }
    /** 源状态变动时更新列表，阅读弹窗不受影响 */
    render(): void {
        if (!this.list || this.closed)
            return;
        this.list.empty();
        this.status.setText(this.plugin.service.feeds().length ? '' : '添加 RSS/Atom，或从 OPML 导入订阅。');
        // 聚合未读与收藏基于当前库的阅读状态。
        const all = this.plugin.service.articles();
        // 聚合按钮不修改具体订阅源身份。
        const aggregate = this.list.createDiv({ cls: 'wr-aggregate' });
        for (const [id, label, icon] of [['all', '全部文章', 'files'], ['unread', '未读', 'circle'], ['starred', '收藏', 'star']]) {
            // 计数只使用当前筛选对应的文章集合。
            const count = all.filter(article => id === 'all' || id === 'unread' && !this.plugin.data.reading[article.id]?.read || id === 'starred' && this.plugin.data.reading[article.id]?.starred).length;
            // 按钮被选中后不清除各源的展开状态。
            const button = this.listButton(aggregate, label, icon, count, this.filter === id);
            button.addEventListener('click', () => { this.filter = id; this.render(); });
        }
        // 相同分组下可包含任意数量的公众号与普通源。
        const folders = new Map<string, Feed[]>();
        for (const feed of this.plugin.service.feeds()) {
            const folder = feed.folder || '未分组';
            if (!folders.has(folder))
                folders.set(folder, []);
            folders.get(folder)!.push(feed);
        }
        for (const [folder, feeds] of folders) {
            // 分组标题仅用于组织，不参与缓存键。
            const group = this.list.createDiv({ cls: 'wr-folder' });
            group.createDiv({ cls: 'wr-folder-title', text: folder });
            for (const feed of feeds) {
                // 未读筛选即时更新，但弹窗导航队列已冻结。
                const articles = this.plugin.service.articles(feed.id).filter(article => this.filter === 'all' || this.filter === 'unread' && !this.plugin.data.reading[article.id]?.read || this.filter === 'starred' && this.plugin.data.reading[article.id]?.starred);
                // 源未读徽标不受当前筛选限制。
                const unread = this.plugin.service.articles(feed.id).filter(article => !this.plugin.data.reading[article.id]?.read).length;
                // 当前目录的树形行保留紧凑排版。
                const block = group.createDiv({ cls: 'wr-feed-block' });
                // 任意可用源都能展开，已停用源仍可阅读历史。
                const button = this.listButton(block, feed.title, this.expanded.has(feed.id) ? 'chevron-down' : 'chevron-right', unread, false);
                button.dataset.feedId = feed.id;
                button.classList.add('wr-feed-title');
                button.title = feed.error || `${feed.kind === 'wechat' ? '微信公众号' : 'RSS/Atom'}${feed.enabled ? '' : ' · 自动刷新已暂停'}`;
                button.addEventListener('click', () => { if (this.expanded.has(feed.id))
                    this.expanded.delete(feed.id);
                else
                    this.expanded.add(feed.id); this.render(); });
                button.addEventListener('contextmenu', event => { event.preventDefault(); this.feedMenu(feed, event); });
                if (feed.error)
                    block.createDiv({ cls: 'wr-feed-error', text: feed.error });
                if (!this.expanded.has(feed.id))
                    continue;
                // 每个源分页展示，避免大量历史撑满侧栏。
                const limit = this.limits.get(feed.id) || 40;
                for (const article of articles.slice(0, limit))
                    this.articleRow(block, article, articles.map(item => item.id));
                if (articles.length > limit)
                    this.textButton(block, '加载更多…', () => { this.limits.set(feed.id, limit + 40); this.render(); });
                if (!articles.length)
                    block.createDiv({ cls: 'wr-empty-feed', text: '暂无符合条件的文章' });
            }
        }
    }
    /** 按需更新公众号状态，普通 RSS 仍可独立操作 */
    async refresh(): Promise<void> {
        if (this.refreshing || this.closed)
            return;
        this.refreshing = true;
        try {
            if (this.plugin.data.wechatEnabled)
                await this.plugin.service.refreshWeChat();
            this.render();
        }
        catch (error) {
            if (!this.closed)
                this.status.setText(error instanceof Error ? error.message : '公众号暂不可用');
        }
        finally {
            this.refreshing = false;
        }
    }
    /** 文章行仅使用文本，标题和日期不执行远端 HTML */
    private articleRow(parent: HTMLElement, article: Article, queue: string[]): void {
        // 当前库的已读状态决定标题字重和未读点。
        const read = !!this.plugin.data.reading[article.id]?.read;
        // 当前选择保留可见状态，右侧弹窗关闭后可恢复焦点。
        const button = parent.createEl('button', { cls: `wr-article-row ${read ? 'is-read' : 'is-unread'} ${this.selected === article.id ? 'is-selected' : ''}` });
        button.dataset.articleId = article.id;
        button.createSpan({ cls: 'wr-unread-dot', text: read ? '' : '•' });
        button.createSpan({ cls: 'wr-row-title', text: article.title });
        button.createSpan({ cls: 'wr-row-meta', text: `${article.publishedAt ? new Date(article.publishedAt).toLocaleDateString() : ''} · ${article.state === 'ready' ? (read ? '已读' : '未读') : '正文未就绪'}` });
        button.addEventListener('click', () => { this.selected = article.id; new ArticleReaderModal(this.plugin, queue, article.id, () => { this.render(); this.list.querySelector<HTMLButtonElement>(`[data-article-id="${article.id}"]`)?.focus(); }).open(); this.render(); });
        button.addEventListener('contextmenu', event => { event.preventDefault(); new Menu().addItem(item => item.setTitle(read ? '标为未读' : '标为已读').setIcon('check').onClick(async () => { this.plugin.data.reading[article.id] = { ...this.plugin.data.reading[article.id], read: !read }; await this.plugin.persist(); this.render(); })).showAtMouseEvent(event); });
    }
    /** 源菜单管理普通订阅和公众号各自的配置 */
    private feedMenu(feed: Feed, event: MouseEvent): void {
        // 原生 Menu 自动适配主题及键盘焦点。
        const menu = new Menu().addItem(item => item.setTitle('立即刷新').setIcon('refresh-cw').onClick(() => { void this.plugin.service.refresh(feed).catch(error => new Notice(error.message)); }));
        menu.addItem(item => item.setTitle('订阅设置').setIcon('settings').onClick(async () => {
            if (feed.kind === 'wechat') {
                try {
                    const account = (await (await this.plugin.provider()).call<Page<Account>>('/v1/accounts')).items.find(account => account.id === feed.id);
                    if (account)
                        new AccountModal(this.plugin, account, () => this.refresh()).open();
                }
                catch (error) {
                    new Notice(error instanceof Error ? error.message : '读取失败');
                }
            }
            else
                new FeedSettingsModal(this.plugin, feed).open();
        }));
        if (feed.kind === 'wechat')
            menu.addItem(item => item.setTitle('复制本机 RSS 订阅地址').setIcon('rss').onClick(async () => { try {
                const result = await (await this.plugin.provider()).call<{
                    url: string;
                }>(`/v1/accounts/${feed.id}/rss`);
                await navigator.clipboard.writeText(result.url);
                new Notice('本机 RSS 订阅地址已复制，仅在采集运行时运行期间可访问');
            }
            catch (error) {
                new Notice(error instanceof Error ? error.message : '读取失败');
            } }));
        else
            menu.addItem(item => item.setTitle('取消自动订阅，保留历史').setIcon('pause').onClick(() => this.plugin.service.unsubscribe(feed)));
        menu.showAtMouseEvent(event);
    }
    /** 聚合与树行共用简约按钮结构 */
    private listButton(parent: HTMLElement, label: string, icon: string, count: number, selected: boolean): HTMLButtonElement {
        // 文本与数字分列，窄侧栏保持省略和徽标对齐。
        const button = parent.createEl('button', { cls: `wr-tree-row ${selected ? 'is-active' : ''}` });
        setIcon(button.createSpan({ cls: 'wr-row-icon' }), icon);
        button.createSpan({ cls: 'wr-row-label', text: label });
        if (count)
            button.createSpan({ cls: 'wr-count', text: String(count) });
        return button;
    }
    /** 顶部操作菜单保留公众号登录和 OPML 入口 */
    private menu(event: MouseEvent): void {
        new Menu().addItem(item => item.setTitle('导入 OPML').setIcon('import').onClick(() => new ImportOpmlModal(this.plugin).open()))
            .addItem(item => item.setTitle('微信读书登录').setIcon('qr-code').onClick(async () => { try {
            await this.plugin.service.enableWeChat();
            new LoginModal(this.plugin).open();
        }
        catch (error) {
            new Notice(error instanceof Error ? error.message : '连接失败');
        } }))
            .addItem(item => item.setTitle('重新连接公众号采集').setIcon('refresh-cw').onClick(async () => { try {
            await this.plugin.runtime.retry();
            await this.plugin.service.enableWeChat();
            new Notice('公众号采集已重新连接');
        }
        catch (error) {
            new Notice(error instanceof Error ? error.message : '连接失败');
        } }))
            .addItem(item => item.setTitle('导出 OPML').setIcon('download').onClick(() => { void this.plugin.exportOpml(); })).showAtMouseEvent(event);
    }
    /** 用户触发全部刷新时逐源执行，错误保留到对应源 */
    private async refreshAll(): Promise<void> { for (const feed of this.plugin.service.feeds().filter(feed => feed.enabled)) {
        await this.plugin.service.refresh(feed).catch(error => new Notice(`${feed.title}：${error.message}`));
    } await this.refresh(); }
    /** 图标按钮提供可读名称，兼容鼠标与屏幕阅读器 */
    private iconButton(parent: HTMLElement, icon: string, label: string, action: (event: MouseEvent) => unknown): void { const button = parent.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label, title: label } }); setIcon(button, icon); button.addEventListener('click', event => { try {
        const result = action(event);
        if (result instanceof Promise)
            void result.catch(error => new Notice(error.message));
    }
    catch (error) {
        new Notice(error instanceof Error ? error.message : '操作失败');
    } }); }
    /** 普通文本操作按钮保持侧栏紧凑 */
    private textButton(parent: HTMLElement, label: string, action: () => unknown): void { const button = parent.createEl('button', { text: label, cls: 'wr-text-button' }); button.addEventListener('click', () => { const result = action(); if (result instanceof Promise)
        void result.catch(error => new Notice(error.message)); }); }
}
