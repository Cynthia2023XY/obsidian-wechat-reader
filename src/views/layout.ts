import type { WorkspaceLeaf } from 'obsidian';

/** 保留当前阅读标签，合并 Obsidian 异步恢复造成的重复视图 */
export function retainReaderLeaf(leaves: WorkspaceLeaf[], preferred?: WorkspaceLeaf): WorkspaceLeaf | undefined {
    // 优先保留本次打开或用户正在使用的标签，不改变其停靠位置。
    const retained = preferred && leaves.includes(preferred) ? preferred : leaves[0];
    // 只关闭同类型的多余标签，不操作笔记和其他插件视图。
    for (const leaf of leaves) if (leaf !== retained) leaf.detach();
    return retained;
}
