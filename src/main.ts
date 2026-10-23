import { Plugin, FileSystemAdapter, Notice, PluginSettingTab, Setting, WorkspaceLeaf } from 'obsidian';
import { join } from 'node:path';
import { RuntimeManager } from './runtime/manager';
import { ReaderView, VIEW_TYPE } from './views/reader';
import { archiveRoot } from './archive/archive';
import type { CollectorProvider, ReaderData } from './collector/types';

/** 公众号阅读插件入口，采集状态与本库阅读偏好分开保存 */
export default class WeChatReaderPlugin extends Plugin {
  /** 当前笔记库的界面设置及已读收藏 */
  data: ReaderData = {archiveFolder:'公众号阅读', reading:{}};
  /** 同一用户共享的附属程序管理器 */
  runtime!: RuntimeManager;
  /** 持久化写入链，避免并行收藏操作覆盖较新状态 */
  private saving: Promise<void> = Promise.resolve();
  /** 注册阅读面板、命令和原生设置入口 */
  async onload(): Promise<void> {
    // 仅恢复业务设置，不读取服务端口或登录凭据。
    const saved = await this.loadData();
    this.data = {archiveFolder: saved?.archiveFolder || '公众号阅读', reading: saved?.reading || {}};
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) { new Notice('公众号阅读需要本机桌面笔记库'); return; }
    // 插件目录按实际笔记库和 manifest ID 定位。
    const directory = join(this.app.vault.adapter.getBasePath(), this.manifest.dir || `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    this.runtime = new RuntimeManager(directory, message => new Notice(message));
    this.registerView(VIEW_TYPE, leaf => new ReaderView(leaf, this));
    this.addRibbonIcon('rss', '公众号阅读', () => { void this.openReader(); });
    this.addCommand({id:'open-reader', name:'打开公众号阅读', callback:() => { void this.openReader(); }});
    this.addSettingTab(new ReaderSettings(this));
    // 插件启用后注册租约，关闭阅读面板不影响后台订阅调度。
    void this.runtime.connect().catch(error => new Notice(`公众号阅读：${error.message}`));
  }
  /** 获取已验证的采集 Provider */
  async provider(): Promise<CollectorProvider> { return this.runtime.connect(); }
  /** 将本库状态串行写入插件 data.json */
  async persist(): Promise<void> {
    // 保存快照使快速连续操作保持顺序。
    const snapshot = JSON.parse(JSON.stringify(this.data));
    this.saving = this.saving.catch(() => undefined).then(() => this.saveData(snapshot));
    await this.saving;
  }
  /** 复用已有阅读页，避免打开重复视图 */
  async openReader(): Promise<void> {
    // Obsidian 工作区可能已经保留此视图。
    let leaf: WorkspaceLeaf | undefined = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({type:VIEW_TYPE, active:true}); }
    await this.app.workspace.revealLeaf(leaf);
  }
  /** 插件停用时释放本库租约，后台程序自行等待其他库和在途任务 */
  onunload(): void { void this.runtime?.dispose(); }
}

/** 原生设置面板只保存归档位置，不暴露凭据或内部路径 */
class ReaderSettings extends PluginSettingTab {
  /** 将当前插件绑定到设置面板 */
  constructor(private plugin: WeChatReaderPlugin) { super(plugin.app, plugin); }
  /** 展示安装能力和笔记归档位置 */
  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl('h2', {text:'公众号阅读'});
    this.containerEl.createEl('p', {text:'首版支持 macOS Apple Silicon。本机采集程序随插件启用运行；睡眠时暂停，恢复后合并补同步。'});
    new Setting(this.containerEl).setName('Markdown 归档目录').setDesc('相对当前笔记库的位置；附件随笔记离线保存。').addText(text => text.setValue(this.plugin.data.archiveFolder).onChange(async value => {
      try { archiveRoot(value); this.plugin.data.archiveFolder = value; await this.plugin.persist(); } catch { /* 允许输入过程中出现暂时空值，保留最近有效目录。 */ }
    }));
    new Setting(this.containerEl).setName('打开阅读器').addButton(button => button.setButtonText('打开').onClick(() => this.plugin.openReader()));
    this.containerEl.createEl('p', {text:'取消订阅保留已下载文章。Cookie 和 Token 仅在本机私有采集目录；插件不会上传笔记或遥测。'});
  }
}
