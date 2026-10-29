import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, rmSync, statfsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { Collector } from './collector';
import { ENGINE_VERSION, PROGRAM_ID, Problem, readJson, Store, utc, writeJson } from './core';
import type { Resolution } from './collector';
import type { StoredAccount, StoredAsset, StoredJob } from './core';
import type { Article, ScheduleSnapshot } from '../src/collector/types';
import { portableSubscription, subscriptionArticleUrl, wechatAccountId } from '../src/collector/subscriptions';
import { Scheduler } from './jobs';
import { executeCleanup, planCleanup } from './cleanup';
import type { CleanupPlan } from './cleanup';
import { parseHTML } from 'linkedom';
/** 运行时根目录参数由插件以数组传入，不使用 shell */
const rootArgument = process.argv.indexOf('--root');
/** 主程序标志用于测试模块导入时不自动监听端口 */
const direct = process.argv.includes('--serve') || rootArgument >= 0;
/** 固定平台配置的默认数据根目录 */
export const defaultRoot = join(homedir(), 'Library/Application Support/Obsidian WeChat Reader');
/** 长度一致后常量时间比较访问令牌 */
function equal(a: string, b: string): boolean { return Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
/** 将可信字符串转为 RSS XML 文本或属性 */
export function xmlEscape(value: string): string { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!)); }
/** 计算共享缓存磁盘占用，健康信息不暴露文件路径 */
function diskUsage(path: string): number {
    // 递归统计的缓存文件总字节数。
    let size = 0;
    for (const name of readdirSync(path)) {
        // 当前缓存路径及其文件属性，用于区分文件和目录。
        const item = join(path, name), info = statSync(item);
        size += info.isDirectory() ? diskUsage(item) : info.size;
    }
    return size;
}
/** HTTP 服务、客户端租约与唯一调度器的生命周期容器 */
export class RuntimeServer {
    /** 全部已注册客户端的租约到期时间 */
    clients = new Map<string, number>();
    /** 实际 HTTP 实例供集成测试与打包验证使用 */
    server = createServer((request, response) => { void this.handle(request, response); });
    /** 唯一公众号任务队列 */
    scheduler: Scheduler;
    /** 当前运行实例身份 */
    instanceId = randomUUID().replace(/-/g, '');
    /** 管理访问密钥每次启动重新生成，仅保存到私有发现文件 */
    key = randomBytes(32).toString('base64url');
    /** 实际绑定端口，首次分配后保持稳定 */
    port = 0;
    /** 主动停止后不接受新增采集任务 */
    stopping = false;
    /** 已解析身份的短时确认凭据 */
    private resolutions = new Map<string, {
        identity: Resolution;
        expires: number;
    }>();
    /** 公众号 RSS 只读令牌与管理密钥隔离 */
    private tokens: Record<string, string>;
    /** 运行时租约检查计时器 */
    private monitor?: ReturnType<typeof setInterval>;
    /** 仅每分钟更新磁盘用量，避免两秒 UI 查询遍历所有图片 */
    private usage = { at: 0, size: 0 };
    /** 启动宽限期允许插件完成健康检查和首次注册 */
    private grace = Date.now() + 15000;
    private requests = 0;
    private snapshotKey = '';
    private snapshotAt = 0;
    /** 仅当前实例内保存短期清理预览，避免凭旧预览误删新内容。 */
    private cleanupPlans = new Map<string, { before: string; revision: string; plan: CleanupPlan; expires: number }>();
    /** 不包含令牌、绝对资源路径或正文的只读索引与调度快照。 */
    publishSnapshot(): void {
        const loggedIn = this.collector.auth.status().loggedIn;
        const key = `${this.store.revision}:${loggedIn}`;
        if (key === this.snapshotKey && Date.now() - this.snapshotAt < 30000) return;
        const accounts = this.store.all<StoredAccount>('accounts').map(account => ({ ...account, lastJob: account.lastJobId ? this.store.get<StoredJob>('jobs', account.lastJobId) : undefined }));
        const snapshot: ScheduleSnapshot = {
            schemaVersion: 1, revision: this.store.revision, createdAt: Date.now(), loggedIn,
            accounts, articles: this.store.all<Article>('articles').map(article => this.publicArticle(article)),
            activeAccountIds: this.store.all<StoredJob>('jobs').filter(job => ['queued', 'running'].includes(job.state)).map(job => job.accountId),
        };
        writeJson(join(this.store.root, 'runtime/schedule.json'), snapshot);
        this.snapshotKey = key; this.snapshotAt = Date.now();
    }
    /** 空闲退出不能取消尚未开始的任务或其他客户端操作。 */
    canExit(now = Date.now()): boolean {
        return now > this.grace && !this.clients.size && !this.requests && !this.scheduler.busy
            && !['scanning', 'scanned'].includes(this.collector.auth.status().state)
            && !this.store.all<StoredJob>('jobs').some(job => ['queued', 'running'].includes(job.state));
    }
    /** 绑定单写入 SQLite 与 TS 采集适配器 */
    constructor(public store: Store, public collector: Collector) { this.scheduler = new Scheduler(store, collector); this.tokens = readJson(join(store.root, 'data/credentials/rss-tokens.json'), {}); }
    /** 在专用回环地址监听，端口冲突时不偷偷改变持续订阅 URL */
    async listen(port: number): Promise<void> { await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); }); }); this.port = (this.server.address() as {
        port: number;
    }).port; }
    /** 写入发现文件后再启动队列，避免插件误判另一程序 */
    start(): void {
        writeJson(join(this.store.root, 'runtime/instance.json'), { programId: PROGRAM_ID, apiVersion: 1, engineVersion: ENGINE_VERSION, runtimeLanguage: 'typescript', instanceId: this.instanceId, pid: process.pid, port: this.port, key: this.key });
        writeJson(join(this.store.root, 'runtime/settings.json'), { port: this.port });
        this.scheduler.start();
        this.publishSnapshot();
        this.monitor = setInterval(() => {
            for (const [id, expires] of this.clients) if (expires <= Date.now()) this.clients.delete(id);
            this.publishSnapshot();
            if (this.canExit()) void this.close();
        }, 2000);
    }
    /** 等待在途任务收尾后正常结束，不破坏其他库和半成品目录 */
    async close(): Promise<void> {
        if (this.stopping)
            return;
        this.stopping = true;
        if (this.monitor)
            clearInterval(this.monitor);
        this.scheduler.stop();
        this.collector.auth.dispose();
        while (this.scheduler.busy)
            await new Promise(resolve => setTimeout(resolve, 100));
        await new Promise<void>(resolve => this.server.close(() => resolve()));
        // 不删除另一实例后来生成的发现文件。
        const discovery = readJson<{
            instanceId?: string;
        }>(join(this.store.root, 'runtime/instance.json'), {});
        if (discovery.instanceId === this.instanceId)
            rmSync(join(this.store.root, 'runtime/instance.json'), { force: true });
        this.publishSnapshot();
        this.store.db.close();
    }
    /** 生成只允许读取当前公众号的持久令牌 */
    private token(accountId: string, rotate = false): string { if (!this.tokens[accountId] || rotate) {
        this.tokens[accountId] = randomBytes(24).toString('base64url');
        writeJson(join(this.store.root, 'data/credentials/rss-tokens.json'), this.tokens);
    } return this.tokens[accountId]; }
    /** 公共只读 RSS 不接受管理密钥代替源级令牌 */
    private canRead(accountId: string, token: string): boolean { return !!this.tokens[accountId] && equal(token, this.tokens[accountId]); }
    /** 原生 HTTP 响应统一携带请求 ID，不泄露异常堆栈 */
    private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        // 请求 ID 与日志中不出现的令牌完全独立。
        this.requests++;
        response.once('close', () => { this.requests--; if (!this.stopping) this.publishSnapshot(); });
        const requestId = randomUUID().replace(/-/g, '');
        // 固定防缓存头保护私有二维码与资源响应。
        response.setHeader('X-Request-Id', requestId);
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Cache-Control', 'no-store');
        // 所有 JSON 响应使用同一个封装，资源单独返回字节。
        const reply = (data: unknown, status = 200): void => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ data, requestId })); };
        try {
            if (request.headers.host?.split(':')[0] !== '127.0.0.1' || (request.headers.origin && request.headers.origin !== 'app://obsidian.md'))
                throw new Problem('FORBIDDEN', '不允许的请求来源');
            // 请求路径只通过 URL 标准解析，不拼接到文件系统。
            const url = new URL(request.url || '/', `http://127.0.0.1:${this.port}`), path = url.pathname;
            // 只读 RSS 及其资源采用独立的受限源令牌。
            const feed = path.match(/^\/feeds\/([^/]+)\/([A-Za-z0-9_-]+)\.xml$/);
            if (request.method === 'GET' && feed) {
                if (!this.canRead(feed[1], feed[2]))
                    throw new Problem('UNAUTHORIZED', '订阅令牌无效或已撤销');
                response.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
                response.end(this.rss(feed[1], feed[2]));
                return;
            }
            // 图片 URL 的令牌仅能读取同一个公众号的文章资源。
            const resource = path.match(/^\/feed-assets\/([^/]+)\/([A-Za-z0-9_-]+)\/([^/]+)\/([^/]+)$/);
            if (request.method === 'GET' && resource) {
                if (!this.canRead(resource[1], resource[2]) || this.store.get<Article>('articles', resource[3]).accountId !== resource[1])
                    throw new Problem('UNAUTHORIZED', '资源不属于该订阅');
                this.sendAsset(response, resource[3], resource[4]);
                return;
            }
            if (!equal(String(request.headers['x-reader-key'] || ''), this.key))
                throw new Problem('UNAUTHORIZED', '本机访问密钥无效');
            if (this.stopping)
                throw new Problem('STOPPING', '采集程序正在安全退出，请稍后重试', true);
            // 写操作必须显式使用 JSON，避免任意网页表单驱动本机服务。
            let body: Record<string, any> = {};
            if (['POST', 'PATCH'].includes(request.method || '')) {
                if (!request.headers['content-type']?.startsWith('application/json'))
                    throw new Problem('JSON_REQUIRED', '写操作必须使用 JSON');
                // 请求体限制沿用一期 64 KB。
                const chunks: Buffer[] = [];
                // 累计请求体大小，超过协议限额立即停止。
                let length = 0;
                for await (const chunk of request) {
                    length += chunk.length;
                    if (length > (path.startsWith('/v1/cache/') ? 1024 * 1024 : 64 * 1024))
                        throw new Problem('BODY_TOO_LARGE', '请求数据过大');
                    chunks.push(chunk);
                }
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
                    if (!body || typeof body !== 'object' || Array.isArray(body))
                        throw new Error();
                }
                catch {
                    throw new Problem('INVALID_JSON', 'JSON 请求格式无效');
                }
            }
            if (path === '/v1/health' && request.method === 'GET') {
                if (Date.now() - this.usage.at > 60000)
                    this.usage = { at: Date.now(), size: diskUsage(join(this.store.root, 'data')) };
                // 程序语言和版本需由客户端显式验证，拒绝误复用旧进程。
                const disk = statfsSync(this.store.root);
                reply({ programId: PROGRAM_ID, instanceId: this.instanceId, engineVersion: ENGINE_VERSION, runtimeLanguage: 'typescript', apiVersion: 1, schemaVersion: 1, capabilities: ['login', 'subscriptions', 'articles', 'assets', 'rss-export', 'rss-live', 'leases', 'power-save', 'portable-subscriptions', 'bounded-history', 'cache-cleanup'], browserAvailable: this.collector.browserAvailable(), diskFree: disk.bavail * disk.bsize, diskUsed: this.usage.size });
                return;
            }
            if (path === '/v1/runtime/state' && request.method === 'GET') {
                reply({ activeJobs: this.store.all<StoredJob>('jobs').filter(job => ['queued', 'running'].includes(job.state)), loggedIn: this.collector.auth.status().loggedIn });
                return;
            }
            if (path === '/v1/cache/preview' && request.method === 'POST') {
                // 预览只读取现有目录，不改变文章与笔记库状态。
                const plan = planCleanup(this.store, body.before, body.protectedIds);
                // 随机预览标识仅在当前实例短期有效。
                const id = randomUUID();
                this.cleanupPlans.clear();
                this.cleanupPlans.set(id, { before: body.before, revision: this.store.revision, plan, expires: Date.now() + 300000 });
                reply({ id, articles: plan.items.length, bytes: plan.bytes, accounts: plan.accounts });
                return;
            }
            if (path === '/v1/cache/clean' && request.method === 'POST') {
                // 在途采集、多个客户端和陈旧预览均不得改变共享正文。
                const previous = typeof body.id === 'string' ? this.cleanupPlans.get(body.id) : undefined;
                if (!previous || previous.expires < Date.now() || previous.revision !== this.store.revision) throw new Problem('STALE_PREVIEW', '缓存或采集状态已变化，请重新预览');
                if (this.scheduler.busy || this.store.all<StoredJob>('jobs').some(job => ['queued', 'running'].includes(job.state)) || this.clients.size > 1)
                    throw new Problem('CACHE_BUSY', '请等待采集完成，并关闭其他笔记库的公众号服务后重试');
                // 保护列表、目录大小和文章版本必须与预览时一致。
                const current = planCleanup(this.store, previous.before, body.protectedIds);
                if (JSON.stringify(current) !== JSON.stringify(previous.plan)) throw new Problem('STALE_PREVIEW', '缓存或收藏状态已变化，请重新预览');
                this.cleanupPlans.delete(body.id);
                // 实际删除后返回完成数量及可释放字节。
                const result = executeCleanup(this.store, current);
                this.usage.at = 0;
                this.publishSnapshot();
                reply(result);
                return;
            }
            if (path === '/v1/sync-due' && request.method === 'POST') {
                this.scheduler.scheduleDue();
                this.publishSnapshot();
                reply({ scheduled: true });
                return;
            }
            if (path === '/v1/clients' && request.method === 'POST') {
                // 当前独立客户端的随机租约身份。
                const id = randomUUID().replace(/-/g, '');
                this.clients.set(id, Date.now() + 90000);
                reply({ id, leaseSeconds: 90 }, 201);
                return;
            }
            // 客户端只能更新自己持有的随机租约 ID。
            const client = path.match(/^\/v1\/clients\/([^/]+)(\/renew)?$/);
            if (client) {
                if (request.method === 'DELETE') {
                    this.clients.delete(client[1]);
                    reply({ released: true });
                    return;
                }
                if (request.method === 'POST' && client[2]) {
                    if (!this.clients.has(client[1]))
                        throw new Problem('NOT_FOUND', '客户端租约已过期');
                    this.clients.set(client[1], Date.now() + 90000);
                    reply({ id: client[1], leaseSeconds: 90 });
                    return;
                }
            }
            if (path === '/v1/auth/status' && request.method === 'GET') {
                reply(this.collector.auth.status());
                return;
            }
            if (path === '/v1/auth/login' && request.method === 'POST') {
                reply(await this.collector.auth.startLogin());
                return;
            }
            if (path.startsWith('/v1/auth/login/') && request.method === 'GET') {
                if (path.split('/').pop() !== this.collector.auth.login.id)
                    throw new Problem('NOT_FOUND', '扫码会话已失效');
                reply({ ...this.collector.auth.login });
                return;
            }
            if (path === '/v1/auth/session' && request.method === 'DELETE') {
                reply(this.collector.auth.logout());
                return;
            }
            if (path === '/v1/accounts/resolve' && request.method === 'POST') {
                if (typeof body.url !== 'string')
                    throw new Problem('INVALID_URL', '请输入文章链接');
                // 身份确认凭据只在本进程中短时有效。
                const identity = await this.collector.resolve(body.url), id = randomUUID().replace(/-/g, '');
                for (const [key, value] of this.resolutions)
                    if (value.expires < Date.now())
                        this.resolutions.delete(key);
                this.resolutions.set(id, { identity, expires: Date.now() + 600000 });
                reply({ ...identity, resolutionId: id });
                return;
            }
            if (path === '/v1/accounts/restore' && request.method === 'POST') {
                const subscription = portableSubscription(body.subscription);
                if (!subscription || body.id !== wechatAccountId(subscription.bookId) || typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.length > 120)
                    throw new Problem('INVALID_SUBSCRIPTION', '订阅恢复信息不完整或身份不一致，请补充文章链接');
                const existing = this.store.all<StoredAccount>('accounts').find(account => account.id === body.id);
                // 已有共享账户保持原设置与进度，重复恢复不重新启用或重排任务。
                if (existing) { reply({ account: existing, created: false }); return; }
                if (!this.collector.auth.status().loggedIn) throw new Problem('AUTH_REQUIRED', '请先扫码登录，再恢复本库公众号订阅', false, 'login');
                let identity: { platformId: string; bookId: string; originalName: string } | undefined, seed: Resolution['seedArticle'] | undefined;
                if (subscription.articleUrl) {
                    try {
                        const resolved = await this.collector.resolve(subscription.articleUrl);
                        if (resolved.bookId !== subscription.bookId || resolved.platformId !== subscription.platformId)
                            throw new Problem('IDENTITY_MISMATCH', '恢复链接与原公众号不一致，请更换文章链接');
                        identity = resolved; seed = resolved.seedArticle;
                    } catch (error) {
                        // 原文失效时仍可按已保存身份恢复；登录和验证问题不得绕过。
                        if (error instanceof Problem && (error.action || error.code === 'IDENTITY_MISMATCH')) throw error;
                    }
                }
                if (!identity) {
                    const info = await this.collector.api('/book/info', { bookId: subscription.bookId });
                    if (typeof info.title !== 'string' || !info.title.trim() || ['微信公众号', '公众号'].includes(info.title.trim()))
                        throw new Problem('IDENTITY_REQUIRED', '暂时无法确认公众号，请补充一篇原文链接');
                    identity = { platformId: subscription.platformId, bookId: subscription.bookId, originalName: info.title };
                }
                // 网络验证期间其他库可能已恢复同一账户，提交前再次去重。
                const concurrent = this.store.all<StoredAccount>('accounts').find(account => account.id === body.id);
                if (concurrent) { reply({ account: concurrent, created: false }); return; }
                const account = this.store.subscribe(identity, body.displayName);
                Object.assign(account, { subscribed: subscription.subscribed, autoSync: subscription.autoSync, intervalMin: subscription.intervalMin, intervalMax: subscription.intervalMax, articleUrl: subscription.articleUrl });
                this.store.put('accounts', account);
                if (seed) this.store.discover(account, seed);
                this.publishSnapshot();
                reply({ account, created: true }, 201);
                return;
            }
            if (path === '/v1/accounts' && request.method === 'GET') {
                reply({ items: this.store.all<StoredAccount>('accounts').map(account => ({ ...account, lastJob: account.lastJobId ? this.store.get('jobs', account.lastJobId) : null })), nextCursor: null });
                return;
            }
            if (path === '/v1/accounts' && request.method === 'POST') {
                // 客户端不能伪造未解析的公众号标识。
                const resolved = this.resolutions.get(body.resolutionId);
                if (!resolved || resolved.expires < Date.now())
                    throw new Problem('RESOLUTION_EXPIRED', '解析结果已过期，请重新粘贴链接');
                if (typeof body.displayName !== 'string')
                    throw new Problem('INVALID_NAME', '请输入显示名称');
                // 数据库同步方法不会在本原子步骤中让出进程。
                const account = this.store.subscribe(resolved.identity, body.displayName);
                account.articleUrl = subscriptionArticleUrl(resolved.identity.seedArticle.url);
                this.store.put('accounts', account);
                const seed = this.store.discover(account, resolved.identity.seedArticle);
                // 重复添加已就绪文章复用原任务，不自动启动另一轮采集。
                const needsSync = account.firstSync || !account.lastJobId || ['pending', 'temporary_failure'].includes(seed.article.state);
                // 输入的原文优先于近期列表下载。
                const job = needsSync ? this.store.enqueue(account.id, 'initial') : this.store.get<StoredJob>('jobs', account.lastJobId!);
                if (needsSync) {
                    if (seed.fresh)
                        job.discovered++;
                    job.priorityArticleId = seed.article.id;
                    this.store.put('jobs', job);
                }
                reply({ account, jobId: job.id }, needsSync ? 201 : 200);
                return;
            }
            // 以下路由 ID 不会被用作任意文件名读取。
            const accountRoute = path.match(/^\/v1\/accounts\/([^/]+)(?:\/(subscription|sync|history|rss|rss\/token))?$/);
            if (accountRoute) {
                // 先读取账户，验证随机 ID 的归属。
                const account = this.store.get<StoredAccount>('accounts', accountRoute[1]);
                if (request.method === 'PATCH' && !accountRoute[2]) {
                    if (body.displayName !== undefined) {
                        if (typeof body.displayName !== 'string' || !body.displayName.trim())
                            throw new Problem('INVALID_NAME', '显示名称不能为空');
                        account.displayName = body.displayName.trim().slice(0, 120);
                    }
                    for (const field of ['autoSync', 'subscribed'] as const)
                        if (body[field] !== undefined) {
                            if (typeof body[field] !== 'boolean')
                                throw new Problem('INVALID_SETTING', '开关必须为布尔值');
                            account[field] = body[field];
                        }
                    // 约束既有同步策略，不因 TS 迁移改变频控默认值。
                    const minimum = body.intervalMin ?? account.intervalMin, maximum = body.intervalMax ?? account.intervalMax;
                    if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 60 || minimum > maximum || maximum > 1440)
                        throw new Problem('INVALID_INTERVAL', '间隔范围须为 60～1440 分钟');
                    if (minimum !== account.intervalMin || maximum !== account.intervalMax) {
                        const job = account.lastJobId ? this.store.get<StoredJob>('jobs', account.lastJobId) : undefined;
                        if (job?.state !== 'running') {
                            const base = job?.finishedAt ? Date.parse(job.finishedAt) / 1000 : Date.now() / 1000;
                            account.nextSyncAt = base + (minimum + Math.random() * (maximum - minimum)) * 60;
                        }
                    }
                    account.intervalMin = minimum;
                    account.intervalMax = maximum;
                    reply(this.store.put('accounts', account));
                    return;
                }
                if (request.method === 'DELETE' && accountRoute[2] === 'subscription') {
                    account.subscribed = false;
                    account.autoSync = false;
                    this.store.put('accounts', account);
                    for (const job of this.store.all<StoredJob>('jobs'))
                        if (job.accountId === account.id && job.state === 'queued') {
                            job.state = 'cancelled';
                            job.finishedAt = utc();
                            this.store.put('jobs', job);
                        }
                    reply(account);
                    return;
                }
                if (request.method === 'POST' && accountRoute[2] === 'history') {
                    // 活动任务与历史操作不能合并，否则用户无法确认实际抓取范围。
                    if (this.store.all<StoredJob>('jobs').some(job => job.accountId === account.id && ['queued', 'running'].includes(job.state)))
                        throw new Problem('JOB_BUSY', '该公众号正在采集，请等待完成后获取历史');
                    if (account.firstSync) throw new Problem('FIRST_SYNC_REQUIRED', '请先完成公众号首次同步');
                    if (account.historyComplete) throw new Problem('HISTORY_COMPLETE', '该公众号没有更多历史文章');
                    account.blocked = null;
                    this.store.put('accounts', account);
                    reply({ jobId: this.store.enqueue(account.id, 'history').id }, 202);
                    return;
                }
                if (request.method === 'POST' && accountRoute[2] === 'sync') {
                    account.blocked = null;
                    this.store.put('accounts', account);
                    reply({ jobId: this.store.enqueue(account.id).id }, 202);
                    return;
                }
                if ((request.method === 'GET' && accountRoute[2] === 'rss') || (request.method === 'POST' && accountRoute[2] === 'rss/token')) {
                    // 当前订阅源的只读令牌，与管理密钥隔离。
                    const token = this.token(account.id, request.method === 'POST');
                    reply({ url: `http://127.0.0.1:${this.port}/feeds/${account.id}/${token}.xml` });
                    return;
                }
            }
            // 排队任务可取消，运行任务只能等待有界请求结束。
            const jobRoute = path.match(/^\/v1\/jobs\/([^/]+)$/);
            if (jobRoute) {
                // 本轮唯一队列任务的持久化快照。
                const job = this.store.get<StoredJob>('jobs', jobRoute[1]);
                if (request.method === 'GET') {
                    reply(job);
                    return;
                }
                if (request.method === 'DELETE') {
                    if (job.state !== 'queued')
                        throw new Problem('JOB_RUNNING', '只能取消排队任务，请暂停后续自动同步');
                    job.state = 'cancelled';
                    job.finishedAt = utc();
                    reply(this.store.put('jobs', job));
                    return;
                }
            }
            if (path === '/v1/articles' && request.method === 'GET') {
                // 查询只读取索引，不在后台预取时改变已读状态。
                let rows = this.store.all<Article>('articles');
                for (const field of ['accountId', 'state'] as const)
                    if (url.searchParams.has(field))
                        rows = rows.filter(article => article[field] === url.searchParams.get(field));
                if (url.searchParams.has('updatedAfter'))
                    rows = rows.filter(article => (article.updatedAt || '') > url.searchParams.get('updatedAfter')!);
                rows.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || b.id.localeCompare(a.id));
                // 游标是非负页偏移，不接受任意对象或 SQL。
                const offset = Number(url.searchParams.get('cursor') || 0), limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)));
                if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit))
                    throw new Problem('INVALID_CURSOR', '分页游标无效');
                reply({ items: rows.slice(offset, offset + limit).map(article => this.publicArticle(article)), nextCursor: offset + limit < rows.length ? String(offset + limit) : null });
                return;
            }
            // 正文和图片必须属于被请求的文章 ID。
            const articleRoute = path.match(/^\/v1\/articles\/([^/]+)(?:\/(retry|assets\/([^/]+)))?$/);
            if (articleRoute) {
                // 本机绝对路径与原始凭据都不进入文章 API。
                const article = this.store.get<Article>('articles', articleRoute[1]);
                if (request.method === 'GET' && !articleRoute[2]) {
                    reply({ ...this.publicArticle(article), html: this.store.content(article) });
                    return;
                }
                if (request.method === 'GET' && articleRoute[3]) {
                    this.sendAsset(response, article.id, articleRoute[3]);
                    return;
                }
                if (request.method === 'POST' && articleRoute[2] === 'retry') {
                    if (article.state === 'unavailable')
                        throw new Problem('UNAVAILABLE', '永久不可用文章不重复下载');
                    if (this.store.all<StoredJob>('jobs').some(job => job.accountId === article.accountId && ['queued', 'running'].includes(job.state)))
                        throw new Problem('JOB_BUSY', '该公众号正在采集，请等待完成后重试正文');
                    article.retryImages = article.state === 'ready';
                    article.state = 'temporary_failure';
                    this.store.put('articles', article);
                    // 优先重试用户选择的文章，不让旧失败队列挤出额度。
                    const job = this.store.enqueue(article.accountId, 'retry');
                    job.priorityArticleId = article.id;
                    this.store.put('jobs', job);
                    reply({ jobId: job.id }, 202);
                    return;
                }
            }
            // 快照继续兼容一期管理接口；持续订阅使用独立源令牌。
            const snapshot = path.match(/^\/v1\/feeds\/([^/]+)\.xml$/);
            if (request.method === 'GET' && snapshot) {
                response.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
                response.end(this.rss(snapshot[1]));
                return;
            }
            throw new Problem('NOT_FOUND', '请求不存在');
        }
        catch (error) {
            // 响应格式不泄露任何内部路径或堆栈。
            const problem = error instanceof Problem ? error : new Problem('INTERNAL', '本机采集处理失败，请重试或检查版本', true);
            // 与一期调用方保留 HTTP 分类兼容。
            const status = problem.code === 'UNAUTHORIZED' ? 401 : problem.code === 'FORBIDDEN' ? 403 : problem.code === 'NOT_FOUND' ? 404 : 400;
            if (!response.headersSent) {
                response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
                response.end(JSON.stringify({ error: problem.payload(), requestId }));
            }
            else
                response.end();
        }
    }
    /** API 资源元信息只包含资源 ID 与显示能力 */
    private publicArticle(article: Article): Article { return { ...article, assets: article.assets.map(asset => ({ id: asset.id, state: asset.state, mime: asset.mime })) }; }
    /** 返回已经确认归属及 MIME 的图片文件 */
    private sendAsset(response: ServerResponse, id: string, assetId: string): void {
        // 本次操作所属的文章，不复用界面稍后的选择。
        const article = this.store.get<Article>('articles', id);
        // 已经验证文章归属后的本地资源路径。
        const path = this.store.assetPath(id, assetId);
        // 当前文章声明的图片元信息。
        const asset = article.assets.find(asset => asset.id === assetId)!;
        response.writeHead(200, { 'Content-Type': asset.mime });
        response.end(readFileSync(path));
    }
    /** RSS 输出适配器只从成功正文生成条目，不回读进插件模型 */
    private rss(id: string, token?: string): string {
        // 未知公众号不能枚举数据目录。
        const account = this.store.get<StoredAccount>('accounts', id);
        // XML 快照使用纯正文；持续订阅允许当前源限定资源。
        const rows = this.store.all<Article>('articles').filter(article => article.accountId === id && article.state === 'ready').sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '')).slice(0, 100);
        // 描述中的 HTML 依然经 XML 转义，不能突破 channel 结构。
        const items = rows.map(article => {
            // 隔离解析的正文文档，不执行来源脚本。
            const { document } = parseHTML(`<html><body>${this.store.content(article)}</body></html>`);
            for (const image of document.querySelectorAll('img')) {
                // 正文占位引用的文章图片身份。
                const assetId = image.getAttribute('src')?.replace(/^asset:/, '');
                if (!token || !article.assets.some(asset => asset.id === assetId && asset.state === 'ready'))
                    image.remove();
                else
                    image.setAttribute('src', `http://127.0.0.1:${this.port}/feed-assets/${id}/${token}/${article.id}/${assetId}`);
            }
            return `<item><title>${xmlEscape(article.title)}</title><link>${xmlEscape(article.url)}</link><guid isPermaLink="false">${article.id}</guid>${article.publishedAt ? `<pubDate>${new Date(article.publishedAt).toUTCString()}</pubDate>` : ''}<description>${xmlEscape(document.body.innerHTML)}</description></item>`;
        }).join('');
        return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xmlEscape(account.displayName)}</title><link>https://mp.weixin.qq.com/</link><description>个人本机公众号订阅</description>${items}</channel></rss>`;
    }
}
/** 仅命令行入口获取实例锁，测试可直接创建隔离 HTTP 服务 */
async function main(): Promise<void> {
    process.umask(0o077);
    // 缺省目录只供本机桌面运行，路径来自明确参数。
    const root = rootArgument >= 0 ? process.argv[rootArgument + 1] : defaultRoot;
    if (!root)
        throw new Error('缺少运行目录');
    mkdirSync(join(root, 'runtime'), { recursive: true, mode: 0o700 });
    // 先确认旧程序已退出，绝不与 Python 旧实例同时写 SQLite。
    const existing = readJson<{
        port?: number;
        key?: string;
    }>(join(root, 'runtime/instance.json'), {});
    if (existing.port && existing.key) {
        try {
            // 当前有界网络请求的响应，仅在内存中处理。
            const response = await fetch(`http://127.0.0.1:${existing.port}/v1/health`, { headers: { 'X-Reader-Key': existing.key }, signal: AbortSignal.timeout(1500) });
            if (response.ok)
                return;
        }
        catch { /* 陈旧发现文件不能阻止新实例恢复。 */ }
    }
    // mkdir 的排他语义用于多个新客户端同时启动时选出唯一进程。
    const lock = join(root, 'runtime/ts-instance.lock');
    try {
        mkdirSync(lock, { mode: 0o700 });
    }
    catch {
        // 只有确认旧持有者已死亡才清理残留锁。
        const owner = readJson<{
            pid?: number;
        }>(join(lock, 'owner.json'), {});
        if (!owner.pid && Date.now() - statSync(lock).mtimeMs < 30000)
            return;
        // 旧实例持有者是否仍存在，存活时不能抢占实例锁。
        let alive = true;
        try {
            if (!owner.pid)
                throw new Error();
            process.kill(owner.pid, 0);
        }
        catch {
            alive = false;
        }
        if (alive)
            return;
        rmSync(lock, { recursive: true, force: true });
        try {
            mkdirSync(lock, { mode: 0o700 });
        }
        catch {
            return;
        }
    }
    writeJson(join(lock, 'owner.json'), { pid: process.pid });
    // 退出时仅释放当前进程实际拥有的锁。
    const release = () => {
        // 实例锁记录的持有进程身份。
        const owner = readJson<{
            pid?: number;
        }>(join(lock, 'owner.json'), {});
        if (owner.pid === process.pid)
            rmSync(lock, { recursive: true, force: true });
    };
    process.on('exit', release);
    try {
        // 只有唯一持有者可触发中断恢复及迁移快照。
        const store = new Store(root), collector = new Collector(root);
        if (process.argv.includes('--check-browser')) {
            console.log(JSON.stringify({ browserReady: true, browserVersion: await collector.checkBrowser(), runtimeLanguage: 'typescript' }));
            store.db.close();
            release();
            return;
        }
        // 已配置端口冲突时显式失败，不导致第三方订阅 URL 静默改变。
        const config = readJson<{
            port?: number;
        }>(join(root, 'runtime/settings.json'), {});
        // HTTP API 与队列共用同一个生命周期容器。
        const runtime = new RuntimeServer(store, collector);
        await runtime.listen(config.port || 0);
        runtime.start();
        // 信号处理只要求安全收尾，不强制中断磁盘提交。
        const stop = () => { void runtime.close().then(release).catch(() => { release(); process.exitCode = 1; }); };
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);
    }
    catch {
        release();
        process.stderr.write('TS 采集程序启动失败：请检查专用端口、数据权限或安装包。\n');
        process.exitCode = 1;
    }
}
if (direct)
    void main();
