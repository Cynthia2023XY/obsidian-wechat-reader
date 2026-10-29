import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { collectCacheProtection } from '../src/cache/protection';
import type { ReaderData } from '../src/collector/types';

/** 真实文件系统夹具用于验证跨笔记库保护边界。 */
describe('共享缓存的跨库保护', () => {
    it('汇总其他已登记库的收藏和归档，缺失阅读数据时拒绝操作', async () => {
        // 所有测试文件都位于一次性临时目录。
        const root = await mkdtemp(join(tmpdir(), 'wechat-protection-'));
        try {
            // 模拟当前库与另一座安装本插件的笔记库。
            const currentVault = join(root, 'current'), otherVault = join(root, 'other');
            const plugin = join(otherVault, '.custom-config/plugins/wechat-reader');
            await mkdir(currentVault, { recursive: true }); await mkdir(plugin, { recursive: true });
            const registry = join(root, 'obsidian.json');
            await writeFile(registry, JSON.stringify({ vaults: { one: { path: currentVault }, two: { path: otherVault } } }));
            const currentId = `article_${'a'.repeat(32)}`, otherId = `article_${'b'.repeat(32)}`;
            const data = { reading: { [currentId]: { starred: true } } } as unknown as ReaderData;
            await writeFile(join(plugin, 'data.json'), JSON.stringify({ reading: { [otherId]: { archive: 'note.md' } } }));
            const result = await collectCacheProtection(registry, currentVault, data);
            expect(result.protectedIds).toEqual([currentId, otherId]);
            expect(result.otherVaults).toBe(1);
            // 其他库仍打开时不能依赖其磁盘阅读状态。
            await writeFile(registry, JSON.stringify({ vaults: { one: { path: currentVault }, two: { path: otherVault, open: true } } }));
            await expect(collectCacheProtection(registry, currentVault, data)).rejects.toThrow('关闭其他');
            await writeFile(registry, JSON.stringify({ vaults: { one: { path: currentVault }, two: { path: otherVault } } }));
            await rm(join(plugin, 'data.json'));
            await expect(collectCacheProtection(registry, currentVault, data)).rejects.toThrow('阅读记录无法读取');
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});
