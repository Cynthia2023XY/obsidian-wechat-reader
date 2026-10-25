/** 采集错误携带用户可操作信息，不包含原始凭据 */
export interface CollectorError { code: string; message: string; retryable: boolean; action?: string; retryAfter?: number }
/** 一轮同步的持久化统计 */
export interface Job { id: string; accountId: string; state: string; discovered: number; succeeded: number; failed: number; error?: CollectorError | null; }
/** 公众号稳定身份及订阅配置 */
export interface Account { id: string; platformId: string; bookId: string; displayName: string; originalName: string; subscribed: boolean; autoSync: boolean; nextSyncAt: number; intervalMin: number; intervalMax: number; nextOffset: number; articleUrl?: string; blocked?: CollectorError | null; lastJob?: Job }
/** 文章资源以 ID 关联，禁止向界面暴露本机路径 */
export interface Asset { id: string; state: string; mime: string; sourceUrl?: string; contentVersion?: string }
/** 采集文章与正文状态，阅读状态由笔记库独立保存 */
export interface Article { id: string; accountId: string; title: string; url: string; publishedAt: string | null; summary: string; state: string; assetState: string; assets: Asset[]; contentVersion: string; error?: CollectorError | null; html?: string; contentKind?: 'full' | 'summary'; author?: string; reviewId?: string; originalUrl?: string; updatedAt?: string; retryImages?: boolean }
/** 列表分页与增量查询结果 */
export interface Page<T> { items: T[]; nextCursor: string | null }
/** 本机程序兼容性与资源能力 */
export interface Health { programId: string; instanceId: string; apiVersion: number; engineVersion: string; schemaVersion: number; browserAvailable: boolean; diskUsed: number; diskFree: number; capabilities?: string[] }
/** 用户确认订阅前的临时身份解析结果 */
export interface Resolution { platformId: string; bookId: string; originalName: string; resolutionId: string }
/** 单个短期扫码会话 */
export interface Login { id: string; state: string; qr: string | null }
/** 每个笔记库单独保存的阅读、收藏及归档状态 */
export interface ReadingState { read?: boolean; starred?: boolean; archive?: string; version?: string }
/** 插件保存的数据只包含界面偏好与当前笔记库状态 */
export interface ReaderData { archiveFolder: string; reading: Record<string, ReadingState>; feeds: Feed[]; wechatEnabled: boolean; wechatFeeds: Feed[]; runtimeMode?: 'power-save' | 'persistent'; uiVersion?: number }
/** TS 采集程序及普通订阅资源的统一适配接口 */
export interface CollectorProvider {
  health(): Promise<Health>;
  call<T>(path: string, method?: string, body?: unknown): Promise<T>;
  asset(articleId: string, asset: Asset): Promise<ArrayBuffer>;
  rss(accountId: string): Promise<string>;
}

/** 普通订阅和公众号共用的展示模型，名称与分组不参与主键 */
export interface Feed { id: string; kind: 'rss' | 'atom' | 'wechat'; title: string; url: string; folder: string; enabled: boolean; intervalMinutes: number; etag?: string; modified?: string; checkedAt?: number; error?: string; retryAt?: number; nextSyncAt?: number; blocked?: boolean; missingLocalData?: boolean; wechat?: WeChatSubscription; }
/** OPML 导入预览条目保留嵌套分组与校验状态 */
export interface ImportFeed { title: string; url: string; folder: string; error?: string; duplicate?: boolean; }

/** 服务只写、插件只读的私有唤醒元数据，不含凭据和正文。 */
export interface ScheduleSnapshot { schemaVersion: 1; revision: string; createdAt: number; loggedIn: boolean; accounts: Account[]; articles: Article[]; activeAccountIds: string[]; }

/** 可随笔记库迁移的公开订阅定义；不含登录、任务或机器专用状态。 */
export interface WeChatSubscription { schemaVersion: 1; bookId: string; platformId: string; originalName: string; articleUrl?: string; subscribed: boolean; autoSync: boolean; intervalMin: number; intervalMax: number; }
