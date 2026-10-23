import { Plugin, FileSystemAdapter, Notice, PluginSettingTab, Setting, WorkspaceLeaf } from 'obsidian';
import { join } from 'node:path';
import { RuntimeManager } from './runtime/manager';
import { ReaderView, VIEW_TYPE } from './views/reader';
import { retainReaderLeaf } from './views/layout';
import { archiveRoot } from './archive/archive';
import { FeedService } from './feeds/service';
import type { CollectorProvider, ReaderData } from './collector/types';
/** 通用 RSS 阅读插件，普通订阅与公众号共享原生阅读交互 */
export default class WeChatReaderPlugin extends Plugin {
    /** 当前库设置与阅读状态，保持一期 ID 和关联不变 */
    data: ReaderData = { archiveFolder: 'RSS阅读', reading: {}, feeds: [], wechatEnabled: false, wechatFeeds: [] };
    /** 公众号专用运行时按需启动，普通 RSS 不依赖此程序 */
    runtime!: RuntimeManager;
    /** 来源无关的阅读和订阅服务 */
    service!: FeedService;
    /** 当前插件私有目录，用于 RSS 分片缓存和附属程序定位 */
    private directory = '';
    /** 布局恢复与命令同时触发时只创建一个右侧视图 */
    private opening?: Promise<void>;
    /** 正在使用的阅读标签，布局恢复时优先保留 */
    private readerLeaf?: WorkspaceLeaf;
    /** 关闭多余标签会再次触发布局事件，需避免递归整理 */
    private reconciling = false;
    /** 串行保存本库阅读状态，避免快速切换丢失较新结果 */
    private saving: Promise<void> = Promise.resolve();
    /** 注册侧栏与服务；沿用 manifest ID 完成一期设置迁移 */
    async onload(): Promise<void> {
        // 一期 data.json 中只有阅读偏好，新增配置保留默认值。
        const saved = await this.loadData();
        this.data = { ...this.data, ...saved, reading: saved?.reading || {}, feeds: saved?.feeds || [], wechatFeeds: saved?.wechatFeeds || [], wechatEnabled: saved?.wechatEnabled ?? (!!saved && !Array.isArray(saved.feeds)) };
        if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
            new Notice('当前内测包需要桌面本机笔记库');
            return;
        }
        this.directory = join(this.app.vault.adapter.getBasePath(), this.manifest.dir || `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
        this.runtime = new RuntimeManager(this.directory, message => new Notice(message));
        this.service = new FeedService(this.data, this.directory, () => this.persist(), () => this.runtime.connect());
        this.service.onChange = () => { for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE))
            (leaf.view as ReaderView).render?.(); };
        this.registerView(VIEW_TYPE, leaf => new ReaderView(leaf, this));
        this.registerEvent(this.app.workspace.on('layout-change', () => this.reconcileReader()));
        this.addRibbonIcon('rss', 'RSS 阅读', () => { void this.openReader(); });
        this.addCommand({ id: 'open-reader', name: '打开 RSS 阅读侧栏', callback: () => { void this.openReader(); } });
        this.addSettingTab(new ReaderSettings(this));
        // 恢复数据时只连接当前库明确启用的公众号能力。
        void this.service.load().then(() => this.service.onChange()).catch(error => new Notice(error.message));
        this.app.workspace.onLayoutReady(() => { void this.openReader().catch(error => new Notice(error.message)); });
    }
    /** 兼容公众号设置和登录窗口的运行接口 */
    async provider(): Promise<CollectorProvider> { return this.runtime.connect(); }
    /** 保留所有阅读状态，配置不保存运行端口或管理访问密钥 */
    async persist(): Promise<void> { const snapshot = JSON.parse(JSON.stringify(this.data)); this.saving = this.saving.catch(() => undefined).then(() => this.saveData(snapshot)); await this.saving; }
    /** 默认在右侧栏打开，升级时将一期中心阅读页迁移一次 */
    async openReader(): Promise<void> { if (!this.opening)
        this.opening = this.openSidebar().finally(() => { this.opening = undefined; }); await this.opening; }
    /** 执行一次布局迁移及视图展示 */
    private async openSidebar(): Promise<void> {
        // 用户后续拖动视图时保留其布局，首次升级明确停靠右侧。
        let leaf: WorkspaceLeaf | undefined = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
        // 一期没有布局版本，中心三栏页迁移为新的侧栏。
        const migrated = this.data.uiVersion === 2;
        if (!migrated && leaf) {
            leaf.detach();
            leaf = undefined;
        }
        if (!leaf) {
            leaf = this.app.workspace.getRightLeaf(false) || undefined;
            if (!leaf)
                throw new Error('无法创建右侧 RSS 栏');
            this.readerLeaf = leaf;
            await leaf.setViewState({ type: VIEW_TYPE, active: true });
        }
        this.readerLeaf = leaf;
        this.reconcileReader();
        this.data.uiVersion = 2;
        await this.persist();
        await this.app.workspace.revealLeaf(this.readerLeaf || leaf);
    }
    /** 异步恢复旧布局时只保留一个阅读标签，保留用户当前停靠位置 */
    private reconcileReader(): void {
        if (this.reconciling) return;
        this.reconciling = true;
        try {
            // 创建中的标签可能尚未进入工作区，空快照不清除其优先身份。
            const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
            if (leaves.length) this.readerLeaf = retainReaderLeaf(leaves, this.readerLeaf);
        }
        finally { this.reconciling = false; }
    }
    /** 导出普通源清单，不包括本机公众号密钥和文章缓存 */
    async exportOpml(): Promise<void> {
        // XML 属性通过实体转义，订阅名称不执行 HTML。
        const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!));
        // 保留分组名称，导入时可恢复当前源组织方式。
        const folders = new Map<string, typeof this.data.feeds>();
        for (const feed of this.data.feeds) {
            if (!folders.has(feed.folder))
                folders.set(feed.folder, []);
            folders.get(feed.folder)!.push(feed);
        }
        // 只导出 RSS URL，不包含共享采集认证配置。
        const body = [...folders].map(([folder, feeds]) => `<outline text="${escape(folder)}">${feeds.map(feed => `<outline type="rss" text="${escape(feed.title)}" title="${escape(feed.title)}" xmlUrl="${escape(feed.url)}"/>`).join('')}</outline>`).join('');
        // 导出由用户主动触发，文件保存在当前库的根目录。
        await this.app.vault.create(`RSS订阅-${Date.now()}.opml`, `<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>RSS 阅读订阅</title></head><body>${body}</body></opml>`);
        new Notice('OPML 已保存到笔记库');
    }
    /** 关闭订阅计时器并释放当前库的公众号租约 */
    onunload(): void { this.service?.dispose(); void this.runtime?.dispose(); }
}
/** 原生设置与弹窗均使用 Obsidian 控件自动跟随深浅主题 */
class ReaderSettings extends PluginSettingTab {
    /** 当前插件持有设置及订阅服务 */
    constructor(private plugin: WeChatReaderPlugin) { super(plugin.app, plugin); }
    /** 仅展示对用户有意义的归档和公众号能力配置 */
    display(): void {
        this.containerEl.empty();
        this.containerEl.createEl('h2', { text: 'RSS 阅读' });
        this.containerEl.createEl('p', { text: '订阅列表默认在右侧栏，文章在弹窗中阅读。界面跟随 Obsidian 深色或浅色主题。' });
        new Setting(this.containerEl).setName('Markdown 归档目录').setDesc('相对当前笔记库，图片与正文离线保存。').addText(text => text.setValue(this.plugin.data.archiveFolder).onChange(async (value) => { try {
            archiveRoot(value);
            this.plugin.data.archiveFolder = value;
            await this.plugin.persist();
        }
        catch { /* 输入过程保持最近有效位置。 */ } }));
        new Setting(this.containerEl).setName('启用微信公众号').setDesc('普通 RSS 不需要开启。公众号能力使用独立 TS 运行时。').addToggle(toggle => toggle.setValue(this.plugin.data.wechatEnabled).onChange(async (value) => { if (value) {
            try {
                await this.plugin.service.enableWeChat();
            }
            catch (error) {
                new Notice(error instanceof Error ? error.message : '连接失败');
            }
        }
        else {
            this.plugin.data.wechatEnabled = false;
            await this.plugin.persist();
            await this.plugin.runtime.dispose();
            this.plugin.runtime = new RuntimeManager((this.plugin as unknown as {
                directory: string;
            }).directory, message => new Notice(message));
        } this.plugin.service.onChange(); }));
        new Setting(this.containerEl).setName('打开阅读侧栏').addButton(button => button.setButtonText('打开右侧 RSS 栏').onClick(() => this.plugin.openReader()));
        this.containerEl.createEl('p', { text: '← / → 切换文章，↑ / ↓ 滚动正文，Esc 关闭弹窗。正文显示成功后自动已读。' });
    }
}
