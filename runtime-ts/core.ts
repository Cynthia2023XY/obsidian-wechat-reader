import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Account, Article, Asset, CollectorError, Job } from '../src/collector/types';
/** 版本化本机协议的固定程序身份 */
export const PROGRAM_ID = 'obsidian-wechat-reader-companion';
/** TS 运行时版本独立于插件市场版本，防止复用旧 Python 实例 */
export const ENGINE_VERSION = 'ts-1';
/** 唯一索引表的允许范围 */
export type Table = 'accounts' | 'articles' | 'jobs';
/** 与一期 SQLite JSON 兼容的订阅字段 */
export type StoredAccount = Account & {
    firstSync: boolean;
    lastJobId: string | null;
};
/** 与一期持久化进度兼容的任务字段 */
export type StoredJob = Job & {
    source: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    priorityArticleId?: string;
};
/** 文件名仅在服务端存储，不暴露到插件或 RSS 内容中 */
export type StoredAsset = Asset & {
    file: string;
};
/** 上游发现项使用稳定 reviewId 或原文 URL */
export interface DiscoveredArticle {
    url: string;
    reviewId?: string;
    title?: string;
    publishedAt?: string | null;
    summary?: string;
}
/** 统一业务错误不携带上游原始响应或凭据 */
export class Problem extends Error {
    /** 错误码与用户操作以结构化字段返回 */
    constructor(public code: string, message: string, public retryable = false, public action?: string, public retryAfter?: number) { super(message); }
    /** 将错误转换为稳定 JSON 契约 */
    payload(): CollectorError { return { code: this.code, message: this.message, retryable: this.retryable, action: this.action, retryAfter: this.retryAfter }; }
}
/** 时区无关的 UTC 时间，不用当前日期代替未知文章日期 */
export function utc(seconds = Date.now() / 1000): string { return new Date(seconds * 1000).toISOString(); }
/** 完整 SHA256 用于身份和文件版本摘要 */
export function sha(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
/** 保留一期内部 ID 计算方式，避免迁移重算已归档关联 */
export function stableId(kind: string, value: string): string { return `${kind}_${sha(value).slice(0, 32)}`; }
/** 仅移除已确认追踪参数，保留文章定位信息 */
export function canonicalUrl(value: string): string {
    // 上游文章地址严格限定为微信主机。
    let url: URL;
    try {
        url = new URL(value.trim());
    }
    catch {
        throw new Problem('INVALID_URL', '请粘贴有效的微信文章链接');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'mp.weixin.qq.com' || url.port || url.username || !url.pathname.startsWith('/s'))
        throw new Problem('INVALID_URL', '请粘贴 mp.weixin.qq.com 的文章链接');
    // 与一期 urllib 排序和参数保留规则相同。
    const entries = [...url.searchParams.entries()].filter(([key]) => !['scene', 'from', 'isappinstalled', 'clicktime', 'enterid', 'subscene'].includes(key)).sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0);
    return `https://mp.weixin.qq.com${url.pathname}${entries.length ? `?${new URLSearchParams(entries)}` : ''}`;
}
/** 私有 JSON 文件采用当前用户权限和原子替换 */
export function writeJson(path: string, value: unknown): void {
    // 原子提交前的私有临时文件位置。
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
}
/** 读取固定位置配置，文件不存在时回退默认值 */
export function readJson<T>(path: string, fallback: T): T { try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
}
catch {
    return fallback;
} }
/** Node 原生 SQLite 保留一期数据结构，并在接管前创建可回退快照 */
export class Store {
    /** 唯一索引数据库，不依赖 Python 或 Electron 原生模块 ABI */
    db: DatabaseSync;
    revision = randomUUID();
    /** 当前用户独立存储根目录 */
    constructor(public root: string) {
        for (const name of ['data', 'data/articles', 'data/credentials', 'runtime', 'logs']) {
            mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
            chmodSync(join(root, name), 0o700);
        }
        this.db = new DatabaseSync(join(root, 'data/collector.sqlite'));
        this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS articles(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,account_id TEXT,state TEXT,data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS active_job ON jobs(account_id) WHERE state IN ('queued','running');
      CREATE TABLE IF NOT EXISTS aliases(alias TEXT PRIMARY KEY,article_id TEXT NOT NULL);PRAGMA user_version=1;`);
        // 只在首次 TS 接管时快照，旧正文版本目录保持不变。
        if (!existsSync(join(root, 'data/ts-migration.json'))) {
            // VACUUM INTO 在旧程序已经退出后生成一致性数据库快照。
            const backup = join(root, 'data', `before-ts-${Date.now()}.sqlite`);
            this.db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
            // 登录凭据沿用原结构，并在原地更新前保留私有副本。
            const credentials = join(root, 'data/credentials/account_pool.json');
            if (existsSync(credentials))
                copyFileSync(credentials, join(root, 'data/credentials/account_pool.before-ts.json'));
            writeJson(join(root, 'data/ts-migration.json'), { version: 1, createdAt: utc(), backup: backup.split(sep).pop() });
        }
        for (const job of this.all<StoredJob>('jobs'))
            if (['queued', 'running'].includes(job.state)) {
                job.state = 'interrupted';
                job.finishedAt = utc();
                job.error = new Problem('INTERRUPTED', '上次采集已中断，可以重新同步', true).payload();
                this.put('jobs', job);
            }
        for (const article of this.all<Article>('articles'))
            if (article.state === 'downloading') {
                article.state = 'temporary_failure';
                this.put('articles', article);
            }
        for (const name of readdirSync(join(root, 'data/articles')))
            if (name.endsWith('.tmp'))
                rmSync(join(root, 'data/articles', name), { recursive: true, force: true });
    }
    /** 根据内部主键读取业务对象 */
    get<T>(table: Table, id: string): T {
        // 按稳定身份查询得到的持久化记录。
        const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as {
            data: string;
        } | undefined;
        if (!row)
            throw new Problem('NOT_FOUND', '记录不存在');
        return JSON.parse(row.data);
    }
    /** 读取指定表的业务快照 */
    all<T>(table: Table): T[] { return (this.db.prepare(`SELECT data FROM ${table}`).all() as {
        data: string;
    }[]).map(row => JSON.parse(row.data)); }
    /** 更新对象与防重索引，所有写入均由单实例进程持有 */
    put<T extends {
        id: string;
    }>(table: Table, value: T): T {
        if (table === 'jobs') {
            // 本轮唯一队列任务的持久化快照。
            const job = value as unknown as StoredJob;
            this.db.prepare('INSERT OR REPLACE INTO jobs VALUES(?,?,?,?)').run(job.id, job.accountId, job.state, JSON.stringify(job));
        }
        else
            this.db.prepare(`INSERT OR REPLACE INTO ${table} VALUES(?,?)`).run(value.id, JSON.stringify(value));
        this.revision = randomUUID();
        return value;
    }
    /** 添加或恢复订阅，显示名称改变不会断开历史文章 */
    subscribe(identity: {
        platformId: string;
        bookId: string;
        originalName: string;
    }, name: string): StoredAccount {
        if (!identity.platformId || !/^MP_WXS_\d+$/.test(identity.bookId) || !name.trim() || ['微信公众号', '公众号'].includes(name.trim()))
            throw new Problem('IDENTITY_REQUIRED', '需要真实公众号身份及显示名称');
        // 沿用一期账户 ID，已有已读收藏无需重新关联。
        const id = stableId('account', identity.bookId);
        // 对旧记录保留同步游标和任务引用。
        let account: StoredAccount;
        try {
            account = this.get('accounts', id);
            account.subscribed = true;
            account.displayName = name.trim();
        }
        catch {
            account = { id, platformId: identity.platformId, bookId: identity.bookId, originalName: identity.originalName, displayName: name.trim(), subscribed: true, autoSync: true, nextSyncAt: 0, intervalMin: 120, intervalMax: 180, nextOffset: 0, firstSync: true, blocked: null, lastJobId: null };
        }
        return this.put('accounts', account);
    }
    /** URL 与 reviewId 建立别名，后补稳定标识也不改变 articleId */
    discover(account: StoredAccount, item: DiscoveredArticle): {
        article: Article;
        fresh: boolean;
    } {
        // URL 严格按一期规则规范化。
        const url = canonicalUrl(item.url);
        // 先查 URL，再查上游标识，使后补 reviewId 保留原 ID。
        const aliases = [`${account.id}:url:${url}`];
        if (item.reviewId)
            aliases.push(`${account.id}:review:${item.reviewId}`);
        // 同一进程中无 await 的事务保持身份与别名同时提交。
        this.db.exec('BEGIN IMMEDIATE');
        try {
            // 已确认别名可复用首次分配的身份。
            let id: string | undefined;
            for (const alias of aliases) {
                // 按稳定身份查询得到的持久化记录。
                const row = this.db.prepare('SELECT article_id FROM aliases WHERE alias=?').get(alias) as {
                    article_id: string;
                } | undefined;
                if (row) {
                    id = row.article_id;
                    break;
                }
            }
            id ||= stableId('article', aliases[aliases.length - 1]);
            // 新发现项先保存待下载状态，不能伪装为正文成功。
            let fresh = false, article: Article;
            try {
                article = this.get('articles', id);
            }
            catch {
                fresh = true;
                article = { id, accountId: account.id, title: item.title || '未命名文章', url, originalUrl: item.url, reviewId: item.reviewId || '', publishedAt: item.publishedAt || null, summary: item.summary || '', state: 'pending', assets: [], assetState: 'pending', contentVersion: '', updatedAt: utc(), error: null };
            }
            if (item.reviewId && !article.reviewId)
                article.reviewId = item.reviewId;
            if (item.publishedAt && !article.publishedAt) {
                article.publishedAt = item.publishedAt;
                article.updatedAt = utc();
            }
            for (const alias of aliases)
                this.db.prepare('INSERT OR IGNORE INTO aliases VALUES(?,?)').run(alias, id);
            this.put('articles', article);
            this.db.exec('COMMIT');
            return { article, fresh };
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    /** 同一个公众号至多保留一个排队或运行任务 */
    enqueue(accountId: string, source = 'manual'): StoredJob {
        // 内部方法先验证公众号存在。
        const account = this.get<StoredAccount>('accounts', accountId);
        // JS 单进程同步区与 SQLite 唯一索引共同防重。
        const existing = this.all<StoredJob>('jobs').find(job => job.accountId === accountId && ['queued', 'running'].includes(job.state));
        if (existing)
            return existing;
        // 分类统计在执行过程中持续保存。
        const job: StoredJob = { id: randomUUID().replace(/-/g, ''), accountId, state: 'queued', source, discovered: 0, succeeded: 0, failed: 0, createdAt: utc(), startedAt: null, finishedAt: null, error: null };
        this.put('jobs', job);
        account.lastJobId = job.id;
        this.put('accounts', account);
        return job;
    }
    /** 正文读取只允许已提交的内容版本 */
    content(article: Article): string { if (article.state !== 'ready')
        return ''; try {
        return readFileSync(join(this.root, 'data/articles', article.id, article.contentVersion, 'content.html'), 'utf8');
    }
    catch {
        throw new Problem('CONTENT_MISSING', '正文文件丢失，请重新下载', true);
    } }
    /** 文章资源归属与真实路径双重检查 */
    assetPath(id: string, assetId: string): string {
        // 资源名称和绝对路径只来自 SQLite 中的受控记录。
        const article = this.get<Article>('articles', id);
        // 来源 URL 不能替代资源所有权。
        const asset = (article.assets as StoredAsset[]).find(asset => asset.id === assetId && asset.state === 'ready');
        if (!asset)
            throw new Problem('NOT_FOUND', '图片未下载或不属于该文章');
        // 防止恶意或损坏数据库中的相对路径越过版本目录。
        const base = resolve(this.root, 'data/articles', id, article.contentVersion), path = resolve(base, asset.file);
        if (!path.startsWith(base + sep) || !existsSync(path) || !statSync(path).isFile())
            throw new Problem('NOT_FOUND', '本地图片不存在');
        return path;
    }
    /** 文件先原子提交，再将就绪状态写入 SQLite，旧版本保留 */
    commit(article: Article, html: string, assets: StoredAsset[], temporary: string): Article {
        if (!html.trim())
            throw new Problem('EMPTY_CONTENT', '文章没有可阅读正文', true);
        // 版本目录不可变，重试时不会覆盖已归档笔记的旧图片。
        const version = `${sha(html).slice(0, 12)}-${randomUUID().slice(0, 8)}`;
        // 正文和图片共同成为一个提交单元。
        const target = join(this.root, 'data/articles', article.id, version);
        mkdirSync(join(this.root, 'data/articles', article.id), { recursive: true });
        writeFileSync(join(temporary, 'content.html'), html);
        renameSync(temporary, target);
        Object.assign(article, { state: 'ready', assets, assetState: assets.every(asset => asset.state === 'ready') ? 'ready' : 'partial', contentVersion: version, updatedAt: utc(), error: null });
        delete article.retryImages;
        return this.put('articles', article);
    }
}
