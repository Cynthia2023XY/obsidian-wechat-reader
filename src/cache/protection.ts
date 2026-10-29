import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ReaderData } from '../collector/types';

/** 所有可验证笔记库中的收藏及归档保护信息。 */
export interface CacheProtection { protectedIds: string[]; otherVaults: number }

/** 在已注册笔记库中汇总保护项，任何无法核对的库都拒绝共享清理。 */
export async function collectCacheProtection(registryPath: string, currentVault: string, current: ReaderData): Promise<CacheProtection> {
    // 不依赖用户展示名称，使用绝对路径匹配当前库。
    const registry = JSON.parse(await readFile(registryPath, 'utf8')) as { vaults?: Record<string, { path?: string; open?: boolean }> };
    if (!registry.vaults || typeof registry.vaults !== 'object') throw new Error('无法核对 Obsidian 笔记库，不能清理共享缓存');
    // 当前库状态使用内存值，避免遗漏刚保存的收藏。
    const protectedIds = new Set<string>();
    // 只保护服务端识别的公众号文章身份。
    const collect = (data: Partial<ReaderData>) => {
        if (!data.reading || typeof data.reading !== 'object' || Array.isArray(data.reading)) throw new Error('笔记库阅读状态无效，不能安全清理');
        for (const [id, state] of Object.entries(data.reading))
            if (/^article_[a-f0-9]{32}$/.test(id) && (state.starred || state.archive)) protectedIds.add(id);
    };
    collect(current);
    // 当前库必须已经登记，避免遗漏本机其他使用者。
    const entries = Object.values(registry.vaults);
    if (entries.some(vault => !vault || typeof vault.path !== 'string' || !vault.path)) throw new Error('笔记库登记信息不完整，不能清理共享缓存');
    // 已登记的库路径用于确定保护范围。
    const paths = entries.map(vault => vault.path!);
    if (!paths.some(path => resolve(path) === resolve(currentVault))) throw new Error('当前笔记库未在 Obsidian 登记，不能清理共享缓存');
    // 其他库打开时其内存状态可能尚未落盘，必须先关闭才能核对。
    if (entries.some(vault => resolve(vault.path!) !== resolve(currentVault) && vault.open)) throw new Error('请先关闭其他已打开的 Obsidian 笔记库');
    // 被登记但不可访问的库可能含收藏，必须先恢复访问。
    let otherVaults = 0;
    for (const path of new Set(paths.map(value => resolve(value)))) {
        if (path === resolve(currentVault)) continue;
        await stat(path).catch(() => { throw new Error('其他已登记笔记库无法访问，不能核对收藏和归档'); });
        // 在库根目录检查可能的自定义配置目录，避免只检查默认目录。
        const directories = await readdir(path, { withFileTypes: true }).catch(() => { throw new Error('无法读取其他笔记库的配置目录'); });
        // 同一笔记库可能有多个配置目录，只计数一次。
        let installed = false;
        // 逐个核对可能包含插件的配置目录。
        for (const directory of directories) {
            if (!directory.isDirectory() && !directory.isSymbolicLink()) continue;
            // 仅检查目录下的插件位置，不读取其他插件或笔记。
            const plugin = join(path, directory.name, 'plugins', 'wechat-reader');
            try { await stat(plugin); } catch (error) {
                if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) continue;
                throw new Error('无法核对其他笔记库的插件数据');
            }
            // 已安装插件的库必须能完整读取其阅读记录。
            let saved: Partial<ReaderData>;
            try { saved = JSON.parse(await readFile(join(plugin, 'data.json'), 'utf8')) as Partial<ReaderData>; }
            catch { throw new Error('其他笔记库的阅读记录无法读取，不能清理共享缓存'); }
            collect(saved); installed = true;
        }
        if (installed) otherVaults++;
    }
    return { protectedIds: [...protectedIds].sort(), otherVaults };
}
