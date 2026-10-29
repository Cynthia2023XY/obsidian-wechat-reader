import { requestUrl } from 'obsidian';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Account, Article, Asset, CollectorProvider, Feed, Page, ReaderData, Job, ScheduleSnapshot, Resolution } from '../collector/types';
import { missingSubscriptionMessage, subscriptionForFeed, subscriptionFromAccount } from '../collector/subscriptions';
import { parseSubscriptionConfiguration, planSubscriptionImport, type SubscriptionImportPlan } from './configuration';
import { digest, feedUrl, parseFeed } from './parser';
/** 统一普通 RSS 与公众号的数据入口，RSS 不依赖采集附属程序 */
export class FeedService {
    /** 当前笔记库各订阅的正文缓存 */
    private cache = new Map<string, Article[]>();
    /** 同一订阅的重复刷新共享正在进行的请求 */
    private pending = new Map<string, Promise<void>>();
    /** 普通 RSS 的串行自动刷新循环 */
    private timer?: number;
    /** 公众号资源适配器只在需要时连接本机程序 */
    private collector?: CollectorProvider;
    /** 侧栏在数据变化时更新，不重建正在阅读的弹窗 */
    onChange: () => void = () => { };
    /** 保存实例生命周期，卸载后不再触发刷新 */
    private closed = false;
    /** 防止慢请求跨过计时器周期后重入调度 */
    private ticking = false;
    private wechatPending?: Promise<void>;
    private restorationTried = new Set<string>();
    private restorePending?: Promise<{ restored: number; needsLink: number; failed: number; loggedIn: boolean }>;
    private snapshot?: ScheduleSnapshot;
    private watcher?: FSWatcher;
    /** 快照变化合并为一次界面刷新，卸载时统一取消 */
    private watchTimer?: number;
    private wakeRetryAt = 0;
    private wakeFailures = 0;
    lastError = '';
    private contentSaving = new Map<string, Promise<void>>();
    /** 串行磁盘写入避免旧快照覆盖新的图片状态 */
    private saving: Promise<void> = Promise.resolve();
    /** 绑定当前库设置、私有缓存目录与按需连接函数 */
    constructor(private data: ReaderData, private directory: string, private save: () => Promise<void>, private connect: () => Promise<CollectorProvider>, private runtime?: { root: string; session: <T>(action: () => Promise<T>) => Promise<T> }) { }
    /** 初始化各源缓存，普通 RSS 模式无需本机采集健康检查 */
    async load(): Promise<void> {
        // 定向恢复文件只在一次修复中使用，避免旧进程在重载前再次保存空列表。
        const recoveryPath = join(this.directory, 'cache/wechat-subscriptions-recovery.json');
        let recovery: Feed[] = [];
        try { const value: unknown = JSON.parse(await readFile(recoveryPath, 'utf8'));  if (Array.isArray(value)) recovery = value.filter((feed: unknown): feed is Feed => !!feed && typeof feed === 'object' && 'kind' in feed && feed.kind === 'wechat' && 'id' in feed && typeof feed.id === 'string' && /^account_[a-f0-9]{32}$/.test(feed.id) && 'title' in feed && typeof feed.title === 'string'); } catch { /* 正常安装无恢复文件。 */ }
        if (recovery.length) {
            const plan = planSubscriptionImport(this.data, recovery);
            this.data.wechatFeeds = plan.wechatFeeds;
            await this.save();
            await rename(recoveryPath, `${recoveryPath}.applied`);
        }
        for (const feed of this.feeds()) {
            try {
                // 读取本插件写入的文章缓存，不让未声明类型穿透服务边界。
                const cached = JSON.parse(await readFile(join(this.directory, 'cache', `${feed.id}.json`), 'utf8')) as { articles?: Article[] };
                this.cache.set(feed.id, Array.isArray(cached.articles) ? cached.articles : []);
            }
            catch {
                this.cache.set(feed.id, []);
            }
        }
        let enriched = false;
        for (const feed of this.data.wechatFeeds) {
            const subscription = subscriptionForFeed(feed, this.cache.get(feed.id) || []);
            if (JSON.stringify(feed.wechat) !== JSON.stringify(subscription)) { feed.wechat = subscription; enriched = true; }
        }
        if (enriched) await this.save();
        await this.readSnapshot();
        this.watchSnapshot();
        void this.tick();
    }
    /** 当前统一订阅列表，分组与显示名称不改变主键 */
    feeds(): Feed[] { return [...this.data.wechatFeeds, ...this.data.feeds]; }
    /** 获取所有已加载条目，以发布时间稳定排序 */
    articles(feedId?: string): Article[] { return [...this.cache.values()].flat().filter(article => !feedId || article.accountId === feedId).sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || a.id.localeCompare(b.id)); }
    /** 获取正文；RSS 使用当前库缓存，公众号正文从共享服务读取 */
    async article(id: string): Promise<Article> {
        // 标题列表并不意味着正文一定成功。
        const item = this.articles().find(article => article.id === id);
        if (!item)
            throw new Error('文章不存在，请刷新订阅');
        if (id.startsWith('rss_'))
            return item;
        const path = join(this.directory, 'cache', 'content', `${digest(id)}.json`);
        let previous: Article | undefined;
        try {
            const cached = JSON.parse(await readFile(path, 'utf8')) as Article;
            if (cached.id === id && cached.html && cached.state === 'ready') previous = cached;
            if (cached.id === id && cached.contentVersion === item.contentVersion && cached.html && cached.state === 'ready') return this.readable(cached);
        } catch { /* 首次补齐正文缓存。 */ }
        // 共享正文被清理后，仍优先使用当前库已缓存的正文。
        if (item.state === 'evicted' && previous) return this.readable(previous);
        if (item.state !== 'ready') return item;
        let article: Article;
        try { article = await (await this.provider()).call<Article>(`/v1/articles/${encodeURIComponent(id)}`); }
        catch (error) { if (previous) return this.readable(previous); throw error; }
        await this.saveContent(article);
        return this.readable(article);
    }
    /** 阅读中的资源绑定正文版本，后台更新不能把新图片混入旧正文。 */
    private readable(article: Article): Article {
        return { ...article, assets: article.assets.map(asset => ({ ...asset, contentVersion: article.contentVersion })) };
    }
    /** 提供兼容归档所需的资源读取能力，界面无需拼接服务路径 */
    async provider(): Promise<CollectorProvider> {
        this.collector = await this.connect();
        return this.collector;
    }
    /** 阅读和归档资源的统一适配器，普通 RSS 不先连接公众号 */
    contentProvider(): CollectorProvider {
        return { health: async () => { throw new Error('该能力仅用于公众号'); }, call: async <T>(path: string, method?: string, body?: unknown) => (await this.provider()).call<T>(path, method, body),
            asset: (id, asset) => this.asset(id, asset), rss: async (id) => (await this.provider()).rss(id) };
    }
    /** 添加源时先验证并读取，失败不创建无法使用的空源 */
    async add(url: string, title = '', folder = 'RSS 订阅'): Promise<Feed> {
        // 地址标准化保留鉴权和定位查询参数。
        const canonical = feedUrl(url);
        // 重复添加返回原对象，不以名称或文件夹作为身份。
        const existing = this.data.feeds.find(feed => feed.url === canonical);
        if (existing)
            return existing;
        // 新源默认每小时检查，用户可在设置中调整。
        const feed: Feed = { id: `feed_${digest(canonical)}`, kind: 'rss', title: title || new URL(canonical).hostname, url: canonical, folder, enabled: true, intervalMinutes: 60 };
        // 首次获取成功后才保存订阅配置。
        const response = await requestUrl({ url: canonical, throw: false });
        if (response.status !== 200)
            throw new Error(`读取订阅失败（HTTP ${response.status}）`);
        // RSS/Atom 类型由 XML 内容确认。
        const parsed = parseFeed(response.text, feed);
        feed.kind = parsed.kind;
        feed.title = title || parsed.title;
        feed.checkedAt = Date.now();
        feed.etag = this.header(response.headers, 'etag');
        feed.modified = this.header(response.headers, 'last-modified');
        this.data.feeds.push(feed);
        this.cache.set(feed.id, parsed.articles);
        await this.saveCache(feed.id);
        await this.save();
        this.onChange();
        this.schedule();
        return feed;
    }
    /** 配置导入只合并定义，不下载文章或改动阅读记录。 */
    async importConfiguration(text: string): Promise<SubscriptionImportPlan> {
        const incoming = parseSubscriptionConfiguration(text);
        const plan = planSubscriptionImport(this.data, incoming);
        if (!plan.added && !plan.updated) return plan;
        const previousFeeds = this.data.feeds, previousWechat = this.data.wechatFeeds;
        this.data.feeds = plan.feeds; this.data.wechatFeeds = plan.wechatFeeds;
        try { await this.save(); }
        catch (error) { this.data.feeds = previousFeeds; this.data.wechatFeeds = previousWechat; throw error; }
        this.onChange(); this.schedule();
        return plan;
    }
    /** 更新名称、分组和自动刷新设置，保持历史关联 */
    async update(feed: Feed, changes: Partial<Feed>): Promise<void> {
        if (feed.kind === 'wechat')
            throw new Error('请使用公众号设置修改采集配置');
        Object.assign(feed, { title: changes.title ?? feed.title, folder: changes.folder ?? feed.folder, enabled: changes.enabled ?? feed.enabled, intervalMinutes: changes.intervalMinutes ?? feed.intervalMinutes });
        await this.save();
        this.onChange();
        this.schedule();
    }
    /** 取消订阅只停止刷新，保留缓存和本库阅读状态 */
    async unsubscribe(feed: Feed): Promise<void> { await this.update(feed, { enabled: false }); }
    /** 普通订阅刷新共享同一任务，304 和错误均不清空历史 */
    async refresh(feed: Feed): Promise<void> {
        if (feed.kind === 'wechat') {
            if (feed.missingLocalData) {
                if (!subscriptionForFeed(feed)) throw new Error(missingSubscriptionMessage(feed));
                const result = await this.restoreSubscriptions(true);
                if (!result.loggedIn) throw new Error('请先扫码登录，登录后将自动恢复本库公众号订阅');
                if (feed.missingLocalData && this.data.wechatFeeds.find(item => item.id === feed.id)?.missingLocalData) throw new Error(this.data.wechatFeeds.find(item => item.id === feed.id)?.error || '恢复订阅失败，请稍后重试');
            }
            await this.syncWeChat(async provider => { await provider.call(`/v1/accounts/${feed.id}/sync`, 'POST', {}); });
            return;
        }
        if (this.pending.has(feed.id))
            return this.pending.get(feed.id)!;
        // 同一源不会因工具栏和定时器同时点击而并发写入。
        const task = this.refreshRss(feed).finally(() => this.pending.delete(feed.id));
        this.pending.set(feed.id, task);
        return task;
    }
    /** 从共享索引载入公众号条目，按游标读取而非只显示首屏 */
    async refreshWeChat(): Promise<void> {
        if (!this.data.wechatEnabled)
            return;
        // 按需连接，普通 RSS 功能不受其失败影响。
        const provider = await this.provider();
        // 订阅设置与任务状态来自共享数据库。
        const accounts = (await provider.call<Page<Account>>('/v1/accounts')).items;

        // 正文列表按需分页载入，避免历史条目在刷新时丢失。
        let cursor: string | null = null;
        // 只更新公众号缓存，不覆盖普通 RSS。
        const grouped = new Map<string, Article[]>();
        do {
            // 游标只由服务返回。
            const page: Page<Article> = await provider.call<Page<Article>>(`/v1/articles?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            for (const article of page.items) {
                if (!grouped.has(article.accountId))
                    grouped.set(article.accountId, []);
                grouped.get(article.accountId)!.push(article);
            }
            cursor = page.nextCursor;
        } while (cursor && !this.closed);
        await this.mergeWeChat(accounts, [...grouped.values()].flat());
        await this.readSnapshot();
        await this.save();
        this.onChange();
    }
    /** 启用公众号后才启动专用运行时，普通订阅无需扫码 */
    async enableWeChat(): Promise<void> { this.data.wechatEnabled = true; this.wakeFailures = 0; this.wakeRetryAt = 0; await this.save(); await this.refreshWeChat(); this.watchSnapshot(); this.schedule(); }
    /** UI 停用时停止自动刷新，不删除任何文章 */
    dispose(): void { this.closed = true; if (this.timer)
        window.clearTimeout(this.timer); if (this.watchTimer) window.clearTimeout(this.watchTimer); this.watcher?.close(); }
    /** HTTP 响应头大小写不敏感 */
    private header(headers: Record<string, string>, name: string): string | undefined { return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]; }
    /** 独立刷新普通源，采用增量合并，保留已缓存的历史 */
    private async refreshRss(feed: Feed): Promise<void> {
        try {
            // 条件请求减少重复下载，不暴露订阅地址到日志。
            const headers: Record<string, string> = {};
            if (feed.etag)
                headers['If-None-Match'] = feed.etag;
            if (feed.modified)
                headers['If-Modified-Since'] = feed.modified;
            // requestUrl 由 Obsidian 处理跨域网络能力。
            const response = await requestUrl({ url: feed.url, headers, throw: false });
            if (response.status !== 304) {
                if (response.status !== 200)
                    throw new Error(`读取订阅失败（HTTP ${response.status}）`);
                // 新数据按稳定 ID 合并，旧条目缺席不代表删除。
                const parsed = parseFeed(response.text, feed);
                // 资源缓存与已读等状态分开，刷新正文不清除阅读状态。
                const merged = new Map((this.cache.get(feed.id) || []).map(article => [article.id, article]));
                for (const article of parsed.articles) {
                    // 内容未变时保留已验证的图片 MIME 和下载状态。
                    const previous = merged.get(article.id);
                    if (previous?.contentVersion === article.contentVersion)
                        article.assets = previous.assets;
                    merged.set(article.id, article);
                }
                this.cache.set(feed.id, [...merged.values()]);
                feed.kind = parsed.kind;
                feed.etag = this.header(response.headers, 'etag');
                feed.modified = this.header(response.headers, 'last-modified');
                await this.saveCache(feed.id);
            }
            feed.checkedAt = Date.now();
            feed.error = undefined;
            feed.retryAt = undefined;
        }
        catch (error) {
            feed.error = error instanceof Error ? error.message : '刷新失败';
            feed.retryAt = Date.now() + 300000;
            throw error;
        }
        finally {
            await this.save();
            this.onChange();
            this.schedule();
        }
    }
    /** 到期时才连接公众号服务，整个批次持有会话。 */
    async syncWeChat(enqueue: (provider: CollectorProvider) => Promise<void> = async provider => { await provider.call('/v1/sync-due', 'POST', {}); }): Promise<void> {
        // 各来源入队操作不能因另一个批次在等待而被丢弃。
        const provider = await this.provider();
        await enqueue(provider);
        if (!this.wechatPending) {
            const work = async () => {
                let lastProgress = '', progressAt = Date.now();
                while (!this.closed) {
                    const state = await provider.call<{ activeJobs: Job[] }>('/v1/runtime/state');
                    if (!state.activeJobs.length) break;
                    const progress = JSON.stringify(state.activeJobs);
                    if (progress !== lastProgress) { lastProgress = progress; progressAt = Date.now(); }
                    if (Date.now() - progressAt > 600000) throw new Error('采集任务长时间没有进展，请重新连接后重试');
                    await this.refreshWeChat();
                    await new Promise(resolve => window.setTimeout(resolve, 2000));
                }
                if (!this.closed) await this.refreshWeChat();
            };
            this.wechatPending = (this.runtime ? this.runtime.session(work) : work()).finally(() => { this.wechatPending = undefined; this.schedule(); });
        }
        await this.wechatPending;
    }
    async retryArticle(id: string): Promise<void> {
        const article = this.articles().find(item => item.id === id);
        if (!article) throw new Error('文章不存在');
        if (id.startsWith('rss_')) {
            const feed = this.feeds().find(feed => feed.id === article.accountId);
            if (feed) await this.refresh(feed);
        } else {
            await this.syncWeChat(async provider => { await provider.call(`/v1/articles/${encodeURIComponent(id)}/retry`, 'POST', {}); });
        }
    }
    /** 确认订阅后立即保存可迁移定义，不依赖后续任务或快照成功。 */
    async subscribeWeChat(resolution: Resolution, articleUrl: string, displayName: string): Promise<void> {
        const provider = await this.provider();
        const result = await provider.call<{ account: Account }>('/v1/accounts', 'POST', { resolutionId: resolution.resolutionId, displayName });
        const feed = this.feedFromAccount(result.account, articleUrl);
        if (!feed.wechat) throw new Error('公众号恢复信息不完整，请重新解析文章链接');
        const feeds = new Map(this.data.wechatFeeds.map(item => [item.id, item]));
        feeds.set(feed.id, feed); this.data.wechatFeeds = [...feeds.values()];
        await this.save(); this.onChange();
        try { await this.refreshWeChat(); }
        catch { this.lastError = '订阅已保存，列表暂未更新，请稍后刷新'; this.onChange(); }
        this.schedule();
    }
    /** 新电脑只重建缺失账户；已有共享账户不受本库配置反向覆盖。 */
    async restoreSubscriptions(manual = false): Promise<{ restored: number; needsLink: number; failed: number; loggedIn: boolean }> {
        if (this.restorePending) return this.restorePending;
        if (manual) this.restorationTried.clear();
        const work = async () => {
            const provider = await this.provider();
            const auth = await provider.call<{ loggedIn: boolean }>('/v1/auth/status');
            const result = { restored: 0, needsLink: 0, failed: 0, loggedIn: auth.loggedIn };
            if (!auth.loggedIn) return result;
            await this.refreshWeChat();
            for (const feed of this.data.wechatFeeds.filter(item => item.missingLocalData)) {
                const subscription = subscriptionForFeed(feed, this.cache.get(feed.id) || []);
                if (!subscription) { result.needsLink++; continue; }
                const key = this.restorationKey(feed);
                if (this.restorationTried.has(key)) continue;
                this.restorationTried.add(key);
                try {
                    const restored = await provider.call<{ account: Account }>('/v1/accounts/restore', 'POST', { id: feed.id, displayName: feed.title, subscription });
                    const updated = this.feedFromAccount(restored.account, subscription.articleUrl);
                    const index = this.data.wechatFeeds.findIndex(item => item.id === feed.id);
                    if (index >= 0) this.data.wechatFeeds[index] = updated;
                    result.restored++;
                } catch (error) {
                    const current = this.data.wechatFeeds.find(item => item.id === feed.id);
                    if (current) current.error = error instanceof Error ? error.message : '恢复订阅失败，请稍后重试';
                    result.failed++;
                    if ((error as { code?: string }).code === 'AUTH_REQUIRED') { result.loggedIn = false; break; }
                }
            }
            await this.save(); this.onChange();
            return result;
        };
        this.restorePending = (this.runtime ? this.runtime.session(work) : work()).finally(() => { this.restorePending = undefined; this.schedule(); });
        return this.restorePending;
    }
    private restorationKey(feed: Feed): string { return `${feed.id}:${JSON.stringify(subscriptionForFeed(feed))}`; }
    private canRestore(): boolean {
        return !!this.snapshot?.loggedIn && this.data.wechatFeeds.some(feed => feed.missingLocalData && subscriptionForFeed(feed) && !this.restorationTried.has(this.restorationKey(feed)));
    }
    private feedFromAccount(account: Account, articleUrl?: string): Feed {
        const previous = this.data.wechatFeeds.find(feed => feed.id === account.id);
        const seed = articleUrl || previous?.wechat?.articleUrl || this.cache.get(account.id)?.find(article => article.url)?.url;
        const subscription = subscriptionFromAccount(account, seed) || subscriptionForFeed(previous || { id: account.id } as Feed);
        return { id: account.id, kind: 'wechat', title: account.displayName, url: 'https://mp.weixin.qq.com/', folder: previous?.folder || '公众号', enabled: account.subscribed && account.autoSync, intervalMinutes: account.intervalMin, nextSyncAt: account.nextSyncAt, blocked: !!account.blocked, error: account.lastJob?.error?.message || account.blocked?.message, wechat: subscription };
    }
    /** 共享服务只写快照，所有笔记库从快照恢复列表与计划。 */
    private async readSnapshot(): Promise<void> {
        if (!this.runtime || !this.data.wechatEnabled || this.closed) return;
        try {
            const snapshot = JSON.parse(await readFile(join(this.runtime.root, 'runtime/schedule.json'), 'utf8')) as ScheduleSnapshot;
            if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.accounts) || !Array.isArray(snapshot.articles) || !Array.isArray(snapshot.activeAccountIds)) return;
            const changed = this.snapshot?.revision !== snapshot.revision;
            this.snapshot = snapshot;
            if (!changed) return;
            await this.mergeWeChat(snapshot.accounts, snapshot.articles);
            await this.save();
            this.onChange();
        } catch { /* 快照不存在时由一次初始化连接生成；原缓存保持可用。 */ }
    }
    /** 共享数据缺席不代表取消订阅；保留本库入口与历史缓存。 */
    private async mergeWeChat(accounts: Account[], articles: Article[]): Promise<void> {
        const present = new Set(accounts.map(account => account.id));
        const feeds = new Map(this.data.wechatFeeds.map(feed => [feed.id, present.has(feed.id) ? feed : {
            ...feed, wechat: subscriptionForFeed(feed, this.cache.get(feed.id) || []), missingLocalData: true,
            error: this.restorationTried.has(this.restorationKey(feed)) ? feed.error : missingSubscriptionMessage({ ...feed, wechat: subscriptionForFeed(feed, this.cache.get(feed.id) || []) }),
        }]));
        for (const account of accounts) {
            feeds.set(account.id, this.feedFromAccount(account, articles.find(article => article.accountId === account.id)?.url));
            const merged = new Map((this.cache.get(account.id) || []).map(article => [article.id, article]));
            for (const article of articles) if (article.accountId === account.id) merged.set(article.id, article);
            this.cache.set(account.id, [...merged.values()]);
            await this.saveCache(account.id);
        }
        this.data.wechatFeeds = [...feeds.values()];
    }
    private watchSnapshot(): void {
        if (!this.runtime || this.watcher || !this.data.wechatEnabled || this.closed) return;
        try {
            this.watcher = watch(join(this.runtime.root, 'runtime'), (_event, filename) => {
                if (filename && filename !== 'schedule.json') return;
                if (this.watchTimer) window.clearTimeout(this.watchTimer);
                this.watchTimer = window.setTimeout(() => { void this.readSnapshot().then(() => this.schedule()); }, 200);
            });
            this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
        } catch { /* 首次连接后重试监听新建目录。 */ }
    }
    /** 单一轻量计时器等待最早到期时间，恢复时按真实时间重新核对。 */
    schedule(): void {
        if (this.timer) window.clearTimeout(this.timer);
        if (this.closed) return;
        const now = Date.now();
        const times = this.data.feeds.filter(feed => feed.enabled).map(feed => feed.retryAt || ((feed.checkedAt || 0) + feed.intervalMinutes * 60000));
        if (this.data.wechatEnabled && !this.wechatPending && !this.restorePending && this.wakeFailures < 3) {
            if (this.canRestore()) times.push(Math.max(now, this.wakeRetryAt));
            if (!this.snapshot) times.push(Math.max(now, this.wakeRetryAt));
            else if (this.snapshot.loggedIn) for (const account of this.snapshot.accounts) {
                if (!account.subscribed || !account.autoSync || account.blocked) continue;
                const busyUntil = this.snapshot.activeAccountIds.includes(account.id) ? this.snapshot.createdAt + 90000 : 0;
                times.push(Math.max(account.nextSyncAt * 1000, busyUntil, this.wakeRetryAt));
            }
        }
        if (times.length) this.timer = window.setTimeout(() => { void this.tick(); }, Math.min(2147483647, Math.max(1000, Math.min(...times) - now)));
    }
    /** 恢复前台或联网时按实际到期时间核对，不补跑错过的每个周期。 */
    async resume(): Promise<void> { await this.tick(); }
    private async tick(): Promise<void> {
        if (this.closed || this.ticking) return;
        this.ticking = true;
        try {
            await this.readSnapshot();
            for (const feed of this.data.feeds) {
                if (this.closed) return;
                if (feed.enabled && (feed.retryAt || ((feed.checkedAt || 0) + feed.intervalMinutes * 60000)) <= Date.now())
                    await this.refresh(feed).catch(() => undefined);
            }
            const now = Date.now();
            const due = !this.snapshot || this.snapshot.loggedIn && this.snapshot.accounts.some(account => account.subscribed && account.autoSync && !account.blocked && account.nextSyncAt * 1000 <= now && (!this.snapshot!.activeAccountIds.includes(account.id) || this.snapshot!.createdAt + 90000 <= now));
            if (!this.closed && this.data.wechatEnabled && !this.wechatPending && (due || this.canRestore()) && now >= this.wakeRetryAt && this.wakeFailures < 3) {
                try {
                    if (this.canRestore()) await this.restoreSubscriptions();
                    await this.syncWeChat();
                    if (this.runtime && !this.snapshot) throw new Error('无法读取公众号本地快照，请检查权限或重新安装完整包');
                    this.lastError = '';
                    this.wakeFailures = 0; this.wakeRetryAt = 0;
                    this.watchSnapshot();
                } catch (error) {
                    this.lastError = error instanceof Error ? error.message : '公众号自动同步失败';
                    this.wakeFailures++;
                    this.wakeRetryAt = Date.now() + 300000 * this.wakeFailures;
                    for (const feed of this.data.wechatFeeds) feed.error = error instanceof Error ? error.message : '公众号自动同步失败';
                    this.onChange();
                }
            }
        } finally { this.ticking = false; this.schedule(); }
    }
    private async saveContent(article: Article): Promise<void> {
        const id = digest(article.id);
        const task = (this.contentSaving.get(id) || Promise.resolve()).catch(() => undefined).then(async () => {
            const folder = join(this.directory, 'cache/content');
            await mkdir(folder, { recursive: true });
            await writeFile(join(folder, `${id}.tmp`), JSON.stringify(article));
            await rename(join(folder, `${id}.tmp`), join(folder, `${id}.json`));
        });
        this.contentSaving.set(id, task);
        try { await task; } finally { if (this.contentSaving.get(id) === task) this.contentSaving.delete(id); }
    }
    /** 先写临时文件再替换，避免中断产生半份订阅缓存 */
    private async saveCache(id: string): Promise<void> {
        // 当前快照串行落盘，不与图片缓存更新互相覆盖。
        const snapshot = JSON.stringify({ schemaVersion: 1, feedId: id, articles: this.cache.get(id) || [] });
        this.saving = this.saving.catch(() => undefined).then(async () => { await mkdir(join(this.directory, 'cache'), { recursive: true }); await writeFile(join(this.directory, 'cache', `${id}.tmp`), snapshot); await rename(join(this.directory, 'cache', `${id}.tmp`), join(this.directory, 'cache', `${id}.json`)); });
        await this.saving;
    }
    private async writeAsset(path: string, bytes: Buffer): Promise<void> {
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, bytes);
        await rename(temporary, path);
    }
    /** 图片只在阅读或归档时下载，成功后在本库复用 */
    private async asset(id: string, asset: Asset): Promise<ArrayBuffer> {
        if (!id.startsWith('rss_')) {
            const article = this.articles().find(item => item.id === id);
            let owned = article?.assets.find(item => item.id === asset.id);
            if (!article) throw new Error('图片不属于当前文章');
            // 已清理共享正文时，只能从本库已验证正文中确认旧版图片归属。
            if (!owned && article.state === 'evicted') {
                try {
                    const cached = JSON.parse(await readFile(join(this.directory, 'cache/content', `${digest(id)}.json`), 'utf8')) as Article;
                    if (cached.id === id && cached.contentVersion === asset.contentVersion) owned = cached.assets.find(item => item.id === asset.id);
                } catch { /* 本库没有可用的旧正文缓存。 */ }
            }
            if (!owned) throw new Error('图片不属于当前文章');
            const version = asset.contentVersion || article.contentVersion;
            const path = join(this.directory, 'cache/assets', digest(`${id}:${version}:${asset.id}`));
            try { return Uint8Array.from(await readFile(path)).buffer; } catch { /* 按需补读。 */ }
            if (version !== article.contentVersion) throw new Error('正文已有更新，请重新打开文章以读取新图片');
            Object.assign(asset, { mime: owned.mime, state: owned.state });
            const bytes = await (await this.provider()).asset(id, owned);
            await mkdir(join(this.directory, 'cache/assets'), { recursive: true });
            await this.writeAsset(path, Buffer.from(bytes));
            return bytes;
        }
        // 资源必须由当前文章实际声明，不能任意读取本机路径。
        const article = this.articles().find(item => item.id === id);
        // 下载地址只取自受控缓存，不信任调用者提供的同名资源地址。
        const owned = article?.assets.find(item => item.id === asset.id);
        if (!article || !owned?.sourceUrl)
            throw new Error('图片不属于当前文章');
        // 每个文章资源使用独立私有缓存路径。
        const directory = join(this.directory, 'cache', 'assets', id);
        // MIME 信息与正文缓存一同保存。
        const path = join(directory, asset.id);
        try {
            // 已缓存图片的原始二进制内容。
            const bytes = await readFile(path);
            Object.assign(asset, { mime: owned.mime, state: owned.state });
            return Uint8Array.from(bytes).buffer;
        }
        catch { /* 首次打开时按需下载。 */ }
        // 图片地址仅支持显式的网络协议。
        const response = await requestUrl({ url: feedUrl(owned.sourceUrl), throw: false });
        // 禁止把 HTML 或 SVG 伪装为可显示图片。
        const mime = this.header(response.headers, 'content-type')?.split(';')[0].trim();
        if (response.status !== 200 || !mime || !['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'].includes(mime))
            throw new Error('图片格式不可用');
        owned.mime = mime;
        owned.state = 'ready';
        Object.assign(asset, { mime, state: 'ready' });
        await mkdir(directory, { recursive: true });
        await this.writeAsset(path, Buffer.from(response.arrayBuffer));
        await this.saveCache(article.accountId);
        return response.arrayBuffer;
    }
}
