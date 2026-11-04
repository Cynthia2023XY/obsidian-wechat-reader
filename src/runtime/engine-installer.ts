import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, rename, rm, chmod, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';
import { ENGINE_PACKAGE, engineSupported } from './engine-package';
import { managedEngineDirectory } from './engine-path';
import { downloadEngine } from './engine-download';

export type EngineProgress = { phase: string; received?: number };
const run = promisify(execFile);
/** 校验版本元信息和必需文件，不执行不完整安装。 */
export async function validateEngine(folder: string): Promise<void> {
    const metadata = JSON.parse(await readFile(join(folder, 'engine.json'), 'utf8')) as { engineVersion?: string; platform?: string; arch?: string; nodeVersion?: string };
    if (metadata.engineVersion !== 'ts-1' || metadata.platform !== ENGINE_PACKAGE.platform || metadata.arch !== ENGINE_PACKAGE.arch || !/^v26\./.test(metadata.nodeVersion || '')) throw new Error('引擎版本或平台不兼容');
    for (const name of ['node', 'server.cjs', 'wechat-reader-companion', 'engine.json', 'node_modules/playwright-core/package.json']) {
        const file = await lstat(join(folder, name));
        if (!file.isFile() || file.isSymbolicLink() || !file.size) throw new Error('引擎文件缺失或无效');
    }
}
/** 摘要校验后才解压；只保留引擎与许可，标准插件和用户设置不被压缩包覆盖。 */
export async function extractEngine(bytes: Uint8Array, target: string, sha256 = ENGINE_PACKAGE.sha256): Promise<void> {
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('安装包校验失败，请重试；未修改原有引擎');
    let total = 0, count = 0;
    const entries = unzipSync(bytes, { filter: file => {
        const name = file.name;
        if (name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.split('/').some(part => part === '..' || part === '.') || /^[A-Za-z]:/.test(name)) throw new Error('安装包包含不安全路径');
        const include = name.startsWith('wechat-reader/engine/wechat-reader-companion/') || name.startsWith('wechat-reader/licenses/');
        if (include) { total += file.originalSize; count++; }
        if (total > 512 * 1024 * 1024 || count > 10000) throw new Error('安装包解压大小超出限制');
        return include;
    } });
    for (const [name, content] of Object.entries(entries)) {
        if (name.endsWith('/')) continue;
        const relative = name.startsWith('wechat-reader/engine/wechat-reader-companion/') ? 'engine/' + name.slice('wechat-reader/engine/wechat-reader-companion/'.length) : name.slice('wechat-reader/'.length);
        const path = join(target, relative);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, content, { flag: 'wx', mode: 0o600 });
    }
    await validateEngine(join(target, 'engine'));
    for (const name of ['node', 'wechat-reader-companion']) await chmod(join(target, 'engine', name), 0o700);
}
export interface InstallerDependencies {
    download: typeof downloadEngine;
    extract: typeof extractEngine;
    verify: (folder: string) => Promise<void>;
}
/** 所有网络和写入都从 install 的用户点击入口开始；构造、status 和启动均不下载。 */
export class EngineInstaller {
    private controller?: AbortController;
    private disposed = false;
    constructor(private directory: string, private dependencies: InstallerDependencies = {
        download: downloadEngine,
        extract: extractEngine,
        verify: async folder => {
            const options = { timeout: 15000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin' } };
            const version = await run(join(folder, 'node'), ['--version'], options);
            if (!version.stdout.trim().startsWith('v26.')) throw new Error('引擎运行环境验证失败');
            await run(join(folder, 'node'), ['--check', join(folder, 'server.cjs')], options);
        },
    }) {}
    get busy(): boolean { return !!this.controller; }
    cancel(): void { this.controller?.abort(); }
    dispose(): void { this.disposed = true; this.cancel(); }
    async status(): Promise<'managed' | 'bundled' | 'missing'> {
        const managed = await managedEngineDirectory(this.directory);
        if (managed) { try { await validateEngine(join(managed, 'engine')); return 'managed'; } catch { /* 可重新安装修复。 */ } }
        try { await validateEngine(join(this.directory, 'engine/wechat-reader-companion')); return 'bundled'; } catch { return 'missing'; }
    }
    async install(progress: (value: EngineProgress) => void): Promise<void> {
        if (this.disposed) throw new Error('插件已卸载');
        if (!engineSupported()) throw new Error('当前公众号引擎仅支持 macOS Apple Silicon');
        if (this.busy) throw new Error('引擎正在安装，请等待完成');
        const controller = new AbortController(); this.controller = controller;
        const timer = window.setTimeout(() => controller.abort(), 180000);
        const lock = join(this.directory, 'wechat-engine-install.lock');
        let locked = false, temporary = '', final = '', committed = false, pointerTemporary = '';
        const check = () => { if (controller.signal.aborted || this.disposed) throw new Error('安装已取消或超时，可重试'); };
        try {
            try { await mkdir(lock, { mode: 0o700 }); locked = true; }
            catch { throw new Error('此插件目录已有安装任务；若上次异常退出，请关闭 Obsidian 后删除 wechat-engine-install.lock 再重试'); }
            temporary = await mkdtemp(join(this.directory, '.wechat-engine-install-'));
            progress({ phase: '正在下载', received: 0 });
            const bytes = await this.dependencies.download(controller.signal, received => progress({ phase: '正在下载', received }));
            check(); progress({ phase: '正在校验并解压' });
            await this.dependencies.extract(bytes, temporary);
            check(); progress({ phase: '正在验证运行环境' });
            await this.dependencies.verify(join(temporary, 'engine'));
            check();
            const folder = `wechat-engine-${randomUUID()}`;
            final = join(this.directory, folder);
            await rename(temporary, final); temporary = '';
            check();
            pointerTemporary = join(this.directory, `.wechat-engine-pointer-${randomUUID()}.tmp`);
            await writeFile(pointerTemporary, JSON.stringify({ folder, version: ENGINE_PACKAGE.version, sha256: ENGINE_PACKAGE.sha256 }), { mode: 0o600, flag: 'wx' });
            check();
            await rename(pointerTemporary, join(this.directory, 'wechat-engine.json'));
            committed = true;
            progress({ phase: '安装完成，可启用微信公众号并扫码登录' });
        } finally {
            window.clearTimeout(timer);
            try {
                if (temporary) await rm(temporary, { recursive: true, force: true });
                if (pointerTemporary) await rm(pointerTemporary, { force: true });
                if (final && !committed) await rm(final, { recursive: true, force: true });
                if (locked) await rm(lock, { recursive: true, force: true });
            } finally { this.controller = undefined; }
        }
    }
}
