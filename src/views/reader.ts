import { ItemView, Modal, Notice, Setting, WorkspaceLeaf, normalizePath } from 'obsidian';
import type WeChatReaderPlugin from '../main';
import { archiveArticle, cleanArticle, safeName, archiveRoot } from '../archive/archive';
import type { Account, Article, CollectorProvider, Health, Login, Page, Resolution } from '../collector/types';

/** 工作区阅读页类型 */
export const VIEW_TYPE = 'wechat-reader-view';
/** 任务和正文状态的中文展示 */
const STATE_LABELS: Record<string,string> = {pending:'待下载', downloading:'下载中', ready:'正文就绪', temporary_failure:'临时失败', unavailable:'内容不可用', queued:'排队中', running:'同步中', succeeded:'同步成功', partial:'部分成功', failed:'同步失败', interrupted:'已中断', waiting_verification:'等待处理', cancelled:'已取消'};
/** 登录状态的中文展示 */
const LOGIN_LABELS: Record<string,string> = {scanning:'请用微信扫描二维码', scanned:'已扫码，请在手机确认', success:'登录成功，可以添加公众号', failed:'登录失败，请重新获取二维码', expired:'二维码已过期，请重新扫码', idle:'尚未开始登录'};

/** 原生三栏阅读器，视图关闭后停止界面轮询 */
export class ReaderView extends ItemView {
  /** 订阅列表的当前快照 */
  private accounts: Account[] = [];
  /** 当前分页加载的文章 */
  private articles: Article[] = [];
  /** 当前公众号筛选条件 */
  private accountId = '';
  /** 当前阅读状态筛选条件 */
  private filter = 'all';
  /** 下一页的偏移游标 */
  private cursor: string | null = null;
  /** 已选文章的完整正文 */
  private selected?: Article;
  /** 防止旧请求覆盖用户新选择 */
  private selection = 0;
  /** 列表请求序号避免筛选切换乱序 */
  private listSequence = 0;
  /** 视图生命周期标志 */
  private closed = false;
  /** 轮询正在进行，避免网络慢时请求堆积 */
  private polling = false;
  /** 后台任务状态轮询计时器 */
  private timer?: ReturnType<typeof setInterval>;
  /** 文章本地显示资源 URL，离开文章后释放 */
  private resources: string[] = [];
  /** 顶部采集状态 */
  private status!: HTMLElement;
  /** 左侧订阅容器 */
  private sidebar!: HTMLElement;
  /** 中栏文章容器 */
  private list!: HTMLElement;
  /** 右侧正文容器 */
  private reader!: HTMLElement;
  /** 搜索标题的本地筛选条件 */
  private keyword = '';
  /** 当前视图绑定插件实例 */
  constructor(leaf: WorkspaceLeaf, private plugin: WeChatReaderPlugin) { super(leaf); }
  /** 工作区识别视图类型 */
  getViewType(): string { return VIEW_TYPE; }
  /** 工作区页签标题 */
  getDisplayText(): string { return '公众号阅读'; }
  /** 工作区页签图标 */
  getIcon(): string { return 'rss'; }
  /** 初始化固定布局，刷新时保留当前阅读位置 */
  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.empty();
    this.contentEl.addClass('wechat-reader');
    // 顶部工具只承担用户操作，不在插件创建采集定时器。
    const toolbar = this.contentEl.createDiv({cls:'wr-toolbar'});
    toolbar.createEl('h2', {text:'公众号阅读'});
    this.button(toolbar, '添加公众号', () => new SubscribeModal(this.plugin, () => this.refresh()).open(), true);
    this.button(toolbar, '扫码登录', () => new LoginModal(this.plugin).open());
    this.button(toolbar, '重新连接', async () => { await this.plugin.runtime.retry(); await this.refresh(); });
    this.button(toolbar, '退出登录', () => new ConfirmModal(this.app, '退出微信读书登录？已下载内容会保留，自动采集将暂停。', async () => { await (await this.plugin.provider()).call('/v1/auth/session','DELETE'); await this.refresh(); }).open());
    this.status = this.contentEl.createDiv({cls:'wr-status', text:'正在连接本机采集程序…'});
    // 原生弹性布局适应 Obsidian 主面板和窄窗。
    const columns = this.contentEl.createDiv({cls:'wr-columns'});
    this.sidebar = columns.createDiv({cls:'wr-sidebar'});
    // 列表区与正文区分别滚动。
    const middle = columns.createDiv({cls:'wr-middle'});
    // 阅读筛选属于本库，不影响采集程序。
    const filters = middle.createDiv({cls:'wr-filters'});
    // 筛选器只显示当前笔记库的已读与收藏。
    const select = filters.createEl('select');
    for (const [value, text] of [['all','全部文章'],['unread','未读'],['starred','收藏'],['failed','下载失败']]) select.createEl('option', {value,text});
    select.addEventListener('change', () => { this.filter = select.value; this.renderList(); });
    // 标题搜索不把输入发送到第三方服务。
    const search = filters.createEl('input', {type:'search', placeholder:'筛选已加载标题'});
    search.addEventListener('input', () => { this.keyword = search.value; this.renderList(); });
    this.list = middle.createDiv({cls:'wr-list'});
    this.reader = columns.createDiv({cls:'wr-reader'});
    this.reader.createEl('h3', {text:'在这里安静地阅读'});
    this.reader.createEl('p', {text:'先扫码登录，粘贴一篇公众号文章链接，即可订阅近期文章。正文和图片会保存在本机；保存为笔记后可离线阅读。'});
    await this.refresh();
    if (!this.closed) this.timer = setInterval(() => { if (this.containerEl.isShown()) void this.refresh(); }, 2000);
  }
  /** 关闭面板只停止 UI 轮询，采集程序继续处理任务 */
  async onClose(): Promise<void> {
    this.closed = true;
    this.selection++;
    if (this.timer) clearInterval(this.timer);
    this.releaseResources();
  }
  /** 用户操作统一处理错误与按钮重复点击 */
  private button(parent: HTMLElement, text: string, action: () => unknown | Promise<unknown>, primary = false): HTMLButtonElement {
    // 每个用户操作在完成前禁用当前按钮。
    const button = parent.createEl('button', {text, cls:primary ? 'mod-cta' : ''});
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await action(); } catch (error) { new Notice(error instanceof Error ? error.message : '操作失败，请重试'); }
      finally { button.disabled = false; }
    });
    return button;
  }
  /** 获取状态与最新文章，未打开或未显示视图不执行轮询 */
  private async refresh(): Promise<void> {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      // 客户端由运行管理器负责健康检查与重连。
      const provider = await this.plugin.provider();
      // 状态读取互相独立，界面不访问上游文件。
      const [accounts, auth, health] = await Promise.all([provider.call<Page<Account>>('/v1/accounts'), provider.call<{loggedIn:boolean}>('/v1/auth/status'), provider.health()]);
      if (this.closed) return;
      this.accounts = accounts.items;
      this.status.setText(`${auth.loggedIn ? '已登录微信读书' : '请先扫码登录'} · 本地缓存 ${(health.diskUsed / 1048576).toFixed(1)} MB${health.browserAvailable ? '' : ' · 未检测到 Chrome/Edge，浏览器兜底不可用'}`);
      this.renderAccounts();
      await this.loadArticles(false, provider);
    } catch (error) { if (!this.closed) this.status.setText(error instanceof Error ? error.message : '连接失败，请重新连接'); }
    finally { this.polling = false; }
  }
  /** 按公众号加载分页，轮询合并已有后续页 */
  private async loadArticles(more: boolean, provider?: CollectorProvider): Promise<void> {
    // 请求序号防止快速切换订阅后的旧响应污染列表。
    const sequence = ++this.listSequence;
    // URLSearchParams 编码筛选值，避免路径插值。
    const query = new URLSearchParams({limit:'50'});
    if (this.accountId) query.set('accountId', this.accountId);
    if (more && this.cursor) query.set('cursor', this.cursor);
    // 协议返回下一页游标，不要求一次获取全部历史。
    const page = await (provider || await this.plugin.provider()).call<Page<Article>>(`/v1/articles?${query}`);
    if (sequence !== this.listSequence || this.closed) return;
    if (more) this.articles = [...this.articles, ...page.items.filter(article => !this.articles.some(existing => existing.id === article.id))];
    else {
      // 保留已经加载的后续文章，最新状态覆盖旧条目。
      const current = new Map(this.articles.map(article => [article.id, article]));
      for (const article of page.items) current.set(article.id, article);
      this.articles = [...current.values()].sort((a,b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || b.id.localeCompare(a.id));
    }
    if (more || this.articles.length <= 50) this.cursor = page.nextCursor;
    this.renderList();
  }
  /** 左侧展示真实身份、任务统计和下一次同步时间 */
  private renderAccounts(): void {
    this.sidebar.empty();
    this.button(this.sidebar, '全部公众号', async () => {this.accountId=''; this.articles=[]; this.cursor=null; await this.loadArticles(false);});
    for (const account of this.accounts) {
      // 订阅卡片显示状态而非仅以名称作为身份。
      const card = this.sidebar.createDiv({cls:`wr-account ${this.accountId === account.id ? 'is-selected' : ''}`});
      this.button(card, account.displayName, async () => {this.accountId=account.id; this.articles=[]; this.cursor=null; await this.loadArticles(false);});
      card.createEl('small', {text:account.subscribed ? (account.autoSync ? '自动订阅' : '自动同步已暂停') : '已取消订阅 · 历史保留'});
      if (account.lastJob) card.createEl('p', {text:`${STATE_LABELS[account.lastJob.state] || account.lastJob.state} · 发现 ${account.lastJob.discovered} / 正文 ${account.lastJob.succeeded} / 失败 ${account.lastJob.failed}`});
      if (account.lastJob?.error) card.createEl('p', {cls:'wr-error', text:account.lastJob.error.message});
      if (account.autoSync && account.subscribed) card.createEl('small', {text:account.blocked ? '等待处理，自动采集暂停' : `下次：${account.nextSyncAt ? new Date(account.nextSyncAt * 1000).toLocaleString() : '即将同步'}`});
      if (account.nextOffset) card.createEl('small', {text:'仍有待同步文章，将分轮继续'});
      // 同步和重试统一进入服务端队列。
      const actions = card.createDiv({cls:'wr-actions'});
      this.button(actions, '立即同步', async () => {await (await this.plugin.provider()).call(`/v1/accounts/${account.id}/sync`,'POST',{}); await this.refresh();});
      if (account.lastJob?.state === 'queued') this.button(actions, '取消排队', async () => {await (await this.plugin.provider()).call(`/v1/jobs/${account.lastJob!.id}`,'DELETE'); await this.refresh();});
      this.button(actions, '设置', () => new AccountModal(this.plugin, account, () => this.refresh()).open());
      this.button(actions, '导出 RSS', () => this.exportRss(account));
    }
    if (!this.accounts.length) this.sidebar.createEl('p', {text:'暂无订阅，点击顶部“添加公众号”。'});
  }
  /** 中栏区分发现、下载、失败与可阅读状态 */
  private renderList(): void {
    this.list.empty();
    // 当前本库的阅读状态不修改源文章数据。
    const visible = this.articles.filter(article => {
      // 收藏、已读、失败分别从对应权威状态读取。
      const state = this.plugin.data.reading[article.id] || {};
      return (!this.keyword || article.title.toLowerCase().includes(this.keyword.toLowerCase())) && (this.filter === 'all' || this.filter === 'unread' && !state.read || this.filter === 'starred' && state.starred || this.filter === 'failed' && ['temporary_failure','unavailable'].includes(article.state));
    });
    this.list.createEl('small', {text:`已加载 ${this.articles.length} 篇 · 当前显示 ${visible.length} 篇`});
    for (const article of visible) {
      // 卡片只使用 textContent 展示不可信标题和摘要。
      const card = this.list.createEl('button', {cls:`wr-article ${this.selected?.id === article.id ? 'is-selected' : ''}`});
      card.createEl('strong', {text:`${this.plugin.data.reading[article.id]?.starred ? '★ ' : ''}${article.title}`});
      card.createEl('small', {text:`${this.plugin.data.reading[article.id]?.read ? '已读' : '未读'} · ${STATE_LABELS[article.state] || article.state} · ${article.publishedAt ? new Date(article.publishedAt).toLocaleDateString() : '日期未知'}`});
      if (article.summary) card.createEl('p', {text:article.summary});
      if (article.error) card.createEl('small', {cls:'wr-error', text:article.error.message});
      card.addEventListener('click', () => { void this.openArticle(article).catch(error => new Notice(error.message)); });
    }
    if (!visible.length) this.list.createEl('p', {text:'暂无符合条件的文章。同步时会先发现标题，再下载正文。'});
    if (this.cursor) this.button(this.list, '加载更多', () => this.loadArticles(true));
  }
  /** 从鉴权接口读取全文，成功显示后才标为已读 */
  private async openArticle(summary: Article): Promise<void> {
    // 点击快速切换时仅展示最后一次请求。
    const sequence = ++this.selection;
    this.releaseResources();
    this.reader.empty();
    this.reader.createEl('p', {text:'正在读取正文…'});
    // 正文由 Provider 读取，页面不直接使用 localhost 图片地址。
    const provider = await this.plugin.provider();
    // 取得完整元数据和当前正文版本。
    const article = await provider.call<Article>(`/v1/articles/${summary.id}`);
    if (sequence !== this.selection || this.closed) return;
    this.selected = article;
    this.reader.empty();
    this.reader.createEl('h1', {text:article.title});
    this.reader.createEl('p', {cls:'wr-meta', text:`${this.accounts.find(account => account.id === article.accountId)?.displayName || ''} · ${article.publishedAt ? new Date(article.publishedAt).toLocaleString() : '发布时间未知'}`});
    // 原文地址由采集程序限制为微信文章主机。
    const link = this.reader.createEl('a', {text:'阅读原文', href:article.url});
    link.setAttribute('rel','noopener noreferrer');
    if (article.state !== 'ready') {
      this.reader.createEl('p', {cls:'wr-error', text:article.error?.message || STATE_LABELS[article.state] || '正文尚未就绪'});
      if (article.state !== 'unavailable') this.button(this.reader,'重试下载', async () => {await provider.call(`/v1/accounts/${article.accountId}/sync`,'POST',{}); await this.refresh();});
      return;
    }
    // 行为区先创建，按钮操作仍统一进行防重。
    const actions = this.reader.createDiv({cls:'wr-actions'});
    this.button(actions, this.plugin.data.reading[article.id]?.starred ? '取消收藏' : '收藏', async () => {
      // 翻转当前本库收藏，不修改共享采集数据库。
      const state = this.plugin.data.reading[article.id] ||= {};
      state.starred = !state.starred; await this.plugin.persist(); await this.openArticle(article);
    });
    this.button(actions, '保存为笔记', async () => {
      // 同一版本归档默认打开已有文件，版本更新明确提示保存副本。
      const state = this.plugin.data.reading[article.id] || {};
      if (state.archive && state.version !== article.contentVersion) {
        new ConfirmModal(this.app,'正文有更新。保存新副本会保留原笔记及其附件。',async () => {
          this.plugin.data.reading[article.id] = await archiveArticle(this.app,provider,article,this.accounts.find(account => account.id === article.accountId)?.displayName || '公众号',this.plugin.data.archiveFolder,{...state,archive:undefined});
          await this.plugin.persist();
        }).open();
        return;
      }
      this.plugin.data.reading[article.id] = await archiveArticle(this.app,provider,article,this.accounts.find(account => account.id === article.accountId)?.displayName || '公众号',this.plugin.data.archiveFolder,state);
      await this.plugin.persist(); new Notice('笔记已归档，文字与已下载图片可离线阅读');
    });
    if (article.assetState !== 'ready') this.reader.createEl('p', {text:'图片未完整，缺失图片可在原文查看；重试下载会补采正文与图片。',cls:'wr-meta'});
    if (article.assetState !== 'ready') this.button(actions, '补下载图片', async () => {await provider.call(`/v1/articles/${article.id}/retry`,'POST',{}); await this.refresh();});
    // 不可信 HTML 先在隔离 DOM 清理并替换资源，再进入阅读区。
    const document = new DOMParser().parseFromString(cleanArticle(article.html || ''),'text/html');
    for (const anchor of Array.from(document.querySelectorAll('a'))) {
      if (!/^https?:\/\//i.test(anchor.getAttribute('href') || '')) anchor.removeAttribute('href');
      anchor.setAttribute('rel','noopener noreferrer');
    }
    // 每个图片先移除上游地址，仅已知资源允许生成 blob URL。
    const imageTasks = Array.from(document.querySelectorAll('img')).map(image => {
      // src 此时仍是隔离 DOM，绝不挂载外部图片 URL。
      const id = image.getAttribute('src')?.replace(/^asset:/,'');
      image.removeAttribute('src');
      // 找到文章所有权范围内的资源。
      const asset = article.assets.find(item => item.id === id && item.state === 'ready');
      if (!asset) {image.replaceWith(document.createTextNode('[图片暂不可用]')); return null;}
      return {image, asset};
    }).filter(task => task !== null);
    // 主体使用清理后的节点，不通过 innerHTML 执行文章代码。
    const body = this.reader.createDiv({cls:'wr-content'});
    body.append(...Array.from(document.body.childNodes));
    this.plugin.data.reading[article.id] = {...this.plugin.data.reading[article.id],read:true};
    await this.plugin.persist();
    this.renderList();
    for (const task of imageTasks) {
      try {
        // 图片串行读取，切换文章后终止后续显示操作。
        const bytes = await provider.asset(article.id, task.asset);
        if (sequence !== this.selection || this.closed) return;
        // 允许的 MIME 在服务端和客户端双重限制。
        if (!['image/jpeg','image/png','image/gif','image/webp'].includes(task.asset.mime)) continue;
        // 资源 URL 不包含鉴权信息，不写入归档或设置。
        const url = URL.createObjectURL(new Blob([bytes], {type:task.asset.mime}));
        this.resources.push(url); task.image.src = url;
      } catch { task.image.replaceWith(document.createTextNode('[图片读取失败，可重试或查看原文]')); }
    }
  }
  /** 文章切换或视图卸载后及时释放图片资源 */
  private releaseResources(): void { for (const url of this.resources) URL.revokeObjectURL(url); this.resources=[]; }
  /** 导出可离线导入阅读器的 RSS 文件，重名时保留旧文件 */
  private async exportRss(account: Account): Promise<void> {
    // 文件输出走当前 Vault API，绝不把访问密钥放入订阅 URL。
    const xml = await (await this.plugin.provider()).rss(account.id);
    // RSS 放在归档根目录，避免外部绝对路径。
    const directory = archiveRoot(this.plugin.data.archiveFolder);
    // 通过适配器递归创建目录前逐段确认。
    let path = '';
    for (const part of directory.split('/')) {path = path ? `${path}/${part}` : part; if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);}
    // 使用时间戳保留历史导出文件。
    const output = normalizePath(`${directory}/${safeName(account.displayName)}-${Date.now()}.xml`);
    await this.app.vault.create(output,xml);
    new Notice(`RSS 已导出：${output}`);
  }
}

/** 用户确认后才提交订阅，不创建身份不完整的空订阅 */
class SubscribeModal extends Modal {
  /** 暂存解析成功的真实身份 */
  private resolution?: Resolution;
  /** 当前待确认的公众号显示名称 */
  private name = '';
  /** 当前粘贴的原文链接 */
  private url = '';
  /** 绑定当前库和完成回调 */
  constructor(private plugin: WeChatReaderPlugin, private done: () => Promise<void>) {super(plugin.app);}
  /** 两步引导：先解析身份，再确认名称和订阅 */
  onOpen(): void {
    this.contentEl.createEl('h2', {text:'添加公众号'});
    this.contentEl.createEl('p', {text:'粘贴任意一篇公众号文章链接。首次优先下载这篇原文，并同步近期文章，每轮最多 10 篇。'});
    new Setting(this.contentEl).setName('文章链接').addText(text => text.setPlaceholder('https://mp.weixin.qq.com/s/…').onChange(value => {this.url=value; this.resolution=undefined;}));
    // 身份展示只由已验证 API 填充。
    const identity = this.contentEl.createDiv({cls:'wr-status'});
    new Setting(this.contentEl).addButton(button => button.setButtonText('解析公众号').setCta().onClick(async () => {
      button.setDisabled(true);
      try {
        this.resolution = await (await this.plugin.provider()).call<Resolution>('/v1/accounts/resolve','POST',{url:this.url});
        this.name = this.resolution.originalName;
        identity.setText(`名称：${this.resolution.originalName} · ID：${this.resolution.bookId}。请在下方确认显示名称。`);
        nameInput.setValue(this.name === '微信公众号' ? '' : this.name);
      } catch (error) {identity.setText(error instanceof Error ? error.message : '解析失败');}
      finally {button.setDisabled(false);}
    }));
    // 显示名称可编辑，但不能充当身份主键。
    let nameInput: import('obsidian').TextComponent;
    new Setting(this.contentEl).setName('显示名称').setDesc('识别到占位名称时必须手动补充。').addText(text => {nameInput=text; text.onChange(value => {this.name=value;});});
    new Setting(this.contentEl).addButton(button => button.setButtonText('确认订阅').setCta().onClick(async () => {
      if (!this.resolution || !this.name.trim() || ['微信公众号','公众号'].includes(this.name.trim())) {new Notice('请先解析真实身份并确认显示名称'); return;}
      button.setDisabled(true);
      try {await (await this.plugin.provider()).call('/v1/accounts','POST',{resolutionId:this.resolution.resolutionId,displayName:this.name}); this.close(); await this.done();}
      catch (error) {new Notice(error instanceof Error ? error.message : '订阅失败'); button.setDisabled(false);}
    }));
  }
  /** 关闭引导时清理临时身份 */
  onClose(): void {this.resolution=undefined; this.contentEl.empty();}
}

/** 扫码会话只在模态窗口打开时轮询 */
class LoginModal extends Modal {
  /** 当前二维码会话 */
  private login?: Login;
  /** 当前二维码轮询计时器 */
  private timer?: ReturnType<typeof setInterval>;
  /** 模态窗口已关闭时不再追加图片 */
  private closed = false;
  /** 轮询防重标志 */
  private polling = false;
  /** 绑定插件的采集客户端 */
  constructor(private plugin: WeChatReaderPlugin) {super(plugin.app);}
  /** 展示登录流程并自动获取二维码 */
  onOpen(): void {
    this.contentEl.createEl('h2',{text:'微信读书扫码登录'});
    this.contentEl.createEl('p',{text:'登录凭据仅保存在本机私有目录，不写入笔记库。'});
    // 二维码容器显示服务返回的内嵌图片，不在 URL 中放密钥。
    const display = this.contentEl.createDiv({cls:'wr-login'});
    // 状态独立更新，避免二维码在轮询时闪烁。
    const status = this.contentEl.createEl('p');
    // 获取新会话前停止旧的界面轮询。
    const start = async (): Promise<void> => {
      if (this.timer) clearInterval(this.timer);
      try {
        this.login = await (await this.plugin.provider()).call<Login>('/v1/auth/login','POST',{});
        if (this.closed) return;
        display.empty();
        if (this.login.qr && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=\s]+$/.test(this.login.qr)) display.createEl('img',{attr:{src:this.login.qr,alt:'微信读书登录二维码'}});
        status.setText(LOGIN_LABELS[this.login.state] || this.login.state);
        this.timer = setInterval(async () => {
          if (this.polling || !this.login || this.closed) return;
          this.polling=true;
          try {
            this.login=await (await this.plugin.provider()).call<Login>(`/v1/auth/login/${this.login.id}`);
            if (this.closed) return;
            status.setText(LOGIN_LABELS[this.login.state] || this.login.state);
            if (['success','failed','expired'].includes(this.login.state)) {clearInterval(this.timer); display.empty();}
          } catch (error) {status.setText(error instanceof Error ? error.message : '登录状态读取失败');}
          finally {this.polling=false;}
        },2000);
      } catch (error) {status.setText(error instanceof Error ? error.message : '二维码获取失败');}
    };
    new Setting(this.contentEl).addButton(button => button.setButtonText('获取 / 刷新二维码').onClick(start));
    void start();
  }
  /** 离开窗口停止请求，服务端扫码会话按有效期自然终止 */
  onClose(): void {this.closed=true; if (this.timer) clearInterval(this.timer); this.contentEl.empty();}
}

/** 订阅设置保留历史文章，删除订阅需明确确认 */
class AccountModal extends Modal {
  /** 绑定当前公众号和刷新回调 */
  constructor(private plugin: WeChatReaderPlugin, private account: Account, private done: () => Promise<void>) {super(plugin.app);}
  /** 展示稳定身份、改名、暂停、间隔和取消订阅 */
  onOpen(): void {
    this.contentEl.createEl('h2',{text:'公众号设置'});
    this.contentEl.createEl('p',{text:`原始名称：${this.account.originalName} · 稳定 ID：${this.account.bookId}`});
    // 修改先暂存，点击保存才写入共享服务。
    let name=this.account.displayName;
    // 自动开关只影响后续调度，当前有界任务继续收尾。
    let auto=this.account.autoSync;
    // 随机同步间隔的下界。
    let minimum=this.account.intervalMin;
    // 随机同步间隔的上界。
    let maximum=this.account.intervalMax;
    new Setting(this.contentEl).setName('显示名称').addText(text=>text.setValue(name).onChange(value=>{name=value;}));
    new Setting(this.contentEl).setName('自动同步').addToggle(toggle=>toggle.setValue(auto).onChange(value=>{auto=value;}));
    new Setting(this.contentEl).setName('最短间隔（分钟）').addText(text=>text.setValue(String(minimum)).onChange(value=>{minimum=Number(value);}));
    new Setting(this.contentEl).setName('最长间隔（分钟）').addText(text=>text.setValue(String(maximum)).onChange(value=>{maximum=Number(value);}));
    new Setting(this.contentEl).addButton(button=>button.setButtonText('保存设置').setCta().onClick(async()=>{
      button.setDisabled(true);
      try {await (await this.plugin.provider()).call(`/v1/accounts/${this.account.id}`,'PATCH',{displayName:name,autoSync:auto,intervalMin:minimum,intervalMax:maximum});this.close();await this.done();}
      catch(error){new Notice(error instanceof Error ? error.message : '保存失败');button.setDisabled(false);}
    }));
    new Setting(this.contentEl).addButton(button=>button.setButtonText(this.account.subscribed ? '取消订阅' : '恢复订阅').onClick(async()=>{
      if (this.account.subscribed) new ConfirmModal(this.app,'取消订阅会停止后续自动采集，已下载文章、已读收藏及归档笔记都会保留。',async()=>{await (await this.plugin.provider()).call(`/v1/accounts/${this.account.id}/subscription`,'DELETE');this.close();await this.done();}).open();
      else {await (await this.plugin.provider()).call(`/v1/accounts/${this.account.id}`,'PATCH',{subscribed:true,autoSync:true});this.close();await this.done();}
    }));
  }
}

/** 危险程度较低但需要明确选择的业务确认窗口 */
class ConfirmModal extends Modal {
  /** 保存确认文案和已授权操作 */
  constructor(app: import('obsidian').App, private message: string, private confirm: () => Promise<void>) {super(app);}
  /** 用户可以取消或执行明确展示的操作 */
  onOpen(): void {
    this.contentEl.createEl('p',{text:this.message});
    new Setting(this.contentEl).addButton(button=>button.setButtonText('取消').onClick(()=>this.close())).addButton(button=>button.setButtonText('确认').setCta().onClick(async()=>{
      button.setDisabled(true);
      try {await this.confirm();this.close();}catch(error){new Notice(error instanceof Error ? error.message : '操作失败');button.setDisabled(false);}
    }));
  }
}
