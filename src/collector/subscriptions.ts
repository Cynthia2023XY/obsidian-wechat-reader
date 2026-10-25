import { createHash } from 'node:crypto';
import type { Account, Article, Feed, WeChatSubscription } from './types';

/** 稳定公众号 ID 与既有共享数据库保持一致。 */
export function wechatAccountId(bookId: string): string {
    return `account_${createHash('sha256').update(bookId).digest('hex').slice(0, 32)}`;
}
/** 仅保存公开原文定位参数，排除 Cookie、票据和分享追踪参数。 */
export function subscriptionArticleUrl(value?: string): string | undefined {
    if (!value) return;
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'mp.weixin.qq.com' || url.port || url.username || url.password || !/^\/s(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname)) return;
        const clean = new URL(`https://mp.weixin.qq.com${url.pathname}`);
        for (const name of ['__biz', 'mid', 'idx', 'sn', 'chksm']) {
            const parameter = url.searchParams.get(name);
            if (parameter) clean.searchParams.set(name, parameter);
        }
        if (url.pathname === '/s' && !clean.searchParams.has('__biz')) return;
        return clean.href;
    } catch { return; }
}
/** 白名单转换避免将共享账户对象或凭据直接写入笔记库。 */
export function portableSubscription(value: unknown): WeChatSubscription | undefined {
    if (!value || typeof value !== 'object') return;
    const input = value as Record<string, unknown>;
    if (input.schemaVersion !== 1 || typeof input.bookId !== 'string' || !/^MP_WXS_\d{1,20}$/.test(input.bookId)) return;
    const platformId = Buffer.from(input.bookId.slice(7)).toString('base64');
    if (input.platformId !== platformId || typeof input.originalName !== 'string' || !input.originalName.trim() || input.originalName.length > 120) return;
    if (typeof input.subscribed !== 'boolean' || typeof input.autoSync !== 'boolean') return;
    const minimum = input.intervalMin as number, maximum = input.intervalMax as number;
    if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 60 || maximum < minimum || maximum > 1440) return;
    const articleUrl = typeof input.articleUrl === 'string' ? subscriptionArticleUrl(input.articleUrl) : undefined;
    return { schemaVersion: 1, bookId: input.bookId, platformId, originalName: input.originalName.trim(), articleUrl, subscribed: input.subscribed, autoSync: input.autoSync, intervalMin: minimum, intervalMax: maximum };
}
export function subscriptionFromAccount(account: Account, articleUrl?: string): WeChatSubscription | undefined {
    return portableSubscription({ schemaVersion: 1, bookId: account.bookId, platformId: account.platformId, originalName: account.originalName || account.displayName, articleUrl: account.articleUrl || articleUrl, subscribed: account.subscribed, autoSync: account.autoSync, intervalMin: account.intervalMin, intervalMax: account.intervalMax });
}
/** 旧本库缓存有 reviewId 或长链时可补齐身份，绝不通过名称猜测。 */
export function subscriptionForFeed(feed: Feed, articles: Article[] = []): WeChatSubscription | undefined {
    const saved = portableSubscription(feed.wechat);
    if (saved && wechatAccountId(saved.bookId) === feed.id) return saved;
    for (const article of articles) {
        if (article.accountId !== feed.id) continue;
        let numeric = article.reviewId?.match(/^MP_WXS_(\d+)_/)?.[1];
        if (!numeric) {
            try { const biz = new URL(article.url).searchParams.get('__biz'); if (biz) numeric = Buffer.from(biz, 'base64').toString(); } catch { /* 无可用公开身份。 */ }
        }
        if (!numeric || !/^\d{1,20}$/.test(numeric)) continue;
        const bookId = `MP_WXS_${numeric}`;
        if (wechatAccountId(bookId) !== feed.id) continue;
        return portableSubscription({ schemaVersion: 1, bookId, platformId: Buffer.from(numeric).toString('base64'), originalName: feed.title, articleUrl: article.url, subscribed: true, autoSync: feed.enabled, intervalMin: Math.max(60, feed.intervalMinutes), intervalMax: Math.max(60, feed.intervalMinutes) });
    }
}
export function missingSubscriptionMessage(feed: Feed): string {
    return subscriptionForFeed(feed)
        ? '本机尚未恢复此公众号；登录后会自动恢复订阅，文章将重新拉取。'
        : '此旧订阅缺少恢复信息，请右键“补充恢复链接”填写任意一篇原文；之后换电脑只需重新扫码。';
}
