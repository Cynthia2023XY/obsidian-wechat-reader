import { describe, expect, it, vi } from 'vitest';
import { retainReaderLeaf } from '../src/views/layout';
import type { WorkspaceLeaf } from 'obsidian';

/** 模拟布局标签，不加载真实工作区或影响用户窗口 */
const leaf = () => ({ detach: vi.fn() } as unknown as WorkspaceLeaf);
describe('阅读侧栏恢复与去重', () => {
    it('尚未恢复或只有一个阅读标签时不关闭视图', () => {
        // 空布局交由首次打开流程创建右侧栏。
        const single = leaf();
        expect(retainReaderLeaf([])).toBeUndefined();
        expect(retainReaderLeaf([single])).toBe(single);
        expect(single.detach).not.toHaveBeenCalled();
    });
    it('旧标签晚于新标签恢复时保留当前阅读标签', () => {
        // 重载后的旧标签不能使新标签和阅读位置丢失。
        const restored = leaf(), current = leaf();
        expect(retainReaderLeaf([restored, current], current)).toBe(current);
        expect(restored.detach).toHaveBeenCalledOnce();
        expect(current.detach).not.toHaveBeenCalled();
    });
    it('用户移动标签或关闭原标签后保留剩余标签的位置', () => {
        // 整理只合并重复项，不重新创建右侧栏覆盖用户拖动结果。
        const removed = leaf(), moved = leaf(), duplicate = leaf();
        expect(retainReaderLeaf([moved, duplicate], removed)).toBe(moved);
        expect(moved.detach).not.toHaveBeenCalled();
        expect(duplicate.detach).toHaveBeenCalledOnce();
        expect(removed.detach).not.toHaveBeenCalled();
    });
});
