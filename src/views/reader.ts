import { ItemView, Menu, Notice, setIcon, WorkspaceLeaf } from 'obsidian';
import type WeChatReaderPlugin from '../main';
import type { Account, Article, Feed, Page } from '../collector/types';
import { ArticleReaderModal } from './article-modal';
import { publishedTime } from '../collector/date';
import { AddFeedModal, FeedSettingsModal, ImportOpmlModal } from './feed-modals';
import { missingSubscriptionMessage, subscriptionForFeed } from '../collector/subscriptions';
import { AccountModal, LoginModal, SubscribeModal } from './wechat-modals';
/** 保留一期视图 ID，使原有工作区可以平滑恢复 */
export const VIEW_TYPE = 'wechat-reader-view';
/** 侧栏互斥的聚合入口或单个来源范围 */
type ReaderScope = 'all' | 'unread' | 'read' | 'starred' | `feed:${string}`;
/** 每个浏览范围独立保留的滚动锚点 */
interface ListPosition { top: number; anchor?: string; offset: number }
/** 聚合列表每次追加的文章数量 */
const PAGE_SIZE = 50;
/** 聚合文章侧栏，正文使用独立阅读弹窗 */
export class ReaderView extends ItemView {
    /** 来源导航独立于文章结果展开 */
    private sourcesExpanded = false;
    /** 各浏览范围已展示的文章条数 */
    private limits = new Map<string, number>();
    /** 当前聚合筛选条件 */
    private filter: ReaderScope = 'all';
    /** 上次渲染的范围用于切换前保存位置 */
    private renderedScope: ReaderScope = 'all';
    /** 各范围的滚动位置只在当前视图生命周期内保留 */
    private positions = new Map<ReaderScope, ListPosition>();
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
        this.iconButton(toolbar, 'check-check', '全部标为已读', () => this.markAllRead());
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
    /** 用文章锚点保存位置，后台插入和阅读移除不让列表跳回顶部 */
    private rememberPosition(): void {
        // 当前 DOM 仍属于上次渲染的范围。
        const results = this.list.querySelector<HTMLElement>('.wr-results');
        if (!results) return;
        // 记录视口顶部的文章及相对偏移，缺失时回退绝对滚动值。
        const rows = Array.from(results.querySelectorAll<HTMLElement>('[data-article-id]'));
        // 当前视口顶部仍可见的文章锚点。
        const anchor = rows.find(row => row.offsetTop + row.offsetHeight > results.scrollTop);
        this.positions.set(this.renderedScope, { top: results.scrollTop, anchor: anchor?.dataset.articleId, offset: (anchor?.offsetTop || 0) - results.scrollTop });
    }
    /** 仅重建导航和结果的展示内容，不修改正在阅读的固定队列 */
    render(): void {
        if (!this.list || this.closed) return;
        this.rememberPosition();
        // 更新后将焦点还给同一个导航或结果控件。
        const focused = this.contentEl.ownerDocument.activeElement instanceof HTMLElement ? this.contentEl.ownerDocument.activeElement : null;
        // 重绘后需要恢复的控件身份。
        const focusKey = focused && this.list.contains(focused) ? focused.dataset.navKey || focused.dataset.articleId : undefined;
        // 来源导航单独保留滚动位置。
        const sourceScroll = this.list.querySelector('.wr-source-list')?.scrollTop || 0;
        // 当前库中可浏览的全部订阅源。
        const feeds = this.plugin.service.feeds();
        // 文章来源名称与范围校验共用的订阅索引。
        const feedById = new Map(feeds.map(feed => [feed.id, feed]));
        if (this.filter.startsWith('feed:') && !feedById.has(this.filter.slice(5))) this.filter = 'all';
        // 一次读取全集，按真实时间排序，未知时间置后并以身份稳定排序。
        const all = this.plugin.service.articles().map(article => ({ article, time: publishedTime(article.publishedAt) ?? -Infinity }))
            .sort((a, b) => (a.time === b.time ? 0 : a.time > b.time ? -1 : 1) || a.article.id.localeCompare(b.article.id)).map(item => item.article);
        // 每个来源的未读数量不受当前筛选影响。
        const unreadByFeed = new Map<string, number>();
        // 统一阅读服务判定的已读文章身份。
        const readIds = new Set<string>();
        // 当前库收藏的文章身份集合。
        const starredIds = new Set<string>();
        for (const article of all) {
            if (this.plugin.readingState.isRead(article)) readIds.add(article.id);
            else unreadByFeed.set(article.accountId, (unreadByFeed.get(article.accountId) || 0) + 1);
            if (this.plugin.data.reading[article.id]?.starred) starredIds.add(article.id);
        }
        this.list.empty();
        this.status.setText(this.plugin.service.lastError || (feeds.length ? '' : '添加 RSS/Atom，或从 OPML 导入订阅。'));
        // 聚合入口不受来源选择和已加载条数影响。
        const aggregate = this.list.createDiv({ cls: 'wr-aggregate' });
        // 聚合入口的范围、名称和图标配置。
        const entries: Array<[ReaderScope, string, string]> = [['all', '全部文章', 'files'], ['unread', '未读', 'circle'], ['read', '已读', 'check-check'], ['starred', '收藏', 'star']];
        for (const [id, label, icon] of entries) {
            // 入口徽标统计全部匹配文章。
            const count = id === 'unread' ? all.length - readIds.size : id === 'starred' ? starredIds.size : 0;
            // 可点击的导航或文章操作入口。
            const button = this.listButton(aggregate, label, icon, count, this.filter === id);
            button.dataset.navKey = id;
            button.setAttribute('aria-pressed', String(this.filter === id));
            button.addEventListener('click', () => { this.filter = id; this.render(); });
        }
        // 来源只用于选择范围，文章统一出现在下方结果区。
        const sources = this.list.createDiv({ cls: 'wr-sources' });
        // 来源导航的展开和收起入口。
        const toggle = this.listButton(sources, '订阅源', this.sourcesExpanded ? 'chevron-down' : 'chevron-right', 0, false);
        toggle.dataset.navKey = 'sources';
        toggle.setAttribute('aria-expanded', String(this.sourcesExpanded));
        toggle.addEventListener('click', () => { this.sourcesExpanded = !this.sourcesExpanded; this.render(); });
        if (this.sourcesExpanded) {
            // 来源导航独立滚动，不挤占完整文章区域。
            const sourceList = sources.createDiv({ cls: 'wr-source-list' });
            // 按用户分组组织来源导航。
            const folders = new Map<string, Feed[]>();
            for (const feed of feeds) {
                // 未指定分组的来源归入默认分组。
                const folder = feed.folder || '未分组';
                if (!folders.has(folder)) folders.set(folder, []);
                folders.get(folder)!.push(feed);
            }
            for (const [folder, members] of folders) {
                // 同一分组的来源入口容器。
                const group = sourceList.createDiv({ cls: 'wr-folder' });
                // 当前分组或文章范围的可见标题。
                const heading = group.createDiv({ cls: 'wr-folder-title', text: folder });
                heading.addEventListener('contextmenu', event => { event.preventDefault(); new Menu().addItem(item => item.setTitle('标记为已读').setIcon('check-check').onClick(() => this.markRead(all.filter(article => members.some(feed => feed.id === article.accountId)).map(article => article.id)))).showAtMouseEvent(event); });
                for (const feed of members) {
                    // 来源入口对应的独立浏览范围。
                    const scope: ReaderScope = `feed:${feed.id}`;
                    // 可点击的导航或文章操作入口。
                    const button = this.listButton(group, feed.title, 'rss', unreadByFeed.get(feed.id) || 0, this.filter === scope);
                    button.dataset.feedId = feed.id;
                    button.dataset.navKey = scope;
                    button.setAttribute('aria-pressed', String(this.filter === scope));
                    button.title = feed.error || `${feed.kind === 'wechat' ? '微信公众号' : 'RSS/Atom'}${feed.enabled ? '' : ' · 自动刷新已暂停'}`;
                    button.addEventListener('click', () => { this.filter = scope; this.render(); });
                    button.addEventListener('contextmenu', event => { event.preventDefault(); this.feedMenu(feed, event); });
                }
            }
            if (!feeds.length) sourceList.createDiv({ cls: 'wr-empty-feed', text: '暂无订阅源' });
            sourceList.scrollTop = sourceScroll;
        }
        // 来源范围不会继承聚合筛选，停用源的历史仍可阅读。
        const activeFeed = this.filter.startsWith('feed:') ? feedById.get(this.filter.slice(5)) : undefined;
        // 当前范围内的完整结果，用于分页与总量统计。
        const articles = all.filter(article => this.filter === 'all' || this.filter === 'unread' && !readIds.has(article.id) || this.filter === 'read' && readIds.has(article.id) || this.filter === 'starred' && starredIds.has(article.id) || activeFeed?.id === article.accountId);
        // 向用户明确当前文章列表的范围。
        const title = activeFeed?.title || entries.find(([id]) => id === this.filter)?.[1] || '全部文章';
        // 当前分组或文章范围的可见标题。
        const heading = this.list.createEl('h3', { cls: 'wr-results-heading', text: title, attr: { tabindex: '-1' } });
        if (activeFeed?.error) this.list.createDiv({ cls: 'wr-feed-error', text: activeFeed.error });
        // 独立滚动的文章结果容器。
        const results = this.list.createDiv({ cls: 'wr-results', attr: { role: 'region', 'aria-label': `${title}列表` } });
        // 当前范围保留的已加载文章上限。
        const limit = this.limits.get(this.filter) || PAGE_SIZE;
        // 本次实际渲染的文章切片。
        const visible = articles.slice(0, limit);
        // 阅读弹窗只接收当前已展示文章的身份。
        const queue = visible.map(article => article.id);
        for (const article of visible) this.articleRow(results, article, queue, feedById.get(article.accountId)?.title || '未知来源');
        if (!articles.length) results.createDiv({ cls: 'wr-empty-feed', text: this.filter === 'unread' ? '暂无未读文章' : this.filter === 'read' ? '暂无已读文章' : this.filter === 'starred' ? '暂无收藏文章' : '暂无文章' });
        results.createDiv({ cls: 'wr-list-progress', text: `已显示 ${visible.length} / ${articles.length} 篇` });
        if (articles.length > limit) {
            this.textButton(results, '加载更多…', () => { this.limits.set(this.filter, limit + PAGE_SIZE); this.render(); });
            results.querySelector<HTMLButtonElement>('.wr-text-button')!.dataset.navKey = 'more';
        }
        // 原锚点仍存在时保持视觉位置，否则保留原滚动值并交由浏览器限幅。
        const position = this.positions.get(this.filter);
        // 当前视口顶部仍可见的文章锚点。
        const anchor = Array.from(results.querySelectorAll<HTMLElement>('[data-article-id]')).find(row => row.dataset.articleId === position?.anchor);
        results.scrollTop = position ? anchor ? anchor.offsetTop - position.offset : position.top : 0;
        this.renderedScope = this.filter;
        if (focusKey) {
            // 重绘或关闭弹窗后应恢复焦点的控件。
            const target = Array.from(this.list.querySelectorAll<HTMLElement>('[data-nav-key],[data-article-id]')).find(element => element.dataset.navKey === focusKey || element.dataset.articleId === focusKey);
            (target || heading).focus({ preventScroll: true });
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
    private articleRow(parent: HTMLElement, article: Article, queue: string[], source: string): void {
        // 当前库的已读状态决定标题字重和未读点。
        const read = this.plugin.readingState.isRead(article);
        // 无效时间不能参与历史基准或显示为有效日期。
        const published = publishedTime(article.publishedAt);
        // 当前选择保留可见状态，右侧弹窗关闭后可恢复焦点。
        const button = parent.createEl('button', { cls: `wr-article-row ${read ? 'is-read' : 'is-unread'} ${this.selected === article.id ? 'is-selected' : ''}` });
        button.dataset.articleId = article.id;
        button.createSpan({ cls: 'wr-unread-dot', text: read ? '' : '•' });
        button.createSpan({ cls: 'wr-row-title', text: article.title });
        button.createSpan({ cls: 'wr-row-meta', text: `${source} · ${published !== undefined ? new Date(published).toLocaleDateString() : '发布时间未知'} · ${read ? '已读' : '未读'}${article.state === 'evicted' ? ' · 正文已清理' : article.state === 'ready' ? '' : ' · 正文获取失败'}` });
        button.addEventListener('click', () => {
            this.selected = article.id;
            new ArticleReaderModal(this.plugin, queue, article.id, currentId => {
                if (this.closed) return;
                this.selected = currentId || article.id;
                this.render();
                // 文章被筛掉时按原阅读位置寻找附近条目，空列表返回标题。
                // 当前范围内仍可接收焦点的文章。
                const rows = Array.from(this.list.querySelectorAll<HTMLButtonElement>('[data-article-id]'));
                // 按最后阅读位置寻找剩余的相邻文章。
                const index = Math.max(0, queue.indexOf(this.selected));
                // 原文章已移除时优先后续文章，再回退到列表末尾。
                const target = rows.find(row => row.dataset.articleId === this.selected) || rows.find(row => queue.indexOf(row.dataset.articleId || '') >= index) || rows[rows.length - 1];
                (target || this.list.querySelector<HTMLElement>('.wr-results-heading'))?.focus({ preventScroll: true });
            }).open();
            this.render();
        });
        button.addEventListener('contextmenu', event => { event.preventDefault(); new Menu().addItem(item => item.setTitle(read ? '标记为未读' : '标记为已读').setIcon('check').onClick(() => this.markRead([article.id], !read))).showAtMouseEvent(event); });
    }
    /** 一次批量保存，分页和筛选不影响目标范围。 */
    private async markAllRead(): Promise<void> {
        await this.markRead(this.plugin.service.articles().map(article => article.id), true, true);
    }
    /** 根据操作范围持久化已读状态与可撤销的历史基准。 */
    private async markRead(ids: string[], read = true, all = false): Promise<void> {
        try {
            const count = all ? await this.plugin.readingState.markAll(this.plugin.service.articles()) : await this.plugin.readingState.set(ids, read);
            if (!count && !all) { new Notice(read ? '没有未读文章' : '没有已读文章'); return; }
            const token = this.plugin.readingState.undoToken;
            const message = createFragment();
            message.append(all ? `已将 ${count} 篇文章标记为已读，并更新历史文章基准 ` : `已将 ${count} 篇文章标记为${read ? '已读' : '未读'} `);
            const undo = createEl('a');
            undo.textContent = '撤销';
            undo.href = '#';
            undo.addEventListener('click', event => { event.preventDefault(); void this.plugin.readingState.undo(token).then(restored => new Notice(restored ? '已撤销' : '已有新的阅读操作，撤销已失效')).catch(error => new Notice(error instanceof Error ? error.message : '操作失败')); });
            message.append(undo);
            new Notice(message, 8000);
        } catch (error) { new Notice(error instanceof Error ? error.message : '保存阅读状态失败'); }
    }
    /** 源菜单管理普通订阅和公众号各自的配置 */
    private feedMenu(feed: Feed, event: MouseEvent): void {
        // 原生 Menu 自动适配主题及键盘焦点。
        const menu = new Menu().addItem(item => item.setTitle('立即刷新').setIcon('refresh-cw').onClick(() => { void this.plugin.service.refresh(feed).catch(error => new Notice(error instanceof Error ? error.message : '操作失败')); }));
        menu.addItem(item => item.setTitle('标记为已读').setIcon('check-check').onClick(() => this.markRead(this.plugin.service.articles(feed.id).map(article => article.id))));
        if (feed.kind === 'wechat' && !feed.missingLocalData)
            menu.addItem(item => item.setTitle('获取更多历史文章（最多 10 篇）').setIcon('history').onClick(async () => {
                try {
                    new Notice('正在获取一页历史文章，采集进度可在公众号状态中查看');
                    // 返回任务身份后等待实际采集完成，再报告结果。
                    let jobId = '';
                    await this.plugin.service.syncWeChat(async provider => { jobId = (await provider.call<{ jobId: string }>(`/v1/accounts/${feed.id}/history`, 'POST', {})).jobId; });
                    const job = await (await this.plugin.provider()).call<import('../collector/types').Job>(`/v1/jobs/${jobId}`);
                    new Notice(job.error?.message || `历史采集结束：新发现 ${job.discovered} 篇，成功 ${job.succeeded} 篇，失败 ${job.failed} 篇`);
                } catch (error) { new Notice(error instanceof Error ? error.message : '历史文章采集失败'); }
            }));
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
            .addItem(item => item.setTitle('安装公众号引擎').setIcon('download').onClick(() => this.plugin.openEngineInstaller()))
            .addItem(item => item.setTitle('微信读书登录').setIcon('qr-code').onClick(async () => { try {
            if (await this.plugin.engineInstaller.status() === 'missing') { this.plugin.openEngineInstaller(); return; }
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
            await this.plugin.service.refresh(feed).catch(error => new Notice(`${feed.title}：${error instanceof Error ? error.message : '操作失败'}`));
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
            void result.catch(error => new Notice(error instanceof Error ? error.message : '操作失败'));
    }
    catch (error) {
        new Notice(error instanceof Error ? error.message : '操作失败');
    } }); }
    /** 普通文本操作按钮保持侧栏紧凑 */
    private textButton(parent: HTMLElement, label: string, action: () => unknown): void { const button = parent.createEl('button', { text: label, cls: 'wr-text-button' }); button.addEventListener('click', () => { const result = action(); if (result instanceof Promise)
        void result.catch(error => new Notice(error instanceof Error ? error.message : '操作失败')); }); }
}
