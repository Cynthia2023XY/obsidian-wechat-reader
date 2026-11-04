// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { EngineInstaller, extractEngine, type InstallerDependencies } from '../src/runtime/engine-installer';
import { engineExecutable, managedEngineDirectory } from '../src/runtime/engine-path';
import { ENGINE_PACKAGE } from '../src/runtime/engine-package';
beforeEach(() => { vi.stubGlobal('window', { setTimeout, clearTimeout }); });
const roots: string[] = [];
const platform = process.platform, arch = process.arch;
afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: platform });
    Object.defineProperty(process, 'arch', { value: arch });
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    const root = await mkdtemp(join(tmpdir(), 'wechat-install-')); roots.push(root); return root;
}
function archive(extra: Record<string, Uint8Array> = {}) {
    const prefix = 'wechat-reader/engine/wechat-reader-companion/';
    const entries: Record<string, Uint8Array> = {};
    for (const name of ['node', 'server.cjs', 'wechat-reader-companion', 'node_modules/playwright-core/package.json']) entries[prefix + name] = strToU8('fixture');
    entries[prefix + 'engine.json'] = strToU8(JSON.stringify({ engineVersion: 'ts-1', platform: 'darwin', arch: 'arm64', nodeVersion: 'v26.12.1' }));
    return zipSync({ ...entries, ...extra });
}
function deps(bytes = archive()): InstallerDependencies {
    const hash = createHash('sha256').update(bytes).digest('hex');
    return { download: vi.fn(async () => bytes), extract: (data, target) => extractEngine(data, target, hash), verify: vi.fn(async () => {}) };
}
describe('用户主动安装公众号引擎', () => {
    it('构造与状态检查不联网；仅点击安装后创建指针，保留旧引擎、设置与缓存', async () => {
        const root = await fixture();
        await writeFile(join(root, 'data.json'), 'settings');
        await mkdir(join(root, 'engine')); await writeFile(join(root, 'engine', 'old'), 'old');
        const dependencies = deps(), installer = new EngineInstaller(root, dependencies);
        expect(await installer.status()).toBe('missing'); expect(dependencies.download).not.toHaveBeenCalled();
        await installer.install(() => {});
        expect(await installer.status()).toBe('managed');
        expect(await engineExecutable(root)).toContain('wechat-engine-');
        expect(await readFile(join(root, 'data.json'), 'utf8')).toBe('settings');
        expect(await readFile(join(root, 'engine', 'old'), 'utf8')).toBe('old');
        expect((await readdir(root)).some(name => name.includes('install-'))).toBe(false);
    });
    it('校验失败不解压、不替换原指针，可重试', async () => {
        const root = await fixture();
        const pointer = JSON.stringify({ folder: 'wechat-engine-00000000-0000-0000-0000-000000000000', sha256: ENGINE_PACKAGE.sha256 });
        await writeFile(join(root, 'wechat-engine.json'), pointer);
        const dependencies = deps(); dependencies.extract = (bytes, target) => extractEngine(bytes, target);
        const installer = new EngineInstaller(root, dependencies);
        await expect(installer.install(() => {})).rejects.toThrow('校验失败');
        expect(await readFile(join(root, 'wechat-engine.json'), 'utf8')).toBe(pointer);
        expect(installer.busy).toBe(false);
        expect((await readdir(root)).filter(name => name !== 'wechat-engine.json')).toEqual([]);
        dependencies.extract = deps().extract;
        await installer.install(() => {});
        expect(await installer.status()).toBe('managed');
    });
    it('拒绝路径穿越，不写到解压目录之外', async () => {
        const root = await fixture(), bytes = archive({ 'wechat-reader/engine/wechat-reader-companion/../../escape': strToU8('bad') });
        const hash = createHash('sha256').update(bytes).digest('hex');
        await expect(extractEngine(bytes, root, hash)).rejects.toThrow('不安全路径');
        expect(await readdir(root)).toEqual([]);
    });
    it('运行验证失败时清理暂存文件，保留上次成功安装', async () => {
        const root = await fixture(), dependencies = deps(), installer = new EngineInstaller(root, dependencies);
        await installer.install(() => {}); const old = await engineExecutable(root);
        dependencies.verify = async () => { throw new Error('运行验证失败'); };
        await expect(installer.install(() => {})).rejects.toThrow('运行验证失败');
        expect(await engineExecutable(root)).toBe(old);
        expect((await readdir(root)).some(name => name.includes('install-'))).toBe(false);
    });
    it('取消安装和卸载都不会提交引擎，不允许同时启动第二次安装', async () => {
        const root = await fixture(), dependencies = deps();
        let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
        dependencies.download = (signal) => new Promise((_, reject) => { entered(); signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true }); });
        const installer = new EngineInstaller(root, dependencies);
        const first = installer.install(() => {}); const rejected = expect(first).rejects.toThrow('已取消'); await started;
        await expect(installer.install(() => {})).rejects.toThrow('正在安装');
        installer.dispose(); await rejected;
        expect(await managedEngineDirectory(root)).toBeUndefined(); expect(await readdir(root)).toEqual([]);
        await expect(installer.install(() => {})).rejects.toThrow('已卸载');
    });
    it('不支持的平台与跨实例锁阻止下载，锁不被其他安装任务删除', async () => {
        const root = await fixture(), dependencies = deps(), installer = new EngineInstaller(root, dependencies);
        Object.defineProperty(process, 'platform', { value: 'linux' });
        await expect(installer.install(() => {})).rejects.toThrow('仅支持'); expect(dependencies.download).not.toHaveBeenCalled();
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        await mkdir(join(root, 'wechat-engine-install.lock'));
        await expect(installer.install(() => {})).rejects.toThrow('已有安装任务');
        expect(await readdir(root)).toContain('wechat-engine-install.lock'); expect(dependencies.download).not.toHaveBeenCalled();
    });
});
