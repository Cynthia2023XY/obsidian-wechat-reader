# 上游来源

源项目：https://github.com/x554960766/wechat-mp-tools

固定版本：2.3.1 / `0ac7c6f8cff641f6d2ba908a257c5c6e6ccc0acf`，MIT，原许可见 LICENSE。

只复制扫码基础函数、签名、凭据续期、正文提取和浏览器相关模块。不导入 app_mp、原有 articles/accounts 蓝图、调度器或 RSS 上传器。

本地改动：config 的凭据路径必须显式注入；禁止旧账号池硬编码路径导入/回写；关闭视频与 PDF 默认项；auth 只保留扫码换票函数。新订阅、分页、队列与 SQLite 均由 companion 管理。
