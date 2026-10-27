# WeChat Reader · RSS 阅读

## Overview

WeChat Reader is a desktop RSS and Atom reader for Obsidian. Manage feeds in the sidebar, read and bookmark articles, and archive articles as Markdown with local images.

### Installation

Download `main.js`, `manifest.json`, and `styles.css` from the same GitHub release. Place them in `<vault configuration folder>/plugins/wechat-reader/`, restart Obsidian, and enable WeChat Reader in Community plugins. The configuration folder is usually `.obsidian`, but can be customized.

Standard release assets support ordinary RSS and Atom feeds. WeChat subscriptions additionally require the manually installed companion `engine/` from the macOS Apple Silicon full package. The plugin never downloads or installs itself or its dependencies.

### Usage

Run “打开 RSS 阅读侧栏” or click the RSS ribbon icon, then use `+` to add an RSS or Atom feed URL. Open an article to read it, use the arrow keys to navigate, and choose “保存为 MD” to archive it. Configure the archive folder and reader width in the plugin settings.

### Privacy and system access

RSS requests go to user-configured feeds and article image hosts. Optional WeChat support requires a WeChat Read account and contacts WeChat/WeChat Read for QR login, subscription lookup, and article retrieval. It may launch a local Chrome or Edge browser and a bundled Node companion process. The companion stores credentials, articles, and collection state outside the vault in `~/Library/Application Support/Obsidian WeChat Reader/`. Copy actions write article text or subscription links to the system clipboard. There is no telemetry, advertising, or paid feature.


[中文使用与开发说明](README.zh-CN.md)

## License and development

Licensed under the [MIT License](LICENSE). Third-party attribution is retained in the repository.

The legacy collector retains the MIT attribution of [wechat-mp-tools](https://github.com/x554960766/wechat-mp-tools). Third-party runtime licenses are included in the full package.

Development requires Node.js 26 or later. Run `npm ci`, `npm test`, `npm run test:companion`, `npm run lint`, and `npm run build`. Build the optional macOS Apple Silicon companion package with `npm run package:companion`. Install its `engine/` folder manually; other operating systems can use standard RSS and Atom without that companion.

The optional companion runs only while needed by Obsidian, unless persistent mode is selected. It does not install an operating-system background service. WeChat credentials remain in the local shared data directory, outside vault sync. Private feed URLs may contain subscription tokens; exported subscription files should be handled as private data. The plugin does not collect telemetry or automatically install dependencies.
