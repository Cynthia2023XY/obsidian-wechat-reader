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
