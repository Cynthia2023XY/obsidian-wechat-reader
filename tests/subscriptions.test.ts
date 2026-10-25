import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeedService } from '../src/feeds/service';
import { portableSubscription, subscriptionArticleUrl, subscriptionForFeed, wechatAccountId } from '../src/collector/subscriptions';
import type { Account, Feed, ReaderData } from '../src/collector/types';
const id = wechatAccountId('MP_WXS_123');
const account: Account = { id, bookId: 'MP_WXS_123', platformId: 'MTIz', originalName: '原公众号', displayName: '我的公众号', subscribed: true, autoSync: false, intervalMin: 120, intervalMax: 180, nextSyncAt: 0, nextOffset: 0 };
const definition = { schemaVersion: 1, bookId: account.bookId, platformId: account.platformId, originalName: account.originalName, subscribed: true, autoSync: false, intervalMin: 120, intervalMax: 180 };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const data = (): ReaderData => ({ archiveFolder: 'RSS', reading: { article_old: { read: true, starred: true, archive: 'old.md' } }, feeds: [], wechatEnabled: true, wechatFeeds: [] });
async function serviceFor(state: ReaderData, call: ReturnType<typeof vi.fn>) {
    const directory = await mkdtemp(join(tmpdir(), 'wechat-portable-'));
    const service = new FeedService(state, directory, async () => {}, async () => ({ call }) as never);
    cleanups.push(async () => { service.dispose(); await rm(directory, { recursive: true, force: true }); });
    return service;
}
describe('可迁移公众号订阅', () => {
    it('只保存白名单公开字段，剔除票据、追踪和机器状态', () => {
        const result = portableSubscription({ ...definition, accessToken: 'secret', skey: 'private', lastJob: { key: 'bad' }, articleUrl: 'https://mp.weixin.qq.com/s/test?pass_ticket=secret&scene=1#fragment' });
        expect(result?.articleUrl).toBe('https://mp.weixin.qq.com/s/test');
        expect(JSON.stringify(result)).not.toMatch(/secret|private|lastJob|skey|pass_ticket/);
        expect(subscriptionArticleUrl('https://mp.weixin.qq.com.evil.example/s/test')).toBeUndefined();
        expect(subscriptionArticleUrl('file:///s/test')).toBeUndefined();
        expect(portableSubscription({ ...definition, platformId: 'wrong' })).toBeUndefined();
        expect(portableSubscription({ ...definition, intervalMax: 60 })).toBeUndefined();
    });
    it('旧缓存能补齐身份，只有名称或不匹配 ID 时绝不猜测', () => {
        const feed = { id, kind: 'wechat', title: account.displayName, enabled: true, intervalMinutes: 60 } as Feed;
        const article = { accountId: id, reviewId: 'MP_WXS_123_example', url: 'https://mp.weixin.qq.com/s/example' };
        expect(subscriptionForFeed(feed, [article as never])?.bookId).toBe(account.bookId);
        expect(subscriptionForFeed(feed)).toBeUndefined();
        expect(subscriptionForFeed({ ...feed, id: wechatAccountId('MP_WXS_456') }, [{ ...article, accountId: wechatAccountId('MP_WXS_456') } as never])).toBeUndefined();
    });
    it('复制笔记库配置到空服务后，扫码即可恢复，重复恢复不覆盖暂停和阅读状态', async () => {
        const first = data();
        // 创建响应与后续列表是两种接口，首次保存必须不依赖列表刷新。
        const creation = vi.fn(async (path: string, method?: string) => path === '/v1/accounts' && method === 'POST' ? { account } : path === '/v1/accounts' ? { items: [account] } : { items: [], nextCursor: null });
        const firstService = await serviceFor(first, creation);
        await firstService.subscribeWeChat({ bookId: account.bookId, platformId: account.platformId, originalName: account.originalName, resolutionId: 'test' }, 'https://mp.weixin.qq.com/s/example?pass_ticket=secret', account.displayName);
        expect(first.wechatFeeds[0].wechat).toMatchObject({ bookId: account.bookId, intervalMax: 180, autoSync: false, articleUrl: 'https://mp.weixin.qq.com/s/example' });
        const second: ReaderData = JSON.parse(JSON.stringify(first));
        let restored: Account | undefined;
        const calls = vi.fn(async (path: string, _method?: string, body?: any) => {
            if (path === '/v1/auth/status') return { loggedIn: true };
            if (path === '/v1/accounts') return { items: restored ? [restored] : [] };
            if (path === '/v1/accounts/restore') { expect(body.id).toBe(id); restored = { ...account }; return { account: restored, created: true }; }
            return { items: [], nextCursor: null };
        });
        const migrated = await serviceFor(second, calls);
        expect((await migrated.restoreSubscriptions()).restored).toBe(1);
        expect(second.wechatFeeds[0].missingLocalData).toBeUndefined();
        expect(second.wechatFeeds[0].enabled).toBe(false);
        expect(second.reading).toEqual(first.reading);
        await migrated.restoreSubscriptions();
        expect(calls.mock.calls.filter(([path]) => path === '/v1/accounts/restore')).toHaveLength(1);
        expect(JSON.stringify(second)).not.toContain('secret');
    });
    it('未登录不发起恢复，失败不会反复自动请求，手动重试仍可成功', async () => {
        const state = data();
        state.wechatFeeds = [{ id, kind: 'wechat', title: account.displayName, url: 'https://mp.weixin.qq.com/', folder: '公众号', enabled: false, intervalMinutes: 120, wechat: definition as never }];
        let loggedIn = false, failed = true;
        const calls = vi.fn(async (path: string) => {
            if (path === '/v1/auth/status') return { loggedIn };
            if (path === '/v1/accounts/restore') { if (failed) throw new Error('暂时无法连接'); return { account }; }
            return { items: [], nextCursor: null };
        });
        const service = await serviceFor(state, calls);
        expect((await service.restoreSubscriptions()).loggedIn).toBe(false);
        loggedIn = true;
        expect((await service.restoreSubscriptions()).failed).toBe(1);
        await service.restoreSubscriptions();
        expect(calls.mock.calls.filter(([path]) => path === '/v1/accounts/restore')).toHaveLength(1);
        failed = false;
        expect((await service.restoreSubscriptions(true)).restored).toBe(1);
        expect(state.wechatFeeds).toHaveLength(1);
    });
});

it('创建后的列表请求失败仍保存可迁移身份和公开原文', async () => {
    const state = data();
    const save = vi.fn(async () => {});
    const directory = await mkdtemp(join(tmpdir(), 'wechat-subscribe-offline-'));
    const call = vi.fn(async (_path: string, method?: string) => { if (method === 'POST') return { account }; throw new Error('列表暂不可用'); });
    const service = new FeedService(state, directory, save, async () => ({ call }) as never);
    cleanups.push(async () => { service.dispose(); await rm(directory, { recursive: true, force: true }); });
    await service.subscribeWeChat({ bookId: account.bookId, platformId: account.platformId, originalName: account.originalName, resolutionId: 'test' }, 'https://mp.weixin.qq.com/s/example', account.displayName);
    expect(save).toHaveBeenCalled();
    expect(state.wechatFeeds[0].wechat?.bookId).toBe(account.bookId);
    expect(state.wechatFeeds[0].wechat?.articleUrl).toBe('https://mp.weixin.qq.com/s/example');
    expect(service.lastError).toContain('订阅已保存');
});

it('已登录的新电脑启动时自动恢复缺失订阅，不需要重新添加', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const directory = await mkdtemp(join(tmpdir(), 'wechat-auto-restore-'));
    const root = join(directory, 'shared');
    await mkdir(join(root, 'runtime'), { recursive: true });
    const snapshot = { schemaVersion: 1, revision: 'empty', createdAt: Date.now(), loggedIn: true, accounts: [] as Account[], articles: [], activeAccountIds: [] };
    const path = join(root, 'runtime/schedule.json');
    await writeFile(path, JSON.stringify(snapshot));
    const state = data();
    state.wechatFeeds = [{ id, kind: 'wechat', title: account.displayName, url: 'https://mp.weixin.qq.com/', folder: '公众号', enabled: false, intervalMinutes: 120, wechat: definition as never }];
    let restored = false;
    const call = vi.fn(async (route: string) => {
        if (route === '/v1/auth/status') return { loggedIn: true };
        if (route === '/v1/accounts/restore') {
            restored = true;
            snapshot.revision = 'restored'; snapshot.accounts = [account];
            await writeFile(path, JSON.stringify(snapshot));
            return { account };
        }
        if (route === '/v1/runtime/state') return { activeJobs: [] };
        if (route === '/v1/accounts') return { items: restored ? [account] : [], nextCursor: null };
        return { items: [], nextCursor: null };
    });
    const service = new FeedService(state, directory, async () => {}, async () => ({ call }) as never, { root, session: async action => action() });
    cleanups.push(async () => { service.dispose(); await new Promise(resolve => setTimeout(resolve, 10)); await rm(directory, { recursive: true, force: true }); });
    await service.load();
    await vi.waitFor(() => expect(call.mock.calls.some(([route]) => route === '/v1/sync-due')).toBe(true));
    expect(call.mock.calls.filter(([route]) => route === '/v1/accounts/restore')).toHaveLength(1);
    expect(state.wechatFeeds[0].missingLocalData).toBeUndefined();
    expect(state.wechatFeeds[0].wechat?.autoSync).toBe(false);
});
