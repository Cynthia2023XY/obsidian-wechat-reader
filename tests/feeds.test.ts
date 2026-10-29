import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as obsidian from 'obsidian';
import { FeedService } from '../src/feeds/service';
import { feedUrl, parseFeed, parseOpml } from '../src/feeds/parser';
import type { Feed, ReaderData } from '../src/collector/types';
/** 不访问真实订阅或登录服务的 XML 样例 */
const rss = (items: string) => `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>测试订阅</title>${items}</channel></rss>`;
/** 相同标题用于证明身份不依赖标题 */
const item = (id: string, body = '<p>正文<img src="/image.png"/></p>') => `<item><guid>${id}</guid><title>相同标题</title><link>https://example.com/posts/${id}</link><content:encoded><![CDATA[${body}]]></content:encoded></item>`;
/** 独立源对象，显示名称与身份分离 */
const fixture = (): Feed => ({ id: 'fixture', kind: 'rss', title: '名称', url: 'https://example.com/feed', folder: '订阅', enabled: true, intervalMinutes: 60 });
/** 测试目录与服务在每个用例后统一清理 */
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0))
    await cleanup(); });
describe('RSS、Atom 与 OPML 规范化', () => {
    it('GUID 按源隔离，相同标题不合并，图片使用受控占位', () => {
        // GUID 按源隔离，相同标题不合并，图片使用受控占位所需的隔离输入、依赖或断言结果。
        const feed = fixture();
        // GUID 按源隔离，相同标题不合并，图片使用受控占位所需的隔离输入、依赖或断言结果。
        const parsed = parseFeed(rss(item('a') + item('b')), feed);
        expect(parsed.articles).toHaveLength(2);
        expect(parsed.articles[0].publishedAt).toBeNull();
        expect(parsed.articles[0].assets[0].sourceUrl).toBe('https://example.com/image.png');
        expect(parsed.articles[0].html).toContain('asset:');
        expect(parseFeed(rss(item('a')), { ...feed, id: 'other' }).articles[0].id).not.toBe(parsed.articles[0].id);
        expect(parseFeed(rss(item('a') + item('a')), feed).articles).toHaveLength(1);
    });
    it('摘要明确标识；Atom 默认 text 不能作为 HTML 执行', () => {
        // 摘要明确标识；Atom 默认 text 不能作为 HTML 执行所需的隔离输入、依赖或断言结果。
        const summary = parseFeed(rss('<item><guid>x</guid><description>摘要</description></item>'), fixture()).articles[0];
        expect(summary.contentKind).toBe('summary');
        // 摘要明确标识；Atom 默认 text 不能作为 HTML 执行所需的隔离输入、依赖或断言结果。
        const atom = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>x</id><content>&lt;script&gt;literal&lt;/script&gt;</content></entry></feed>', fixture()).articles[0];
        expect(atom.html).toContain('&lt;script&gt;');
        expect(atom.html).not.toContain('<script>');
    });
    it('Atom 继承 xml:base 并解析 XHTML 摘要、发布时间', () => {
        // 本次操作所属的文章，不复用界面稍后的选择。
        const article = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://example.org/"><entry xml:base="posts/"><id>1</id><link href="one"/><published>2024-01-02T00:00:00Z</published><summary type="xhtml" xml:base="media/"><div xmlns="http://www.w3.org/1999/xhtml"><p>摘要<img src="a.png"/></p></div></summary></entry></feed>', fixture()).articles[0];
        expect(article.url).toBe('https://example.org/posts/one');
        expect(article.assets[0].sourceUrl).toBe('https://example.org/posts/media/a.png');
        expect(article.publishedAt).toBe('2024-01-02T00:00:00.000Z');
    });
    it('拒绝错误 XML、网页和外部实体，不清理有效的查询鉴权', () => {
        for (const xml of ['<html/>', '<rss>', '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>'])
            expect(() => parseFeed(xml, fixture())).toThrow();
        expect(() => feedUrl('file:///etc/passwd')).toThrow();
        expect(feedUrl('https://EXAMPLE.com:443/rss?token=abc#x')).toBe('https://example.com/rss?token=abc');
    });
    it('OPML 预览保留多层分组、已有源重复与无效地址', () => {
        // OPML 预览保留多层分组、已有源重复与无效地址所需的隔离输入、依赖或断言结果。
        const rows = parseOpml('<opml><body><outline text="技术"><outline text="工具"><outline xmlUrl="https://example.com/feed"/><outline xmlUrl="https://new.example/rss"/><outline xmlUrl="https://new.example/rss#x"/><outline xmlUrl="javascript:bad"/></outline></outline></body></opml>', [fixture()]);
        expect(rows.map(row => row.duplicate)).toEqual([true, false, true, undefined]);
        expect(rows[0].folder).toBe('技术/工具');
        expect(rows[3].error).toBeTruthy();
    });
});
describe('普通 RSS 的独立缓存与刷新', () => {
    /** 每个用例使用独立磁盘，连接函数不能被普通 RSS 触发 */
    async function setup() {
        // 普通 RSS 的独立缓存与刷新所需的隔离输入、依赖或断言结果。
        const directory = await mkdtemp(join(tmpdir(), 'rss-feed-test-'));
        // 当前官方接口返回的业务数据。
        const data: ReaderData = { archiveFolder: 'RSS', reading: {}, feeds: [], wechatEnabled: false, wechatFeeds: [] };
        // 普通 RSS 的独立缓存与刷新所需的隔离输入、依赖或断言结果。
        const connect = vi.fn().mockRejectedValue(new Error('普通 RSS 不应启动引擎'));
        // 普通 RSS 的独立缓存与刷新所需的隔离输入、依赖或断言结果。
        const service = new FeedService(data, directory, async () => { }, connect);
        cleanups.push(async () => { service.dispose(); await rm(directory, { recursive: true, force: true }); });
        return { service, data, connect, directory };
    }
    it('正常添加、重命名与重复导入均保持源 ID，无需公众号引擎', async () => {
        // 正常添加、重命名与重复导入均保持源 ID，无需公众号引擎所需的隔离输入、依赖或断言结果。
        const { service, connect } = await setup();
        // 正常添加、重命名与重复导入均保持源 ID，无需公众号引擎所需的隔离输入、依赖或断言结果。
        const network = vi.spyOn(obsidian, 'requestUrl').mockResolvedValue({ status: 200, text: rss(item('1')), headers: {} } as never);
        // 正常添加、重命名与重复导入均保持源 ID，无需公众号引擎所需的隔离输入、依赖或断言结果。
        const feed = await service.add('https://example.com/feed');
        await service.update(feed, { title: '新名称', folder: '新分组' });
        expect(await service.add('https://example.com/feed#different')).toBe(feed);
        expect(network).toHaveBeenCalledTimes(1);
        expect(connect).not.toHaveBeenCalled();
        expect(service.articles()[0].accountId).toBe(feed.id);
    });
    it('304 与失败保留旧正文，增量合并不丢失已读状态', async () => {
        // 304 与失败保留旧正文，增量合并不丢失已读状态所需的隔离输入、依赖或断言结果。
        const { service, data } = await setup();
        // 304 与失败保留旧正文，增量合并不丢失已读状态所需的隔离输入、依赖或断言结果。
        const network = vi.spyOn(obsidian, 'requestUrl').mockResolvedValue({ status: 200, text: rss(item('old')), headers: { ETag: 'v1' } } as never);
        // 304 与失败保留旧正文，增量合并不丢失已读状态所需的隔离输入、依赖或断言结果。
        const feed = await service.add('https://example.com/feed');
        // 304 与失败保留旧正文，增量合并不丢失已读状态所需的隔离输入、依赖或断言结果。
        const old = service.articles()[0];
        data.reading[old.id] = { read: true, starred: true };
        network.mockResolvedValueOnce({ status: 304, headers: {} } as never);
        await service.refresh(feed);
        expect(service.articles()).toHaveLength(1);
        expect((network.mock.calls.at(-1)![0] as any).headers['If-None-Match']).toBe('v1');
        network.mockResolvedValueOnce({ status: 500, headers: {} } as never);
        await expect(service.refresh(feed)).rejects.toThrow('500');
        expect(service.articles()[0].html).toBe(old.html);
        network.mockResolvedValueOnce({ status: 200, text: rss(item('new')), headers: {} } as never);
        await service.refresh(feed);
        expect(service.articles()).toHaveLength(2);
        expect(data.reading[old.id]).toEqual({ read: true, starred: true });
        expect(feed.error).toBeUndefined();
    });
    it('恢复前台按实际到期刷新一次，错过多个周期不补跑', async () => {
        const { service, connect } = await setup();
        const network = vi.spyOn(obsidian, 'requestUrl').mockResolvedValue({ status: 200, text: rss(item('1')), headers: {} } as never);
        const feed = await service.add('https://example.com/feed');
        feed.checkedAt = Date.now() - 10 * 3600000;
        network.mockClear();
        await service.resume();
        await service.resume();
        expect(network).toHaveBeenCalledTimes(1);
        expect(connect).not.toHaveBeenCalled();
    });
    it('并发刷新共享请求，图片 MIME 在刷新和重载后保持一致', async () => {
        // 并发刷新共享请求，图片 MIME 在刷新和重载后保持一致所需的隔离输入、依赖或断言结果。
        const { service, data, directory, connect } = await setup();
        // 并发刷新共享请求，图片 MIME 在刷新和重载后保持一致所需的隔离输入、依赖或断言结果。
        const network = vi.spyOn(obsidian, 'requestUrl').mockResolvedValue({ status: 200, text: rss(item('1')), headers: {} } as never);
        // 并发刷新共享请求，图片 MIME 在刷新和重载后保持一致所需的隔离输入、依赖或断言结果。
        const feed = await service.add('https://example.com/feed');
        // 本次操作所属的文章，不复用界面稍后的选择。
        const article = service.articles()[0];
        network.mockResolvedValueOnce({ status: 200, headers: { 'Content-Type': 'image/png' }, arrayBuffer: new Uint8Array([1, 2, 3]).buffer } as never);
        await service.contentProvider().asset(article.id, { ...article.assets[0], sourceUrl: 'https://forged.invalid/' });
        expect((network.mock.calls.at(-1)![0] as any).url).toBe('https://example.com/image.png');
        network.mockResolvedValue({ status: 200, text: rss(item('1')), headers: {} } as never);
        network.mockClear();
        await Promise.all([service.refresh(feed), service.refresh(feed)]);
        expect(network).toHaveBeenCalledTimes(1);
        expect(service.articles()[0].assets[0].mime).toBe('image/png');
        service.dispose();
        // 并发刷新共享请求，图片 MIME 在刷新和重载后保持一致所需的隔离输入、依赖或断言结果。
        const reloaded = new FeedService(data, directory, async () => { }, connect);
        await reloaded.load();
        reloaded.dispose();
        await reloaded.contentProvider().asset(article.id, reloaded.articles()[0].assets[0]);
        expect(network).toHaveBeenCalledTimes(1);
        expect(reloaded.articles()[0].assets[0].mime).toBe('image/png');
    });
});

describe('公众号省电阅读缓存', () => {
    it('本地索引重开不启动服务，首次补读后正文和图片离线复用', async () => {
        const { mkdir, writeFile } = await import('node:fs/promises');
        const directory = await mkdtemp(join(tmpdir(), 'wechat-cache-test-'));
        const root = join(directory, 'shared');
        await mkdir(join(root, 'runtime'), { recursive: true });
        const article = { id: 'article_test', accountId: 'account_test', title: '缓存正文', url: 'https://mp.weixin.qq.com/s/test', publishedAt: null, summary: '', state: 'ready', assetState: 'ready', contentVersion: 'v1', assets: [{ id: 'image', state: 'ready', mime: 'image/png' }] };
        const snapshot = { schemaVersion: 1, revision: 'v1', createdAt: Date.now(), loggedIn: true, accounts: [{ id: 'account_test', displayName: '公众号', subscribed: true, autoSync: true, nextSyncAt: Date.now() / 1000 + 7200, intervalMin: 120 }], articles: [article], activeAccountIds: [] };
        await writeFile(join(root, 'runtime/schedule.json'), JSON.stringify(snapshot));
        const data: ReaderData = { archiveFolder: 'RSS', reading: {}, feeds: [], wechatFeeds: [], wechatEnabled: true };
        const provider = { call: vi.fn(async () => ({ ...article, html: '<p>缓存正文</p>' })), asset: vi.fn(async () => new Uint8Array([1,2,3]).buffer) };
        const connect = vi.fn(async () => provider as never);
        const hooks = { root, session: async <T>(action: () => Promise<T>) => action() };
        const service = new FeedService(data, directory, async () => {}, connect, hooks);
        cleanups.push(async () => { service.dispose(); await rm(directory, { recursive: true, force: true }); });
        await service.load();
        expect(service.articles()).toHaveLength(1);
        expect(connect).not.toHaveBeenCalled();
        expect((await service.article(article.id)).html).toContain('缓存正文');
        await service.contentProvider().asset(article.id, article.assets[0]);
        service.dispose();
        // 共享正文被清理后，本库已缓存的正文与图片仍应离线可读。
        await writeFile(join(root, 'runtime/schedule.json'), JSON.stringify({ ...snapshot, revision: 'evicted', articles: [{ ...article, state: 'evicted', assetState: 'evicted', assets: [], contentVersion: '' }] }));
        connect.mockRejectedValue(new Error('不应启动引擎') as never);
        const reload = new FeedService(data, directory, async () => {}, connect, hooks);
        cleanups.push(async () => reload.dispose());
        await reload.load();
        const calls = connect.mock.calls.length;
        // 使用正文携带的版本证明图片来自同一旧缓存。
        const cached = await reload.article(article.id);
        expect(cached.html).toContain('缓存正文');
        expect(new Uint8Array(await reload.contentProvider().asset(article.id, cached.assets[0]))).toEqual(new Uint8Array([1,2,3]));
        expect(connect).toHaveBeenCalledTimes(calls);
        expect(data.reading).toEqual({});
    });
});

it('迁移电脑后，空共享快照和空接口不能删除本库公众号入口及历史缓存', async () => {
    const { mkdir, writeFile, readFile } = await import('node:fs/promises');
    const directory = await mkdtemp(join(tmpdir(), 'wechat-migration-test-'));
    const root = join(directory, 'shared');
    await mkdir(join(root, 'runtime'), { recursive: true });
    await mkdir(join(directory, 'cache'), { recursive: true });
    const id = 'account_' + 'a'.repeat(32);
    const oldFeed: Feed = { id, kind: 'wechat', title: '旧电脑的公众号', url: 'https://mp.weixin.qq.com/', folder: '公众号', enabled: true, intervalMinutes: 60 };
    const oldArticle = { id: 'article_old', accountId: id, title: '旧文章', state: 'ready', contentVersion: 'v1', assets: [] };
    await writeFile(join(directory, 'cache', `${id}.json`), JSON.stringify({ articles: [oldArticle] }));
    await writeFile(join(root, 'runtime/schedule.json'), JSON.stringify({ schemaVersion: 1, revision: 'empty', createdAt: Date.now(), loggedIn: false, accounts: [], articles: [], activeAccountIds: [] }));
    const data: ReaderData = { archiveFolder: 'RSS', reading: { article_old: { read: true, starred: true } }, feeds: [], wechatFeeds: [oldFeed], wechatEnabled: true };
    const provider = { call: vi.fn(async () => ({ items: [], nextCursor: null })) };
    const connect = vi.fn(async () => provider as never);
    const service = new FeedService(data, directory, async () => {}, connect, { root, session: async action => action() });
    cleanups.push(async () => { service.dispose(); await rm(directory, { recursive: true, force: true }); });
    await service.load();
    expect(connect).not.toHaveBeenCalled();
    expect(data.wechatFeeds[0]).toMatchObject({ id, title: oldFeed.title, missingLocalData: true });
    expect(service.articles()[0].id).toBe(oldArticle.id);
    await service.refreshWeChat();
    expect(data.wechatFeeds).toHaveLength(1);
    expect(service.articles()).toHaveLength(1);
    expect(JSON.parse(await readFile(join(directory, 'cache', `${id}.json`), 'utf8')).articles).toHaveLength(1);
    expect(data.reading.article_old).toEqual({ read: true, starred: true });
    await expect(service.refresh(data.wechatFeeds[0])).rejects.toThrow('补充恢复链接');
    // 数据迁回后，相同稳定 ID 自动恢复，空增量也不能清空旧文章。
    provider.call.mockImplementation(async (path?: unknown) => ({ items: String(path).includes('/accounts') ? [{ id, displayName: '已迁回', subscribed: true, autoSync: true, intervalMin: 60, nextSyncAt: Date.now()/1000 + 3600 }] : [], nextCursor: null }) as never);
    await service.refreshWeChat();
    expect(data.wechatFeeds[0].title).toBe('已迁回');
    expect(data.wechatFeeds[0].missingLocalData).toBeUndefined();
    expect(service.articles()).toHaveLength(1);
});

it('一次性恢复订阅配置只补充入口，不覆盖当前阅读状态和已有订阅', async () => {
    const { mkdir, writeFile, access } = await import('node:fs/promises');
    const directory = await mkdtemp(join(tmpdir(), 'wechat-recovery-test-'));
    await mkdir(join(directory, 'cache'), { recursive: true });
    const recovery = [{ id: 'account_' + 'a'.repeat(32), kind: 'wechat', title: '恢复的公众号', url: 'https://mp.weixin.qq.com/', folder: '公众号', enabled: true, intervalMinutes: 60 }];
    const path = join(directory, 'cache/wechat-subscriptions-recovery.json');
    await writeFile(path, JSON.stringify(recovery));
    const data: ReaderData = { archiveFolder: 'RSS', reading: { new: { read: true } }, feeds: [], wechatFeeds: [], wechatEnabled: false };
    const service = new FeedService(data, directory, async () => {}, vi.fn());
    cleanups.push(async () => { service.dispose(); await rm(directory, { recursive: true, force: true }); });
    await service.load();
    expect(data.wechatFeeds[0].title).toBe('恢复的公众号');
    expect(data.reading).toEqual({ new: { read: true } });
    await expect(access(path)).rejects.toThrow();
    await expect(access(`${path}.applied`)).resolves.toBeUndefined();
});
