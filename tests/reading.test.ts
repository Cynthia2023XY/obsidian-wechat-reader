import { describe, it, expect, vi } from 'vitest';
import { ReadingStore } from '../src/reading/state';
import { intervalHours, intervalMinutes } from '../src/feeds/interval';
import type { ReaderData } from '../src/collector/types';
function setup() {
    const data: ReaderData = { archiveFolder: 'RSS', reading: { a: { starred: true, archive: 'a.md', version: 'v1' } }, feeds: [], wechatFeeds: [], wechatEnabled: false };
    const save = vi.fn(async () => {}), changed = vi.fn();
    return { data, save, changed, store: new ReadingStore(data, save, changed) };
}
describe('批量阅读状态', () => {
    it('一次保存覆盖所有目标，保留收藏归档，撤销只恢复阅读值', async () => {
        const { data, store, save } = setup();
        expect(await store.set(['a', 'b', 'a'], true)).toBe(2);
        expect(save).toHaveBeenCalledTimes(1);
        expect(data.reading.a).toEqual({ read: true, starred: true, archive: 'a.md', version: 'v1' });
        data.reading.b.starred = true;
        expect(await store.undo()).toBe(true);
        expect(data.reading.b).toEqual({ starred: true });
        expect(data.reading.a.read).toBeUndefined();
    });
    it('后续操作使旧撤销失效，手动未读阻止迟到的自动已读', async () => {
        const { data, store } = setup();
        await store.set(['a'], true);
        const token = store.undoToken, revision = store.revision('a');
        await store.set(['a'], false);
        expect(await store.undo(token)).toBe(false);
        expect(await store.set(['a'], true, false, revision)).toBe(0);
        expect(data.reading.a.read).toBe(false);
    });
    it('保存失败回滚，后续操作仍能成功', async () => {
        const { data, store, save } = setup();
        save.mockRejectedValueOnce(new Error('磁盘失败'));
        await expect(store.set(['a', 'b'], true)).rejects.toThrow('磁盘失败');
        expect(data.reading.a.read).toBeUndefined();
        expect(data.reading.a.starred).toBe(true);
        expect(await store.set(['a'], true)).toBe(1);
    });
    it('小时输入往返保留旧分钟值并拒绝非法值', () => {
        for (const minutes of [5, 60, 90, 120, 1440]) expect(intervalMinutes(intervalHours(minutes))).toBe(minutes);
        expect(intervalMinutes('1.5', 60, 1440)).toBe(90);
        for (const value of ['', 'NaN', '-1', '0', '0.01']) expect(() => intervalMinutes(value)).toThrow();
        expect(() => intervalMinutes('25', 60, 1440)).toThrow();
    });
});

describe('全部已读时间基准', () => {
    it('后续回补旧公众号文章不变成未读，手动未读和未知时间优先', async () => {
        // 在隔离状态中模拟清零前后的文章加载。
        const { data, store } = setup();
        // 只有公众号文章使用历史基准。
        const old = { id: 'article_old', publishedAt: '2024-01-01T00:00:00Z' } as import('../src/collector/types').Article;
        const unknown = { id: 'article_unknown', publishedAt: null } as import('../src/collector/types').Article;
        const fresh = { id: 'article_fresh', publishedAt: '2100-01-01T00:00:00Z' } as import('../src/collector/types').Article;
        await store.markAll([]);
        expect(store.isRead(old)).toBe(true);
        expect(store.isRead(unknown)).toBe(false);
        expect(store.isRead({ ...unknown, publishedAt: '2024' })).toBe(false);
        expect(store.isRead({ ...unknown, publishedAt: '2024-02-30T00:00:00Z' })).toBe(false);
        expect(store.isRead(fresh)).toBe(false);
        // 手动未读必须能覆盖隐式已读。
        const withLookup = new ReadingStore(data, async () => {}, () => {}, id => id === old.id ? old : undefined);
        await withLookup.set([old.id], false);
        expect(withLookup.isRead(old)).toBe(false);
        // 持久化内容可用于重启后的判断。
        const restarted = new ReadingStore(JSON.parse(JSON.stringify(data)), async () => {}, () => {});
        expect(restarted.isRead(old)).toBe(false);
        expect(restarted.isRead({ ...old, id: 'article_other' })).toBe(true);
    });
    it('撤销全部已读同时恢复基准与具体文章状态', async () => {
        // 模拟先前已存在的历史基准。
        const { data, store } = setup();
        data.readBefore = 1000;
        await store.markAll([{ id: 'a' } as import('../src/collector/types').Article]);
        expect(data.reading.a.read).toBe(true);
        expect(data.readBefore).toBeGreaterThan(1000);
        expect(await store.undo()).toBe(true);
        expect(data.readBefore).toBe(1000);
        expect(data.reading.a.read).toBeUndefined();
    });
});
