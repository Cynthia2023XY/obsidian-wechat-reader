import { requestUrl } from 'obsidian';
import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Account, Article, Asset, CollectorProvider, Feed, Page, ReaderData } from '../collector/types';
import { digest, feedUrl, parseFeed } from './parser';
/** 统一普通 RSS 与公众号的数据入口，RSS 不依赖采集附属程序 */
export class FeedService {
    /** 当前笔记库各订阅的正文缓存 */
    private cache = new Map<string, Article[]>();
    /** 同一订阅的重复刷新共享正在进行的请求 */
    private pending = new Map<string, Promise<void>>();
    /** 普通 RSS 的串行自动刷新循环 */
    private timer?: ReturnType<typeof setInterval>;
    /** 公众号资源适配器只在需要时连接本机程序 */
    private collector?: CollectorProvider;
    /** 侧栏在数据变化时更新，不重建正在阅读的弹窗 */
    onChange: () => void = () => { };
    /** 保存实例生命周期，卸载后不再触发刷新 */
    private closed = false;
    /** 防止慢请求跨过计时器周期后重入调度 */
    private ticking = false;
    /** 串行磁盘写入避免旧快照覆盖新的图片状态 */
    private saving: Promise<void> = Promise.resolve();
    /** 绑定当前库设置、私有缓存目录与按需连接函数 */
    constructor(private data: ReaderData, private directory: string, private save: () => Promise<void>, private connect: () => Promise<CollectorProvider>) { }
    /** 初始化各源缓存，普通 RSS 模式无需本机采集健康检查 */
    async load(): Promise<void> {
        for (const feed of this.data.feeds) {
            try {
                this.cache.set(feed.id, JSON.parse(await readFile(join(this.directory, 'cache', `${feed.id}.json`), 'utf8')).articles || []);
            }
            catch {
                this.cache.set(feed.id, []);
            }
        }
        if (this.data.wechatEnabled)
            await this.refreshWeChat().catch(() => undefined);
        this.timer = setInterval(() => { void this.tick(); }, 15000);
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
        return (await this.provider()).call<Article>(`/v1/articles/${encodeURIComponent(id)}`);
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
        return feed;
    }
    /** 更新名称、分组和自动刷新设置，保持历史关联 */
    async update(feed: Feed, changes: Partial<Feed>): Promise<void> {
        if (feed.kind === 'wechat')
            throw new Error('请使用公众号设置修改采集配置');
        Object.assign(feed, { title: changes.title ?? feed.title, folder: changes.folder ?? feed.folder, enabled: changes.enabled ?? feed.enabled, intervalMinutes: changes.intervalMinutes ?? feed.intervalMinutes });
        await this.save();
        this.onChange();
    }
    /** 取消订阅只停止刷新，保留缓存和本库阅读状态 */
    async unsubscribe(feed: Feed): Promise<void> { await this.update(feed, { enabled: false }); }
    /** 普通订阅刷新共享同一任务，304 和错误均不清空历史 */
    async refresh(feed: Feed): Promise<void> {
        if (feed.kind === 'wechat') {
            await (await this.provider()).call(`/v1/accounts/${feed.id}/sync`, 'POST', {});
            await this.refreshWeChat();
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
        this.data.wechatFeeds = accounts.map(account => ({ id: account.id, kind: 'wechat', title: account.displayName, url: 'https://mp.weixin.qq.com/', folder: '公众号', enabled: account.subscribed && account.autoSync, intervalMinutes: account.intervalMin, error: account.lastJob?.error?.message || account.blocked?.message }));
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
        for (const feed of this.data.wechatFeeds)
            this.cache.set(feed.id, grouped.get(feed.id) || []);
        await this.save();
        this.onChange();
    }
    /** 启用公众号后才启动专用运行时，普通订阅无需扫码 */
    async enableWeChat(): Promise<void> { this.data.wechatEnabled = true; await this.save(); await this.refreshWeChat(); }
    /** UI 停用时停止自动刷新，不删除任何文章 */
    dispose(): void { this.closed = true; if (this.timer)
        clearInterval(this.timer); }
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
        }
    }
    /** 全部普通源经一个串行调度循环，失效源有有限退避 */
    private async tick(): Promise<void> {
        if (this.closed || this.ticking)
            return;
        this.ticking = true;
        try {
            for (const feed of this.data.feeds) {
                if (this.closed)
                    return;
                if (feed.enabled && (feed.retryAt || ((feed.checkedAt || 0) + feed.intervalMinutes * 60000)) <= Date.now())
                    await this.refresh(feed).catch(() => undefined);
            }
        }
        finally {
            this.ticking = false;
        }
    }
    /** 先写临时文件再替换，避免中断产生半份订阅缓存 */
    private async saveCache(id: string): Promise<void> {
        // 当前快照串行落盘，不与图片缓存更新互相覆盖。
        const snapshot = JSON.stringify({ schemaVersion: 1, feedId: id, articles: this.cache.get(id) || [] });
        this.saving = this.saving.catch(() => undefined).then(async () => { await mkdir(join(this.directory, 'cache'), { recursive: true }); await writeFile(join(this.directory, 'cache', `${id}.tmp`), snapshot); await rename(join(this.directory, 'cache', `${id}.tmp`), join(this.directory, 'cache', `${id}.json`)); });
        await this.saving;
    }
    /** 图片只在阅读或归档时下载，成功后在本库复用 */
    private async asset(id: string, asset: Asset): Promise<ArrayBuffer> {
        if (!id.startsWith('rss_'))
            return (await this.provider()).asset(id, asset);
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
        await writeFile(path, Buffer.from(response.arrayBuffer));
        await this.saveCache(article.accountId);
        return response.arrayBuffer;
    }
}
