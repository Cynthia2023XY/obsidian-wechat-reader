# WeChat Reader

[中文说明](README.md) | English

## Overview

WeChat Reader is a desktop RSS and Atom reader for Obsidian. Manage feeds in the sidebar, read and bookmark articles, and archive articles as Markdown with local images.

### Installation

**RSS and Atom work without the optional WeChat engine. Engine downloads only begin after an explicit user confirmation.**

> Version 1.1.0 adds the in-plugin installer. Version 1.0.0 does not include this button: update the plugin first, or install a full package manually.

Install standard plugin files via Community plugins when available, or copy `main.js`, `manifest.json`, and `styles.css` to `<vault configuration folder>/plugins/wechat-reader/` (usually `.obsidian`). For WeChat, version 1.1.0 provides “安装公众号引擎” in settings and the sidebar menu. The dialog displays the source, version, ~45.5 MiB download size and destination before confirmation. It downloads the pinned 1.0.0 GitHub release package, verifies a built-in SHA-256 digest, extracts only the engine and licenses, and validates bundled Node. Cancellation, retry and repair are supported. Enable WeChat and sign in after installation; installation does not enable the feature automatically. Currently macOS Apple Silicon only; no separate Node/Python installation is required.

Downloaded engines live in version directories named `wechat-engine-<UUID>/` inside the plugin folder, selected through `wechat-engine.json`. Existing manually installed `engine/` remains supported. Settings, caches and archive files are preserved. A running shared companion keeps its current tasks; a new process uses the selected engine. Old engine directories are retained to protect running processes; each reinstall consumes approximately another 150 MiB.

Manual fallback: download the full ZIP from the [1.1.0 release](https://github.com/Cynthia2023XY/obsidian-wechat-reader/releases/tag/1.1.0), not the Source code archive, and install its complete plugin folder while preserving `data.json` and `cache/`.

**Updates:** Obsidian's [standard updater](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin) distributes only the standard plugin files. This installer does not query latest or update silently: the version and digest are pinned in plugin code. A future plugin release can specify a new compatible package for users to explicitly install. The current installer only installs or repairs engine 1.0.0. Close relevant vaults and wait for collection and the old companion to stop before manually replacing an engine in use; keep related vaults on compatible versions.

A separate companion supplies fixed Node, shared SQLite and a collection queue across vaults. The installer removes manual download and extraction steps, but official acceptance of user-initiated executable dependency installation has not been confirmed; this implementation does not imply Community directory approval.

### Usage

Run “打开 RSS 阅读侧栏” or click the RSS ribbon icon, then use `+` to add an RSS or Atom feed URL. Open an article to read it, use the arrow keys to navigate, and choose “保存为 MD” to archive it. The All / Unread / Read / Starred entries show articles across feeds immediately; expand the feed navigation to browse one source. Lists show 50 articles initially and load 50 more at a time, with full-result counts. The reader freezes the currently displayed articles for navigation. Configure the archive folder and reader width in the plugin settings.

### Privacy and system access

RSS requests go to user-configured feeds and article image hosts. Optional WeChat support requires a WeChat Read account and contacts WeChat/WeChat Read for QR login, subscription lookup, and article retrieval. It may launch a local Chrome or Edge browser and a bundled Node companion process. The companion stores credentials, articles, and collection state outside the vault in `~/Library/Application Support/Obsidian WeChat Reader/`. Copy actions write article text or subscription links to the system clipboard. There is no telemetry, advertising, or paid feature.


[中文使用与开发说明](README.md)

## License and development

Licensed under the [MIT License](LICENSE). Third-party attribution is retained in the repository.

The legacy collector retains the MIT attribution of [wechat-mp-tools](https://github.com/x554960766/wechat-mp-tools). Third-party runtime licenses are included in the full package.

Development requires Node.js 26 or later. Run `npm ci`, `npm test`, `npm run test:companion`, `npm run lint`, and `npm run build`. Build the optional macOS Apple Silicon companion package with `npm run package:companion`. Install its `engine/` folder manually; other operating systems can use standard RSS and Atom without that companion.

The optional companion runs only while needed by Obsidian, unless persistent mode is selected. It does not install an operating-system background service. WeChat credentials remain in the local shared data directory, outside vault sync. Private feed URLs may contain subscription tokens; exported subscription files should be handled as private data. The plugin does not collect telemetry. It downloads the pinned WeChat engine from GitHub only after explicit confirmation, never on startup, and does not silently update it.

WeChat images load directly from validated HTTPS CDN URLs while reading. Archiving downloads images as vault attachments. See [the image storage design](docs/remote-images.md).
