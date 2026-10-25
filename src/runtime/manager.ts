import { spawn } from 'node:child_process';
import { readFile, access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CollectorProvider } from '../collector/types';
import { LocalCollectorClient, CollectorFailure, type Discovery } from '../collector/client';

/** 跟随 Obsidian 运行的共享采集实例管理器 */
export class RuntimeManager {
  /** 当前客户端的租约续期计时器 */
  private timer?: ReturnType<typeof setInterval>;
  /** 启动与重连共用单个异步任务，避免同一插件重复拉起 */
  private pending?: Promise<LocalCollectorClient>;
  /** 当前笔记库的客户端会话 ID */
  private clientId?: string;
  /** 当前可用的采集客户端 */
  private client?: LocalCollectorClient;
  /** 卸载时禁止未完成的启动流程重新注册租约 */
  private disposed = false;
  /** 自动恢复次数受限，持续失败后等待用户操作 */
  private restartAttempts = 0;
  private references = 0;
  private stoppingInstance = false;
  private persistent = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private disconnecting?: Promise<void>;
  private managed: CollectorProvider = {
    health: () => this.session(client => client.health()),
    call: <T>(path: string, method?: string, body?: unknown) => this.session(client => client.call<T>(path, method, body)),
    asset: (id, asset) => this.session(client => client.asset(id, asset)),
    rss: id => this.session(client => client.rss(id)),
  };
  /** 每个请求自动持有会话；返回的代理不会保留过期客户端。 */
  async connect(): Promise<CollectorProvider> {
    const release = await this.acquire();
    release();
    return this.managed;
  }
  async acquire(): Promise<() => void> {
    if (this.disposed) throw new Error('插件已卸载');
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.references++;
    try { await this.disconnecting; await this.rawConnect(); }
    catch (error) { this.references--; this.scheduleRelease(); throw error; }
    let released = false;
    return () => { if (released) return; released = true; this.references--; this.scheduleRelease(); };
  }
  async session<T>(action: (client: LocalCollectorClient) => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try { return await action(this.client!); } finally { release(); }
  }
  async setPersistent(value: boolean): Promise<void> {
    this.persistent = value;
    if (value) { const release = await this.acquire(); release(); }
    else this.scheduleRelease();
  }
  private scheduleRelease(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.references || this.persistent || this.disposed) return;
    this.idleTimer = setTimeout(() => {
      this.disconnecting = this.disconnect().finally(() => { this.disconnecting = undefined; });
    }, 15000);
  }
  private async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const client = this.client, id = this.clientId;
    this.client = undefined; this.clientId = undefined;
    try { if (client && id) await client.call(`/v1/clients/${id}`, 'DELETE'); } catch { /* 到期回收 */ }
  }
  /** 固定用户私有目录与插件安装位置 */
  constructor(private pluginDirectory: string, private onError: (message: string) => void) {}
  /** 获取或复用健康实例，并在需要时启动已封装程序 */
  private async rawConnect(): Promise<LocalCollectorClient> {
    if (this.disposed) throw new Error('插件已卸载');
    if (this.client) {
      try { await this.client.health(); return this.client; } catch { this.client = undefined; }
    }
    if (this.restartAttempts >= 3) throw new Error('采集程序连续启动失败，请点击重新连接后重试');
    if (!this.pending) this.pending = this.start().catch(error => {this.restartAttempts++; throw error;}).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  /** 明确重试时重新允许有限次数自动恢复 */
  async retry(): Promise<CollectorProvider> { this.restartAttempts = 0; return this.connect(); }
  /** 从私有发现文件验证已有实例 */
  private async discover(): Promise<LocalCollectorClient | undefined> {
    this.stoppingInstance = false;
    try {
      // 发现文件必须属于当前用户且不可被其他用户读写。
      const path = join(homedir(), 'Library/Application Support/Obsidian WeChat Reader/runtime/instance.json');
      // 防止共享目录中被篡改的发现信息泄露访问密钥。
      const info = await stat(path);
      if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('发现文件权限不安全');
      // 仅接受预期程序版本与合法实例结构。
      const discovery = JSON.parse(await readFile(path, 'utf8')) as Discovery;
      if (discovery.programId !== 'obsidian-wechat-reader-companion' || discovery.apiVersion !== 1 || discovery.engineVersion !== 'ts-1' || typeof discovery.key !== 'string' || discovery.key.length < 32) throw new Error('采集程序发现信息不兼容');
      // 端口开放并不代表程序身份正确。
      const client = new LocalCollectorClient(discovery);
      await client.health();
      return client;
    } catch (error) {
      this.stoppingInstance = error instanceof CollectorFailure && error.code === 'STOPPING';
      return undefined;
    }
  }
  /** 使用绝对可执行路径和参数数组启动，不依赖 shell 或 PATH */
  private async start(): Promise<LocalCollectorClient> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('首个内测包仅支持 macOS Apple Silicon');
    // 连续失败后有限退避，面板轮询不能触发无限重启。
    if (this.restartAttempts) await new Promise(resolve => setTimeout(resolve, Math.min(this.restartAttempts * 2000, 6000)));
    // 多笔记库优先复用已验证的共享实例。
    let client = await this.discover();
    if (!client && this.stoppingInstance) {
      // 退出中的实例仍持有独占锁，等其释放后再启动，避免新进程因抢锁退出。
      const lock = join(homedir(), 'Library/Application Support/Obsidian WeChat Reader/runtime/ts-instance.lock');
      let locked = true;
      for (let attempt = 0; attempt < 60 && !this.disposed; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        locked = await access(lock).then(() => true, () => false);
        if (!locked) break;
      }
      if (locked) throw new Error('采集程序仍在安全退出，请稍后重新连接');
      client = await this.discover();
    }
    if (!client) {
      // 安装包附属程序与插件放在同一目录。
      const executable = join(this.pluginDirectory, 'engine', 'wechat-reader-companion', 'wechat-reader-companion');
      await access(executable).catch(() => { throw new Error('缺少采集附属程序，请安装包含 engine 目录的完整内测包'); });
      // 不继承用户代理注入或 Python 路径，运行环境只来自当前进程基础变量。
      const child = spawn(executable, ['--root', join(homedir(), 'Library/Application Support/Obsidian WeChat Reader')], { detached: true, stdio: 'ignore', shell: false, env:{HOME:homedir(),PATH:'/usr/bin:/bin:/usr/sbin:/sbin',...(process.env.TMPDIR?{TMPDIR:process.env.TMPDIR}:{})} });
      // 子进程由租约管理，禁用一个插件不会直接终止其他库的采集。
      let spawnError = false;
      child.on('error', () => { spawnError = true; });
      child.unref();
      for (let attempt = 0; attempt < 60 && !this.disposed; attempt++) {
        // 约三十秒启动超时，不无限拉起失败程序。
        await new Promise(resolve => setTimeout(resolve, 500));
        if (spawnError) throw new Error('附属程序启动失败，请检查执行权限或 macOS 安全提示');
        client = await this.discover();
        if (client) break;
      }
      if (!client) throw new Error('采集程序启动超时，请重试并检查完整安装包');
    }
    if (this.disposed) throw new Error('插件已卸载');
    const health = await client.health();
    if (!health.capabilities?.includes('power-save') || !health.capabilities.includes('portable-subscriptions')) throw new Error('公众号采集程序需要升级，请安装本次包含 engine 目录的完整安装包');
    // 每个笔记库只保留当前有效租约。
    const lease = await client.call<{id: string}>('/v1/clients', 'POST', {});
    this.clientId = lease.id;
    this.client = client;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { void this.renew(); }, 25_000);
    return client;
  }
  /** 仅活跃操作或常驻模式续租；失败不擅自重启闲置服务。 */
  private async renew(): Promise<void> {
    const client = this.client, id = this.clientId;
    try { if (client && id) await client.call(`/v1/clients/${id}/renew`, 'POST', {}); }
    catch {
      if (client !== this.client) return;
      this.client = undefined;
      if (this.timer) clearInterval(this.timer);
      this.onError('采集服务连接中断，请在面板中点击重新连接');
    }
  }
  /** 卸载时释放当前库租约，其他库和在途任务继续运行 */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.pending?.catch(() => undefined);
    await this.disconnecting;
    await this.disconnect();
  }
}
