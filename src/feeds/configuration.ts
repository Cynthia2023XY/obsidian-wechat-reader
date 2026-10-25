import type { Feed, ReaderData } from '../collector/types';
import { portableSubscription, subscriptionForFeed, wechatAccountId } from '../collector/subscriptions';
import { digest, feedUrl } from './parser';

const FORMAT = 'wechat-reader-subscriptions';
const MAX_SIZE = 5 * 1024 * 1024;
/** 导入与导出共用白名单，运行状态和阅读记录不会进入文件。 */
function definition(value: unknown): Feed {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('订阅条目必须为对象');
    const row = value as Record<string, unknown>;
    if (!['rss', 'atom', 'wechat'].includes(String(row.kind))) throw new Error('不支持的订阅类型');
    if (typeof row.title !== 'string' || !row.title.trim() || row.title.length > 500) throw new Error('订阅名称不能为空且不得超过 500 字');
    if (typeof row.folder !== 'string' || row.folder.length > 500) throw new Error('订阅分组无效');
    if (typeof row.enabled !== 'boolean') throw new Error('自动刷新开关无效');
    if (!Number.isSafeInteger(row.intervalMinutes) || (row.intervalMinutes as number) < (row.kind === 'wechat' ? 60 : 5)) throw new Error('刷新间隔无效');
    const base = { title: row.title.trim(), folder: row.folder, enabled: row.enabled, intervalMinutes: row.intervalMinutes as number };
    if (row.kind === 'wechat') {
        const wechat = row.wechat === undefined ? undefined : portableSubscription(row.wechat);
        if (row.wechat !== undefined && !wechat) throw new Error('公众号恢复信息无效');
        if (typeof row.id !== 'string' || !/^account_[a-f0-9]{32}$/.test(row.id)) throw new Error('公众号内部身份无效');
        if (wechat && wechatAccountId(wechat.bookId) !== row.id) throw new Error('公众号恢复信息与订阅身份不一致');
        if (wechat && (base.enabled !== (wechat.subscribed && wechat.autoSync) || base.intervalMinutes !== wechat.intervalMin)) throw new Error('公众号刷新设置与恢复信息不一致');
        if (base.intervalMinutes > 1440) throw new Error('公众号间隔须在 1～24 小时内');
        return { ...base, id: row.id, kind: 'wechat', url: 'https://mp.weixin.qq.com/', wechat };
    }
    if (typeof row.url !== 'string' || row.url.length > 8192) throw new Error('RSS 地址无效');
    const url = feedUrl(row.url);
    return { ...base, id: `feed_${digest(url)}`, kind: row.kind as 'rss' | 'atom', url };
}
export function exportSubscriptionConfiguration(feeds: Feed[]): string {
    const subscriptions = feeds.map(feed => {
        const clean = definition({ ...feed, wechat: feed.kind === 'wechat' ? subscriptionForFeed(feed) : undefined });
        if (clean.kind === 'wechat') return { id: clean.id, kind: clean.kind, title: clean.title, folder: clean.folder, enabled: clean.enabled, intervalMinutes: clean.intervalMinutes, wechat: clean.wechat };
        return { kind: clean.kind, title: clean.title, folder: clean.folder, url: clean.url, enabled: clean.enabled, intervalMinutes: clean.intervalMinutes };
    });
    const result = JSON.stringify({ format: FORMAT, version: 1, exportedAt: new Date().toISOString(), subscriptions }, null, 2);
    if (subscriptions.length > 5000 || result.length > MAX_SIZE) throw new Error('订阅配置过大，暂不支持导出');
    return result;
}
export function parseSubscriptionConfiguration(text: string): Feed[] {
    if (text.length > MAX_SIZE) throw new Error('订阅配置不能超过 5 MB');
    let value: Record<string, unknown>;
    try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('订阅配置不是有效的 JSON 文件'); }
    if (!value || value.format !== FORMAT || value.version !== 1 || !Array.isArray(value.subscriptions)) throw new Error('请选择本插件导出的订阅配置（版本 1）');
    if (value.subscriptions.length > 5000) throw new Error('单次最多导入 5000 个订阅');
    return value.subscriptions.map((row, index) => {
        try { return definition(row); }
        catch (error) { throw new Error(`第 ${index + 1} 个订阅：${error instanceof Error ? error.message : '格式无效'}`); }
    });
}
export interface SubscriptionImportPlan { feeds: Feed[]; wechatFeeds: Feed[]; added: number; updated: number; skipped: number; needsLink: number; wechatAdded: number; }
/** 合并导入，已有名称/开关/分组优先，只补充缺失的恢复信息。 */
export function planSubscriptionImport(data: ReaderData, incoming: Feed[], now = Date.now()): SubscriptionImportPlan {
    const rss = new Map(data.feeds.map(feed => [feedUrl(feed.url), feed]));
    const wechat = new Map(data.wechatFeeds.map(feed => [feed.id, feed]));
    const result: SubscriptionImportPlan = { feeds: [], wechatFeeds: [], added: 0, updated: 0, skipped: 0, needsLink: 0, wechatAdded: 0 };
    for (const feed of incoming) {
        if (feed.kind !== 'wechat') {
            const key = feedUrl(feed.url);
            if (rss.has(key)) result.skipped++;
            else { rss.set(key, { ...feed, checkedAt: now }); result.added++; }
            continue;
        }
        const existing = wechat.get(feed.id);
        if (!existing) {
            wechat.set(feed.id, { ...feed, missingLocalData: true });
            result.added++; result.wechatAdded++;
            if (!feed.wechat) result.needsLink++;
        } else if (!subscriptionForFeed(existing) && feed.wechat) {
            const portable = { ...feed.wechat, subscribed: existing.enabled || feed.wechat.subscribed, autoSync: existing.enabled, intervalMin: existing.intervalMinutes, intervalMax: Math.max(existing.intervalMinutes, feed.wechat.intervalMax) };
            wechat.set(feed.id, { ...existing, wechat: portable });
            result.updated++;
        } else if (existing.wechat && !existing.wechat.articleUrl && feed.wechat?.articleUrl) {
            wechat.set(feed.id, { ...existing, wechat: { ...existing.wechat, articleUrl: feed.wechat.articleUrl } });
            result.updated++;
        } else result.skipped++;
    }
    result.feeds = [...rss.values()]; result.wechatFeeds = [...wechat.values()];
    return result;
}
