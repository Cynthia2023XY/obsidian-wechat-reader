# WeChat Reader · 公众号阅读

独立的 Obsidian 桌面插件。用一篇微信公众号文章链接订阅账号，在三栏面板中查看近期文章、阅读全文、收藏及离线归档。附属采集程序由插件自动启动，无需保留终端或手动安装 Python。

## 安装和使用

1. 使用 `dist/wechat-reader-0.1.0-macos-arm64.zip` 完整包。解压后将 `wechat-reader/` 放入笔记库 `.obsidian/plugins/`，保留其中的 `engine/`。
2. 在第三方插件中启用 **WeChat Reader**。点击侧栏 RSS 图标或执行“打开公众号阅读”。
3. 点击“扫码登录”，用微信扫描二维码并在手机确认微信读书授权。
4. 点击“添加公众号”，粘贴 `https://mp.weixin.qq.com/s/…` 文章地址，解析身份、确认显示名称、订阅。
5. 首次优先采集粘贴的文章，并同步近期文章（每轮最多 10 篇），后续默认随机 60～90 分钟同步，每轮最多 30 篇，全局串行。正文请求默认间隔 5 秒。
6. 在左栏查看同步统计及下次时间；“设置”可改名、暂停、取消或恢复订阅。取消订阅保留历史。
7. 正文显示成功后标为已读。收藏及已读仅属于当前笔记库。点击“保存为笔记”将 Markdown 和本地图片保存到设置的归档目录，默认 `公众号阅读/公众号名/`。
8. “导出 RSS”将当前成功采集的文章导出为 RSS 2.0 XML 文件，可导入兼容阅读器。文件导出是快照；持续自动订阅和更新由本插件完成。首版不提供无鉴权公网 RSS 地址。

## 运行范围

- 内测范围：macOS Apple Silicon；Node/Electron 附属程序，不能在移动端直接采集。使用 Obsidian 1.14.4 API 基线；实际运行版本和验收记录见 `VALIDATION.md`。
- Python 运行时已包含在完整安装包中。浏览器兜底需要本机 Chrome 或 Edge；插件会显示缺失提示，基础 HTTP 正文路径仍可尝试。
- 插件启用时持有本库租约；关闭阅读面板只停止 UI 轮询。多个笔记库共享一个进程和 SQLite 内容索引，最后客户端退出且当前有界任务结束后回收。
- 电脑睡眠时不采集。唤醒后到期订阅合并为一轮，不补跑所有错过时点。退出 Obsidian 后持续采集的 LaunchAgent 不在首版范围内。
- 登录或验证失效会暂停自动采集；在手机处理后重新扫码 / 手动同步。永久不可用文章不伪装为正文成功。
- 笔记按稳定 articleId 关联，重复归档打开原文件。正文更新可确认另存副本，保留原笔记及附件。
- 本地 RSS XML 不嵌入鉴权密钥或 localhost 图片。完整离线图片请使用 Markdown 归档。

## 数据与隐私

数据位于 `~/Library/Application Support/Obsidian WeChat Reader/`，目录权限为当前用户独享：

- `data/collector.sqlite`：公众号、文章索引、任务、别名。
- `data/articles/`：以文章 ID 和版本隔离的正文、图片。
- `data/credentials/`：微信读书授权凭据，与笔记库隔离。
- `runtime/`：文件锁、动态端口和随机访问密钥；仅回环 `127.0.0.1` 提供 API。

联网对象是微信 / 微信读书接口及文章图片 CDN，浏览器兜底也会加载微信页面。没有笔记上传、遥测或付费服务；复用上游不代表腾讯官方支持，协议变化可能需要维护。插件 `data.json` 仅保存归档目录、已读、收藏和笔记关联。RSS 和普通归档不包含凭据。项目使用固定上游 MIT 模块，见 `companion/upstream/README.md` 和许可证。

## 开发

```sh
npm ci
python3 -m venv .venv
.venv/bin/pip install -r companion/requirements.lock.txt
npm test
npm run test:companion
npm run build
npm run package:companion
npm run deploy:test
```

Python 开发入口（正式安装不需要执行）：

```sh
.venv/bin/python companion/server.py --root /absolute/path/to/private-test-data
```

实例发现文件包含密钥，不要复制到报告或提交到 Git。`contracts/README.md` 记录版本契约；测试不会自动使用旧服务凭据或触发真实账号采集。

## 首版验收边界

旧 5200 服务、数据和 checkout 保持独立。自动旧数据导入、LaunchAgent、公网 RSS、全历史回补、TypeScript 采集迁移不随本次安装启用。不要让两套服务使用同一登录凭据同时自动采集。真实扫码、账号新增、跨轮新增、睡眠唤醒、浏览器受限页面及长期频控需要实际账号和设备验证；构建及夹具测试不能替代这些结果。
