import { spawn } from 'node:child_process';
import { readFile, access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PythonCollectorClient, type Discovery } from '../collector/client';

/** 跟随 Obsidian 运行的共享采集实例管理器 */
export class RuntimeManager {
  /** 当前客户端的租约续期计时器 */
  private timer?: ReturnType<typeof setInterval>;
  /** 启动与重连共用单个异步任务，避免同一插件重复拉起 */
  private pending?: Promise<PythonCollectorClient>;
  /** 当前笔记库的客户端会话 ID */
  private clientId?: string;
  /** 当前可用的采集客户端 */
  private client?: PythonCollectorClient;
  /** 卸载时禁止未完成的启动流程重新注册租约 */
  private disposed = false;
  /** 自动恢复次数受限，持续失败后等待用户操作 */
  private restartAttempts = 0;
  /** 固定用户私有目录与插件安装位置 */
  constructor(private pluginDirectory: string, private onError: (message: string) => void) {}
  /** 获取或复用健康实例，并在需要时启动已封装程序 */
  async connect(): Promise<PythonCollectorClient> {
    if (this.disposed) throw new Error('插件已卸载');
    if (this.client) {
      try { await this.client.health(); return this.client; } catch { this.client = undefined; }
    }
    if (this.restartAttempts >= 3) throw new Error('采集程序连续启动失败，请点击重新连接后重试');
    if (!this.pending) this.pending = this.start().catch(error => {this.restartAttempts++; throw error;}).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  /** 明确重试时重新允许有限次数自动恢复 */
  async retry(): Promise<PythonCollectorClient> { this.restartAttempts = 0; return this.connect(); }
  /** 从私有发现文件验证已有实例 */
  private async discover(): Promise<PythonCollectorClient | undefined> {
    try {
      // 发现文件必须属于当前用户且不可被其他用户读写。
      const path = join(homedir(), 'Library/Application Support/Obsidian WeChat Reader/runtime/instance.json');
      // 防止共享目录中被篡改的发现信息泄露访问密钥。
      const info = await stat(path);
      if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('发现文件权限不安全');
      // 仅接受预期程序版本与合法实例结构。
      const discovery = JSON.parse(await readFile(path, 'utf8')) as Discovery;
      if (discovery.programId !== 'obsidian-wechat-reader-companion' || discovery.apiVersion !== 1 || discovery.engineVersion !== '0.1.0' || typeof discovery.key !== 'string' || discovery.key.length < 32) throw new Error('采集程序发现信息不兼容');
      // 端口开放并不代表程序身份正确。
      const client = new PythonCollectorClient(discovery);
      await client.health();
      return client;
    } catch { return undefined; }
  }
  /** 使用绝对可执行路径和参数数组启动，不依赖 shell 或 PATH */
  private async start(): Promise<PythonCollectorClient> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('首个内测包仅支持 macOS Apple Silicon');
    // 连续失败后有限退避，面板轮询不能触发无限重启。
    if (this.restartAttempts) await new Promise(resolve => setTimeout(resolve, Math.min(this.restartAttempts * 2000, 6000)));
    // 多笔记库优先复用已验证的共享实例。
    let client = await this.discover();
    if (!client) {
      // 安装包附属程序与插件放在同一目录。
      const executable = join(this.pluginDirectory, 'engine', 'wechat-reader-companion', 'wechat-reader-companion');
      await access(executable).catch(() => { throw new Error('缺少采集附属程序，请安装包含 engine 目录的完整内测包'); });
      // 不继承用户代理注入或 Python 路径，运行环境只来自当前进程基础变量。
      const child = spawn(executable, ['--root', join(homedir(), 'Library/Application Support/Obsidian WeChat Reader')], { detached: true, stdio: 'ignore', shell: false });
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
    // 每个笔记库只保留当前有效租约。
    const lease = await client.call<{id: string}>('/v1/clients', 'POST', {});
    this.clientId = lease.id;
    this.client = client;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { void this.renew(); }, 25_000);
    return client;
  }
  /** 定期续租；服务崩溃时最多尝试两次恢复 */
  private async renew(): Promise<void> {
    try { await this.client?.call(`/v1/clients/${this.clientId}/renew`, 'POST', {}); }
    catch {
      this.client = undefined;
      if (this.timer) clearInterval(this.timer);
      if (++this.restartAttempts <= 2 && !this.disposed) {
        try { await this.connect(); } catch { this.onError('采集服务连接中断，请在面板中点击重新连接'); }
      } else this.onError('采集服务持续不可用，请在面板中手动重试');
    }
  }
  /** 卸载时释放当前库租约，其他库和在途任务继续运行 */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    try { if (this.client && this.clientId) await this.client.call(`/v1/clients/${this.clientId}`, 'DELETE'); } catch { /* 服务已退出时由租约到期回收。 */ }
    this.client = undefined;
  }
}
