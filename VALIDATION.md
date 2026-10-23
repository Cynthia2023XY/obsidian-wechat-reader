# 0.1.0 内测验证记录

日期：2026-10-23（Asia/Shanghai）。项目：`obsidian-wechat-reader`，独立 Git 工程，分支 `main`，尚无提交和远端发布。

## 已验证

| 检查 | 结果与证据 |
| --- | --- |
| TypeScript 类型与 production bundle | `npm run build` 通过，生成 `main.js` |
| 前端单元测试 | `npm run test:coverage`：15 项通过；归档不覆盖用户编辑、附件相对链接、HTML 清理、鉴权头与身份验证、有限重试和已有实例复用 |
| Python 测试 | `npm run test:companion`：33 项通过；稳定身份、reviewId 后补别名、同标题不同文章、跨旧项分页、并发防重、任务取消竞争、重启恢复、验证码暂停、资源归属、正文错误页识别、图片补采和 RSS |
| 自动化覆盖范围 | 全部前端语句覆盖率 21.28%；归档 100%、客户端 87.5%、运行管理 75.94%。原生主入口与视图未纳入自动单测，不能称为全量界面覆盖 |
| macOS arm64 封装 | PyInstaller onedir，包含 Python、Flask、Playwright 运行依赖，完整 zip 约 50 MB；普通使用不依赖项目 `.venv` |
| 封装程序启动 | `tests/packaged_smoke.py` 在含中文及空格的临时目录启动成功；身份、鉴权、发现文件私有权限、多库独立租约、重复进程退出均通过 |
| 浏览器能力 | 封装后的 Playwright 实际启动本机 Chrome `156.0.8078.47`，渲染与读取本地测试页面成功；此项不等同于真实受限微信文章通过 |
| Obsidian 实际加载 | 本机 Obsidian `1.14.4`，限定最低版本同为 `1.14.4`；在“新功能测试仓库”启用 0.1.0，原生三栏视图和命令加载成功 |
| 扫码登录 | 在插件内取得真实二维码，用户扫码后 `loggedIn=true`，界面显示登录成功 |
| 停用与重载 | 停用插件释放最后租约后实例退出；重新启用启动新实例，`loggedIn=true`，本地凭据保留 |
| 产物部署 | 按 manifest ID 部署至测试库 `.obsidian/plugins/wechat-reader/`；脚本校验 main.js、manifest.json、styles.css 和 engine 可执行程序哈希；保留 data.json 和笔记 |

原采集 checkout 仍使用固定提交 `0ac7c6f8cff641f6d2ba908a257c5c6e6ccc0acf`，本项目仅以 git show 复制所需模块，没有修改旧 checkout、旧数据或 5200 服务。

## 真实文章验证（2026-10-23）

输入链接：<https://mp.weixin.qq.com/s/8zG8orPQcfX8lNUrSVZGSg>。

- 正确识别公众号：**一个生物狗的科普小园**，上游 bookId `MP_WXS_3281168092`。
- 正文：**失去中国一年，日本水产业到底如何？我们用数据说话**，发布时间 UTC `2024-09-24T01:51:58Z`。
- 文章 ID：`article_fd9871c600580823f84c56086bd0b635`。重新解析、重复订阅、服务重启后不改变 ID。
- 正文在真实 Obsidian 视图中约 4,983 字符；13 个图片资源全部缓存，阅读页有 18 处图片引用。
- 实际打开正文后标记已读，收藏保存成功；重载后保留。
- 归档到测试库：`公众号阅读/一个生物狗的科普小园/2024-09-24 失去中国一年，日本水产业到底如何？我们用数据说话 6bd0b635.md`。
- Markdown 有 18 个相对图片链接，对应 13 个非空本地文件；没有 localhost 或 API 密钥依赖。
- 专用采集程序停止后，在 Obsidian 普通笔记预览中滚动阅读，13 个不同本地图片资源均实际加载成功，没有远程图片请求。
- 运行中连续两次同步请求均返回同一个 jobId；重复订阅已就绪文章没有创建新的采集任务。
- 实际重复“保存为笔记”检查原笔记正文未变，没有新增重复笔记。
- RSS 2.0 导出包含此文章的稳定 GUID，已通过原生操作保存 XML 快照到测试库归档目录。

本轮实测修复：短链解析仅返回 reviewId 的兼容；正确 MP_WXS_ 公众号身份格式；优先下载输入原文而非仅近期列表；补齐历史文章标题及发布时间；忽略无来源装饰图片；重复订阅避免额外采集；非验证类上游错误不再误报验证码。

其他近期条目存在 EMPTY_CONTENT 等失败；这些条目保留失败状态，不计入正文成功。本篇文章成功不能代表全部历史文章均可下载。

仍未验证：真实后续新文章进入阅读器、两个真实笔记库同时运行、硬件睡眠唤醒、长期频控与凭据自然到期。自动化分页、租约、恢复测试不能替代这些场景。

## 功能范围

实现独立订阅阅读器，文章由 JSON API 读取，不依赖 RSS Dashboard。RSS 兼容层提供 XML 快照导出；不把随机 API 密钥暴露为订阅 URL，也未提供公网持续 RSS。

保留在后续阶段的功能：旧服务数据迁移工具、LaunchAgent 独立后台、公网 RSS、内置浏览器分发、Windows/Linux/Intel/移动端采集与 TypeScript 采集迁移。未执行 Git 提交、推送、Release 或市场发布。

## 重跑

```sh
npm run test:coverage
npm run test:companion
npm run build
npm run package:companion
.venv/bin/python tests/packaged_smoke.py
npm run deploy:test
```

不要把 `runtime/instance.json` 或 `data/credentials/` 复制到验证报告或源码仓库；本记录不包含 Cookie、Token、二维码换票内容或本机访问密钥。
