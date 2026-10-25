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


## 按需运行与快照（2026-10-25）

- 健康信息新增 `power-save` 能力。新版插件拒绝复用缺少此能力的旧程序，提示安装包含 engine 的完整包。
- `POST /v1/sync-due`：由共享调度器核对到期账户并去重入队；不重放休眠时错过的每一轮。
- `GET /v1/runtime/state`：`{activeJobs,loggedIn}`，用于活动批次的有界等待。入队成功不等于采集已完成。
- 服务原子写入私有 `runtime/schedule.json`：`{schemaVersion:1,revision,createdAt,loggedIn,accounts,articles,activeAccountIds}`。账户包含最近任务摘要；文章使用公共索引格式，不含正文、资源文件路径、凭据或访问令牌。插件只读此文件，不直接操作 SQLite。
- 活跃请求自动持有短会话，扫码和采集批次持有完整会话；省电模式在空闲 15 秒后释放本库租约，常驻模式保持续租。
- 最后一个租约释放后，服务在无请求、运行/排队任务与扫码需求时退出。启动宽限 15 秒；异常客户端仍由 90 秒租约过期回收。多个库不能互相终止任务。
- 所有间隔字段继续以分钟保存。新公众号默认 120～180 分钟，旧配置保留；修改间隔后按最近完成时间重算下次计划，运行任务使用新范围安排下一轮。
- `EMPTY_CONTENT` 表示正文下载失败，独立于每库 `reading.read`。用户看到错误提示可以已读，不改变文章或任务的采集成功状态。


## 可迁移公众号订阅（2026-10-25）

- 健康信息新增 `portable-subscriptions`。新插件要求此能力，避免旧服务不支持恢复接口。
- `Account.articleUrl` 为可公开访问的原文定位链接；创建订阅时保存，移除票据与追踪参数。
- 本库 `Feed.wechat` 白名单格式：`{schemaVersion:1,bookId,platformId,originalName,articleUrl?,subscribed,autoSync,intervalMin,intervalMax}`；Feed 自身保存稳定 ID、显示名和分组。不存登录凭据、Cookie、管理密钥、任务和游标。小时仍转为分钟保存。
- `POST /v1/accounts/restore`：`{id,displayName,subscription}` → `{account,created}`。校验身份与既有 ID 一致；新账户需已登录并由官方接口确认身份，已有账户直接返回，不覆盖设置和任务进度。网络确认后再次检查并发去重。
- 原文不可用时允许由已保存身份查询元信息确认；身份不一致、登录失效或验证受限时明确失败，不绕过限制。暂停与取消订阅状态照原配置恢复，不自动重新开启。
- 本机缺失账户在启动时（已登录）或扫码完成后自动重建；恢复失败每次会话只自动尝试一次，手动恢复可重试。旧定义无身份信息时保留入口，要求补一篇原文链接，不按公众号名称猜测身份。
