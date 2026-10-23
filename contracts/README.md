# CollectorProvider v1

健康程序标识 `obsidian-wechat-reader-companion`，engine `ts-1`，runtimeLanguage `typescript`，API `1`，SQLite schema `1`。

所有管理 HTTP 请求必须携带 `X-Reader-Key`，服务仅绑定 `127.0.0.1` 的专用端口（首次分配后持久记忆，冲突时报错）。Origin 仅接受缺省值（原生 requestUrl）或 `app://obsidian.md`，不启用 CORS。POST / PATCH 必须为 JSON。统一响应 `{data, requestId}`；错误 `{error:{code,message,retryable,retryAfter,action},requestId}`。资源和 RSS 返回原始字节并带 `X-Request-Id`。

- `GET /v1/health`
- `POST /v1/clients`、`POST /v1/clients/:id/renew`、`DELETE /v1/clients/:id`：90 秒租约，客户端每 25 秒续租。
- `GET /v1/auth/status`、`POST /v1/auth/login`、`GET /v1/auth/login/:id`、`DELETE /v1/auth/session`。
- `POST /v1/accounts/resolve`：`{url}` → `{platformId,bookId,originalName,resolutionId}`。确认凭据 10 分钟过期。
- `GET /v1/accounts`、`POST /v1/accounts`：`{resolutionId,displayName}`，优先排队输入的原文，连同近期文章每轮最多下载 10 篇。
- `PATCH /v1/accounts/:id`：显示名称、subscribed、autoSync、intervalMin/Max（60～1440 分钟）。
- `DELETE /v1/accounts/:id/subscription`：保留内容并取消排队任务。
- `POST /v1/accounts/:id/sync` → 202 `{jobId}`；同一账号有效任务去重。
- `GET /v1/jobs/:id`；`DELETE /v1/jobs/:id` 只取消 queued。
- `GET /v1/articles?accountId=&state=&cursor=&limit=&updatedAfter=` → `{items,nextCursor}`，时间 UTC ISO8601。
- `GET /v1/articles/:id`、`GET /v1/articles/:id/assets/:assetId`，不返回文件绝对路径。
- `POST /v1/articles/:id/retry`：就绪文章只补图片；其他临时失败重新采集，仍经过同一任务队列。
- `GET /v1/feeds/:accountId.xml`：最近 100 篇成功正文的本地 RSS 2.0 导出，图片交给离线 Markdown 附件。

主要错误：AUTH_REQUIRED（扫码）、VERIFICATION_REQUIRED（手机处理验证）、NETWORK / UPSTREAM（稍后重试）、UNAVAILABLE（墓碑）、DISK_FULL（释放空间）、INTERRUPTED（重启后重试）。

文章 identity：reviewId 优先，URL 摘要兜底；后续可靠 reviewId 作为别名，不改变已分配 articleId。分页遇到整页旧项才停止，保留积压偏移，标题相同不合并。正文版本目录原子替换后才提交索引；新版本保留旧归档附件。

二期持续订阅：`GET /v1/accounts/:id/rss` 返回源级只读 URL，`POST /v1/accounts/:id/rss/token` 撤销旧令牌并返回新地址；`GET /feeds/:id/:token.xml` 与 `/feed-assets/:id/:token/:articleId/:assetId` 仅允许读取对应源的成功内容，不接受管理密钥作为源令牌。令牌不写日志，不导入 OPML。

普通 RSS/Atom 使用插件内 FeedService 和本库分片缓存，不调用上述管理接口。首次 TS 接管创建私有 SQLite / 凭据快照，前置条件是旧程序已经停止。
