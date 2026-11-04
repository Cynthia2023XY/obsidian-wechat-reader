# WeChat Reader · RSS 阅读

## Overview

WeChat Reader is a desktop RSS and Atom reader for Obsidian. Manage feeds in the sidebar, read and bookmark articles, and archive articles as Markdown with local images.

### Installation

**First-time installation from Obsidian Community plugins does not include the WeChat companion engine.** RSS and Atom work with the standard plugin files. To use WeChat subscriptions, you must also manually install `engine/` from the full package—even on your first installation.

- **RSS / Atom only:** install through Community plugins when available, or download `main.js`, `manifest.json`, and `styles.css` from the same release. For manual installation, place them in `<vault configuration folder>/plugins/wechat-reader/`, restart Obsidian, and enable the plugin. The configuration folder is usually `.obsidian`.
- **WeChat subscriptions (macOS Apple Silicon):** download `wechat-reader-1.0.0-macos-arm64.zip` from the [1.0.0 release](https://github.com/Cynthia2023XY/obsidian-wechat-reader/releases/tag/1.0.0), extract it, and install the complete `wechat-reader/` folder, including `engine/`, under your vault's plugin directory. Download the full package asset, not GitHub's Source code archive. If the standard plugin is already installed, add or replace the package files while preserving your existing `data.json` and `cache/`.

Once installed, the companion starts automatically when WeChat functionality needs it; users do not need to run it manually or install Node/Python separately. The current full package supports macOS Apple Silicon only.

**Updates:** Obsidian's standard updater downloads only `main.js`, `manifest.json`, and optional `styles.css`; it does not install `engine/` from the ZIP attachment. For releases that change the companion, including 1.0.0, also manually update `engine/` from that release's full package. Close all vaults using the companion and wait for collection to finish and the companion to stop before replacing it, then reopen Obsidian. Update every vault that uses WeChat on the same computer. Preserve settings, caches, and archived notes. UI-only releases normally require only the standard plugin update; check each release's instructions.

The separate companion provides a bundled Node environment, shared SQLite storage, and a collection queue across vaults. This architecture requires an additional installation step because Obsidian's [standard release mechanism](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin) distributes only the standard plugin files. The plugin does not automatically download or install the companion or its dependencies.

### Usage

Run “打开 RSS 阅读侧栏” or click the RSS ribbon icon, then use `+` to add an RSS or Atom feed URL. Open an article to read it, use the arrow keys to navigate, and choose “保存为 MD” to archive it. The All / Unread / Read / Starred entries show articles across feeds immediately; expand the feed navigation to browse one source. Lists show 50 articles initially and load 50 more at a time, with full-result counts. The reader freezes the currently displayed articles for navigation. Configure the archive folder and reader width in the plugin settings.

### Privacy and system access

RSS requests go to user-configured feeds and article image hosts. Optional WeChat support requires a WeChat Read account and contacts WeChat/WeChat Read for QR login, subscription lookup, and article retrieval. It may launch a local Chrome or Edge browser and a bundled Node companion process. The companion stores credentials, articles, and collection state outside the vault in `~/Library/Application Support/Obsidian WeChat Reader/`. Copy actions write article text or subscription links to the system clipboard. There is no telemetry, advertising, or paid feature.


[中文使用与开发说明](README.zh-CN.md)

## License and development

Licensed under the [MIT License](LICENSE). Third-party attribution is retained in the repository.

The legacy collector retains the MIT attribution of [wechat-mp-tools](https://github.com/x554960766/wechat-mp-tools). Third-party runtime licenses are included in the full package.

Development requires Node.js 26 or later. Run `npm ci`, `npm test`, `npm run test:companion`, `npm run lint`, and `npm run build`. Build the optional macOS Apple Silicon companion package with `npm run package:companion`. Install its `engine/` folder manually; other operating systems can use standard RSS and Atom without that companion.

The optional companion runs only while needed by Obsidian, unless persistent mode is selected. It does not install an operating-system background service. WeChat credentials remain in the local shared data directory, outside vault sync. Private feed URLs may contain subscription tokens; exported subscription files should be handled as private data. The plugin does not collect telemetry or automatically install dependencies.

WeChat images load directly from validated HTTPS CDN URLs while reading. Archiving downloads images as vault attachments. See [the image storage design](docs/remote-images.md).
