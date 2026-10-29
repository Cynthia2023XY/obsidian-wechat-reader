import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Article } from '../src/collector/types';
import { publishedTime } from '../src/collector/date';
import { Problem, Store } from './core';

/** 每篇共享正文的清理预览，不含本机路径。 */
export interface CleanupItem { id: string; accountId: string; bytes: number; version: string }
/** 清理预览携带每个公众号的条数和预估字节数。 */
export interface CleanupPlan { items: CleanupItem[]; accounts: Array<{ accountId: string; articles: number; bytes: number }>; bytes: number }

/** 只统计受控目录中的普通文件，拒绝符号链接。 */
function directoryBytes(path: string): number {
    // 清理预览和执行都不跟随外部链接。
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Problem('UNSAFE_CACHE', '缓存包含符号链接，无法安全清理');
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) throw new Problem('UNSAFE_CACHE', '缓存包含不支持的文件类型');
    return readdirSync(path).reduce((sum, name) => sum + directoryBytes(join(path, name)), 0);
}

/** 依据发布日期及各笔记库的保护列表生成共享正文清理预览。 */
export function planCleanup(store: Store, before: unknown, protectedIds: unknown): CleanupPlan {
    if (typeof before !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(before)) throw new Problem('INVALID_DATE', '请选择有效的清理日期');
    // 日期表示本地选择日期当天零点前的文章，使用 UTC 明确协议边界。
    const boundary = Date.parse(`${before}T00:00:00.000Z`);
    if (!Number.isFinite(boundary) || new Date(boundary).toISOString().slice(0, 10) !== before || boundary > Date.now()) throw new Problem('INVALID_DATE', '清理日期无效或晚于今天');
    if (!Array.isArray(protectedIds) || protectedIds.length > 20000 || protectedIds.some(id => typeof id !== 'string' || !/^article_[a-f0-9]{32}$/.test(id)))
        throw new Problem('INVALID_PROTECTION', '收藏和归档保护列表无效');
    // 所有已知笔记库的收藏和归档都不能清理。
    const protectedSet = new Set<string>(protectedIds);
    // 只处理数据库中已就绪且具有可靠发布时间的文章。
    const items: CleanupItem[] = [];
    for (const article of store.all<Article>('articles')) {
        // 路径只能由服务端已验证的文章身份组成。
        const published = publishedTime(article.publishedAt);
        if (!/^article_[a-f0-9]{32}$/.test(article.id) || article.state !== 'ready' || published === undefined || published >= boundary || protectedSet.has(article.id)) continue;
        // 缺失文件不计入可回收空间。
        const path = join(store.root, 'data/articles', article.id);
        if (existsSync(path)) items.push({ id: article.id, accountId: article.accountId, bytes: directoryBytes(path), version: article.contentVersion });
    }
    // 聚合到公众号，便于用户核对删除范围。
    const counts = new Map<string, { accountId: string; articles: number; bytes: number }>();
    for (const item of items) {
        // 各公众号独立统计，不暴露文章地址或本机文件路径。
        const row = counts.get(item.accountId) || { accountId: item.accountId, articles: 0, bytes: 0 };
        row.articles++; row.bytes += item.bytes; counts.set(item.accountId, row);
    }
    return { items, accounts: [...counts.values()], bytes: items.reduce((sum, item) => sum + item.bytes, 0) };
}

/** 执行前重新验证预览，保留索引、已读状态和归档文件。 */
export function executeCleanup(store: Store, plan: CleanupPlan): { articles: number; bytes: number } {
    // 清理结果只统计已完成的条目，异常时保留已安全标记的数据。
    let articles = 0, bytes = 0;
    for (const item of plan.items) {
        // 清理前先让共享索引不再宣称正文可用。
        const article = store.get<Article>('articles', item.id);
        article.state = 'evicted'; article.assetState = 'evicted'; article.assets = []; article.contentVersion = ''; article.updatedAt = new Date().toISOString();
        store.put('articles', article);
        rmSync(join(store.root, 'data/articles', item.id), { recursive: true, force: true });
        articles++; bytes += item.bytes;
    }
    return { articles, bytes };
}
