import { ItemView, Menu, Notice, setIcon, WorkspaceLeaf } from 'obsidian';
import type WeChatReaderPlugin from '../main';
import type { Account, Article, Feed, Page } from '../collector/types';
import { ArticleReaderModal } from './article-modal';
import { AddFeedModal, FeedSettingsModal, ImportOpmlModal } from './feed-modals';
import { missingSubscriptionMessage, subscriptionForFeed } from '../collector/subscriptions';
import { AccountModal, LoginModal, SubscribeModal } from './wechat-modals';
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
        this.iconButton(toolbar, 'check-check', '全部标为已读', () => this.markRead(this.plugin.service.articles().map(article => article.id)));
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
    }
    /** 侧栏只接收本地变化通知，无闲置网络轮询。 */
    async onClose(): Promise<void> { this.closed = true; }
    /** 源状态变动时更新列表，阅读弹窗不受影响 */
    render(): void {
        if (!this.list || this.closed)
            return;
        this.list.empty();
        this.status.setText(this.plugin.service.lastError || (this.plugin.service.feeds().length ? '' : '添加 RSS/Atom，或从 OPML 导入订阅。'));
        // 聚合未读与收藏基于当前库的阅读状态。
        const all = this.plugin.service.articles();
        // 聚合按钮不修改具体订阅源身份。
        const aggregate = this.list.createDiv({ cls: 'wr-aggregate' });
        for (const [id, label, icon] of [['all', '全部文章', 'files'], ['unread', '未读', 'circle'], ['read', '已读', 'check-check'], ['starred', '收藏', 'star']]) {
            // 计数只使用当前筛选对应的文章集合。
            const count = ['all', 'read'].includes(id) ? 0 : all.filter(article => id === 'all' || id === 'unread' && !this.plugin.data.reading[article.id]?.read || id === 'starred' && this.plugin.data.reading[article.id]?.starred).length;
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
            const heading = group.createDiv({ cls: 'wr-folder-title', text: folder });
            heading.addEventListener('contextmenu', event => { event.preventDefault(); new Menu().addItem(item => item.setTitle('标记为已读').setIcon('check-check').onClick(() => this.markRead(feeds.flatMap(feed => this.plugin.service.articles(feed.id).map(article => article.id))))).showAtMouseEvent(event); });
            for (const feed of feeds) {
                // 未读筛选即时更新，但弹窗导航队列已冻结。
                const articles = this.plugin.service.articles(feed.id).filter(article => this.filter === 'all' || this.filter === 'unread' && !this.plugin.data.reading[article.id]?.read || this.filter === 'read' && !!this.plugin.data.reading[article.id]?.read || this.filter === 'starred' && this.plugin.data.reading[article.id]?.starred);
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
        button.createSpan({ cls: 'wr-row-meta', text: `${article.publishedAt ? new Date(article.publishedAt).toLocaleDateString() : ''} · ${read ? '已读' : '未读'}${article.state === 'ready' ? '' : ' · 正文获取失败'}` });
        button.addEventListener('click', () => { this.selected = article.id; new ArticleReaderModal(this.plugin, queue, article.id, () => { this.render(); this.list.querySelector<HTMLButtonElement>(`[data-article-id="${article.id}"]`)?.focus(); }).open(); this.render(); });
        button.addEventListener('contextmenu', event => { event.preventDefault(); new Menu().addItem(item => item.setTitle(read ? '标记为未读' : '标记为已读').setIcon('check').onClick(() => this.markRead([article.id], !read))).showAtMouseEvent(event); });
    }
    /** 一次批量保存，分页和筛选不影响目标范围。 */
    private async markRead(ids: string[], read = true): Promise<void> {
        try {
            const count = await this.plugin.readingState.set(ids, read);
            if (!count) { new Notice(read ? '没有未读文章' : '没有已读文章'); return; }
            const token = this.plugin.readingState.undoToken;
            const message = document.createDocumentFragment();
            message.append(`已将 ${count} 篇文章标记为${read ? '已读' : '未读'} `);
            const undo = document.createElement('a');
            undo.textContent = '撤销';
            undo.href = '#';
            undo.addEventListener('click', event => { event.preventDefault(); void this.plugin.readingState.undo(token).then(restored => new Notice(restored ? '已撤销' : '已有新的阅读操作，撤销已失效')).catch(error => new Notice(error.message)); });
            message.append(undo);
            new Notice(message, 8000);
        } catch (error) { new Notice(error instanceof Error ? error.message : '保存阅读状态失败'); }
    }
    /** 源菜单管理普通订阅和公众号各自的配置 */
    private feedMenu(feed: Feed, event: MouseEvent): void {
        // 原生 Menu 自动适配主题及键盘焦点。
        const menu = new Menu().addItem(item => item.setTitle('立即刷新').setIcon('refresh-cw').onClick(() => { void this.plugin.service.refresh(feed).catch(error => new Notice(error.message)); }));
        menu.addItem(item => item.setTitle('标记为已读').setIcon('check-check').onClick(() => this.markRead(this.plugin.service.articles(feed.id).map(article => article.id))));
        if (feed.kind === 'wechat' && feed.missingLocalData) {
            menu.addItem(item => item.setTitle('补充恢复链接').setIcon('link').onClick(() => new SubscribeModal(this.plugin, () => this.refresh(), feed).open()));
            if (subscriptionForFeed(feed)) menu.addItem(item => item.setTitle('恢复本库公众号订阅').setIcon('refresh-cw').onClick(() => this.restoreWeChat()));
        }
        menu.addItem(item => item.setTitle('订阅设置').setIcon('settings').onClick(async () => {
            if (feed.kind === 'wechat') {
                try {
                    const account = (await (await this.plugin.provider()).call<Page<Account>>('/v1/accounts')).items.find(account => account.id === feed.id);
                    if (account)
                        new AccountModal(this.plugin, account, () => this.refresh()).open();
                    else new Notice(missingSubscriptionMessage(feed));
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
                new Notice(this.plugin.data.runtimeMode === 'persistent' ? '本机 RSS 订阅地址已复制' : '本机 RSS 地址已复制，仅在服务运行时可用；需要持续订阅时，请启用常驻模式。');
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
            .addItem(item => item.setTitle('恢复本库公众号订阅').setIcon('refresh-cw').onClick(() => this.restoreWeChat()))
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
    private async restoreWeChat(): Promise<void> {
        try {
            await this.plugin.service.enableWeChat();
            const result = await this.plugin.service.restoreSubscriptions(true);
            if (!result.loggedIn) { new LoginModal(this.plugin).open(); return; }
            if (result.restored) await this.plugin.service.syncWeChat();
            new Notice(`已恢复 ${result.restored} 个公众号订阅${result.needsLink ? `；${result.needsLink} 个旧订阅需右键补充恢复链接` : ''}${result.failed ? `；${result.failed} 个恢复失败，请稍后重试` : ''}`);
        } catch (error) { new Notice(error instanceof Error ? error.message : '恢复订阅失败'); }
    }
    /** 用户触发全部刷新时逐源执行，错误保留到对应源 */
    private async refreshAll(): Promise<void> {
        const feeds = this.plugin.service.feeds().filter(feed => feed.enabled);
        for (const feed of feeds.filter(feed => feed.kind !== 'wechat')) {
            await this.plugin.service.refresh(feed).catch(error => new Notice(`${feed.title}：${error.message}`));
        }
        const wechat = feeds.filter(feed => feed.kind === 'wechat' && !feed.missingLocalData);
        if (wechat.length) await this.plugin.service.syncWeChat(async provider => {
            for (const feed of wechat) await provider.call(`/v1/accounts/${feed.id}/sync`, 'POST', {});
        });
        this.render();
    }
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
