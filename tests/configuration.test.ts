import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSubscriptionConfiguration, parseSubscriptionConfiguration, planSubscriptionImport } from '../src/feeds/configuration';
import { renderSubscriptionLinks, SubscriptionImportModal } from '../src/views/subscription-settings';
import { SubscriptionManagerModal } from '../src/views/subscription-manager';
import { Menu } from 'obsidian';
import { FeedService } from '../src/feeds/service';
import { wechatAccountId } from '../src/collector/subscriptions';
import type { Feed, ReaderData } from '../src/collector/types';
const rss: Feed = { id: 'old-rss-id', kind: 'rss', title: '技术 RSS', folder: '技术', url: 'https://example.org/feed?token=private-source', enabled: false, intervalMinutes: 90, etag: 'runtime-etag', checkedAt: 1, retryAt: 100, error: 'runtime-error' };
const wechat: Feed = { id: wechatAccountId('MP_WXS_123'), kind: 'wechat', title: '公众号', folder: '公众号', url: 'https://mp.weixin.qq.com/', enabled: true, intervalMinutes: 120, nextSyncAt: 100, wechat: { schemaVersion: 1, bookId: 'MP_WXS_123', platformId: 'MTIz', originalName: '原名', articleUrl: 'https://mp.weixin.qq.com/s/example', subscribed: true, autoSync: true, intervalMin: 120, intervalMax: 180 } };
const data = (): ReaderData => ({ archiveFolder: '原目录', reading: { old: { read: true, starred: true, archive: 'old.md' } }, feeds: [], wechatFeeds: [], wechatEnabled: false, runtimeMode: 'persistent' });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });
beforeAll(() => {
    Object.assign(HTMLElement.prototype, {
        empty() { this.replaceChildren(); },
        createEl(tag: string, options: any = {}) {
            const element = document.createElement(tag);
            if (options.cls) element.className = options.cls;
            if (options.text) element.textContent = options.text;
            if (options.value) element.setAttribute('value', options.value);
            for (const [name, value] of Object.entries(options.attr || {})) element.setAttribute(name, String(value));
            this.append(element); return element;
        }, createDiv(options: any) { return this.createEl('div', options); },
        createSpan(options: any) { return this.createEl('span', options); },
    });
});
describe('订阅配置导入导出', () => {
    it('两种订阅及旧条目能往返，排除凭据和运行状态，保留私有 RSS 地址的定位参数', () => {
        const legacy = { ...wechat, id: wechatAccountId('MP_WXS_456'), title: '旧公众号', wechat: undefined };
        const text = exportSubscriptionConfiguration([rss, { ...wechat, wechat: { ...wechat.wechat, accessToken: 'secret', skey: 'cookie' } } as never, legacy]);
        const parsed = parseSubscriptionConfiguration(text);
        expect(parsed).toHaveLength(3);
        expect(parsed[0]).toMatchObject({ url: rss.url, enabled: false, intervalMinutes: 90 });
        expect(parsed[1].wechat?.articleUrl).toBe(wechat.wechat?.articleUrl);
        expect(parsed[1].wechat?.intervalMax).toBe(180);
        expect(parsed[2].wechat).toBeUndefined();
        expect(text).not.toMatch(/secret|cookie|nextSyncAt|etag|retryAt|runtime-error|reading|archive|checkedAt/);
    });
    it('按规范地址与公众号身份去重，保留已有设置，只补齐缺失的恢复信息', () => {
        const state = data();
        state.feeds = [rss];
        state.wechatFeeds = [{ ...wechat, title: '本库名称', enabled: false, intervalMinutes: 60, wechat: undefined }];
        const plan = planSubscriptionImport(state, parseSubscriptionConfiguration(exportSubscriptionConfiguration([rss, wechat, { ...rss, title: '新增', url: 'https://new.example.org/feed' }, wechat])));
        expect(plan.added).toBe(1);
        expect(plan.updated).toBe(1);
        expect(plan.skipped).toBe(2);
        expect(plan.feeds[0]).toBe(rss);
        expect(plan.feeds[0].id).toBe('old-rss-id');
        expect(plan.wechatFeeds[0]).toMatchObject({ title: '本库名称', enabled: false, intervalMinutes: 60, wechat: { autoSync: false, intervalMin: 60 } });
        expect(state.wechatFeeds[0].wechat).toBeUndefined();
        expect(state.reading.old.read).toBe(true);
    });
    it('文件版本、地址、身份和间隔错误时整份拒绝，不产生部分导入', () => {
        expect(() => parseSubscriptionConfiguration('{')).toThrow('JSON');
        expect(() => parseSubscriptionConfiguration(JSON.stringify({ feeds: [] }))).toThrow('本插件');
        const file = JSON.parse(exportSubscriptionConfiguration([rss, wechat]));
        for (const patch of [{ kind: 'other' }, { url: 'file:///etc/passwd' }, { enabled: 'yes' }, { intervalMinutes: 0 }]) {
            const bad = { ...file, subscriptions: [{ ...file.subscriptions[0], ...patch }, file.subscriptions[1]] };
            expect(() => parseSubscriptionConfiguration(JSON.stringify(bad))).toThrow('第 1 个订阅');
        }
        file.subscriptions[1].id = wechatAccountId('MP_WXS_456');
        expect(() => parseSubscriptionConfiguration(JSON.stringify(file))).toThrow('身份不一致');
    });
    it('离线导入不连接服务，不更改阅读和全局设置；保存失败完整回滚', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'wechat-config-'));
        const state = data(), connect = vi.fn(), save = vi.fn(async () => {});
        const service = new FeedService(state, directory, save, connect);
        cleanups.push(async () => { service.dispose(); await rm(directory, { recursive: true, force: true }); });
        const text = exportSubscriptionConfiguration([rss, wechat]);
        save.mockRejectedValueOnce(new Error('保存失败'));
        await expect(service.importConfiguration(text)).rejects.toThrow('保存失败');
        expect(state.feeds).toEqual([]); expect(state.wechatFeeds).toEqual([]);
        expect((await service.importConfiguration(text)).added).toBe(2);
        expect(connect).not.toHaveBeenCalled();
        expect(state.wechatEnabled).toBe(false); expect(state.runtimeMode).toBe('persistent');
        expect(state.reading).toEqual(data().reading); expect(state.archiveFolder).toBe('原目录');
        expect((await service.importConfiguration(text)).skipped).toBe(2);
    });
});
describe('订阅链接设置与导入预览', () => {
    it('所有链接只读，包含暂停项；缺失原文不会显示通用主页冒充原文', () => {
        const parent = document.createElement('div');
        renderSubscriptionLinks(parent, [rss, wechat, { ...wechat, id: wechatAccountId('MP_WXS_456'), title: '缺少链接', wechat: undefined }]);
        const links = [...parent.querySelectorAll('textarea')];
        expect(links.map(link => link.readOnly)).toEqual([true, true, true]);
        expect(links.map(link => link.value)).toEqual([rss.url, wechat.wechat?.articleUrl, '']);
        expect(links[2].placeholder).toContain('补充恢复链接');
        expect(parent.querySelectorAll('button')[2].disabled).toBe(true);
        expect(parent.textContent).toContain('自动刷新已暂停');
    });
    it('预览后才允许确认，点击时重新合并；预览失败后不能导入旧文件', async () => {
        const state = data(), apply = vi.fn(async () => ({ added: 2, updated: 0, skipped: 0, needsLink: 0 })), imported = vi.fn();
        const modal = new SubscriptionImportModal({ app: {}, data: state, service: { importConfiguration: apply } } as never, imported);
        modal.open();
        cleanups.push(async () => modal.close());
        const confirm = modal.contentEl.querySelector<HTMLButtonElement>('.mod-cta')!;
        expect(confirm.disabled).toBe(true);
        const text = exportSubscriptionConfiguration([rss, wechat]);
        modal.previewConfiguration(text);
        expect(confirm.disabled).toBe(false);
        expect(apply).not.toHaveBeenCalled();
        expect(() => modal.previewConfiguration('bad')).toThrow();
        expect(confirm.disabled).toBe(true);
        modal.previewConfiguration(text);
        confirm.click();
        await vi.waitFor(() => expect(imported).toHaveBeenCalledTimes(1));
        expect(apply).toHaveBeenCalledWith(text);
    });
});

describe('来源移除与恢复的数据保护', () => {
    it('移除普通源保留历史缓存与阅读记录，重加沿用身份；保存失败回滚', async () => {
        // 使用临时目录和禁止联网的连接器验证本地操作。
        // 使用独立临时缓存目录。
        const directory = await mkdtemp(join(tmpdir(), 'wechat-remove-'));
        // 本例的笔记库订阅和阅读状态。
        const state = data();
        state.feeds = [{ ...rss }];
        // 控制持久化成功与失败分支。
        const save = vi.fn(async () => {});
        // 记录是否意外连接公众号服务。
        const connect = vi.fn();
        // 待验证的统一订阅服务。
        const service = new FeedService(state, directory, save, connect);
        cleanups.push(async () => { service.dispose(); await rm(directory, { recursive: true, force: true }); });
        // 模拟已缓存文章，移除入口不应删除内存索引。
        const cache = (service as unknown as { cache: Map<string, unknown[]> }).cache;
        cache.set(rss.id, [{ id: 'old', accountId: rss.id, publishedAt: '2026-11-09' }]);
        save.mockRejectedValueOnce(new Error('磁盘不可写'));
        await expect(service.removeSubscription(state.feeds[0])).rejects.toThrow('磁盘不可写');
        expect(service.feeds()).toHaveLength(1);
        await service.removeSubscription(state.feeds[0]);
        expect(service.feeds()).toEqual([]);
        expect(service.articles()).toHaveLength(1);
        expect(state.reading).toEqual(data().reading);
        expect(parseSubscriptionConfiguration(exportSubscriptionConfiguration(service.feeds()))).toEqual([]);
        expect((await service.add(rss.url)).id).toBe(rss.id);
        expect(service.feeds()[0]).toMatchObject({ enabled: true, removed: false });
        expect(connect).not.toHaveBeenCalled();
    });
    it('公众号移除调用取消采集，后续快照和重启保留隐藏标记，手动重订阅恢复入口', async () => {
        // 使用独立临时缓存目录。
        const directory = await mkdtemp(join(tmpdir(), 'wechat-remove-shared-'));
        // 本例的笔记库订阅和阅读状态。
        const state = data();
        state.wechatFeeds = [structuredClone(wechat)];
        // 共享采集返回的公众号身份和暂停状态。
        const account = { id: wechat.id, displayName: wechat.title, originalName: '原名', bookId: 'MP_WXS_123', platformId: 'MTIz', subscribed: false, autoSync: false, intervalMin: 120, intervalMax: 180, nextSyncAt: 0 };
        // 替代共享采集 API，避免访问真实数据。
        const call = vi.fn(async () => ({}));
        // 待验证的统一订阅服务。
        const service = new FeedService(state, directory, async () => {}, async () => ({ call }) as never);
        cleanups.push(async () => { service.dispose(); await rm(directory, { recursive: true, force: true }); });
        await service.removeSubscription(state.wechatFeeds[0]);
        expect(call).toHaveBeenCalledWith(`/v1/accounts/${wechat.id}/subscription`, 'DELETE');
        await (service as unknown as { mergeWeChat(accounts: unknown[], articles: unknown[]): Promise<void> }).mergeWeChat([account], []);
        expect(service.feeds()).toEqual([]);
        // 用序列化配置模拟插件重启。
        const restarted = new FeedService(JSON.parse(JSON.stringify(state)), directory, async () => {}, vi.fn());
        expect(restarted.feeds()).toEqual([]);
        restarted.dispose();
        expect((await service.importConfiguration(exportSubscriptionConfiguration([wechat]))).updated).toBe(1);
        expect(service.feeds()).toHaveLength(1);
    });
    it('共享服务取消失败时保留入口；缺少本机账户时可离线暂停和移除', async () => {
        // 使用独立临时缓存目录。
        const directory = await mkdtemp(join(tmpdir(), 'wechat-remove-failure-'));
        // 本例的笔记库订阅和阅读状态。
        const state = data();
        state.wechatFeeds = [structuredClone(wechat)];
        // 替代共享采集 API，避免访问真实数据。
        const call = vi.fn(async () => { throw new Error('服务不可用'); });
        // 待验证的统一订阅服务。
        const service = new FeedService(state, directory, async () => {}, async () => ({ call }) as never);
        cleanups.push(async () => { service.dispose(); await rm(directory, { recursive: true, force: true }); });
        await expect(service.removeSubscription(state.wechatFeeds[0])).rejects.toThrow('服务不可用');
        expect(service.feeds()[0].enabled).toBe(true);
        state.wechatFeeds[0].missingLocalData = true;
        await service.setEnabled(state.wechatFeeds[0], false);
        expect(state.wechatFeeds[0].wechat?.autoSync).toBe(false);
        await service.removeSubscription(state.wechatFeeds[0]);
        expect(service.feeds()).toEqual([]);
        expect(call).toHaveBeenCalledTimes(1);
    });
});


describe('统一订阅管理窗口', () => {
    it('搜索和状态筛选共同生效，详情按需展开，暂停调用统一服务并刷新状态', async () => {
        // 仅替代业务服务，不连接本机采集或真实笔记库。
        // 覆盖暂停 RSS 与正常公众号的来源夹具。
        const feeds = [structuredClone(rss), structuredClone(wechat)];
        // 模拟统一暂停服务并更新来源状态。
        const setEnabled = vi.fn(async (feed: Feed, enabled: boolean) => { feed.enabled = enabled; });
        // 管理窗口需要的最小插件依赖。
        const plugin = { app: {}, service: { feeds: () => feeds, setEnabled } };
        // 待验证的统一订阅管理窗口。
        const modal = new SubscriptionManagerModal(plugin as never);
        modal.open();
        cleanups.push(async () => modal.close());
        expect(modal.contentEl.querySelectorAll('.wr-manager-row')).toHaveLength(2);
        expect(modal.contentEl.querySelector('textarea')).toBeNull();
        // 来源详情中的链接不可编辑，避免误改公众号身份。
        modal.contentEl.querySelector<HTMLButtonElement>('.wr-manager-title')!.click();
        expect(modal.contentEl.querySelector('textarea')?.value).toBe(rss.url);
        expect(modal.contentEl.querySelector('textarea')?.readOnly).toBe(true);
        // 用户可见的来源搜索框。
        const search = modal.contentEl.querySelector('input')!;
        search.value = '公众号'; search.dispatchEvent(new Event('input'));
        expect(modal.contentEl.querySelectorAll('.wr-manager-row')).toHaveLength(1);
        // 用户可见的订阅状态筛选器。
        const status = modal.contentEl.querySelector('select')!;
        status.value = 'paused'; status.dispatchEvent(new Event('change'));
        expect(modal.contentEl.querySelectorAll('.wr-manager-row')).toHaveLength(0);
        status.value = 'enabled'; status.dispatchEvent(new Event('change'));
        modal.contentEl.querySelector<HTMLButtonElement>('[aria-label="管理公众号"]')!.click();
        await Menu.latest.items.find(item => item.title === '暂停自动更新')!.click();
        expect(setEnabled).toHaveBeenCalledWith(feeds[1], false);
        expect(modal.contentEl.querySelectorAll('.wr-manager-row')).toHaveLength(0);
        // 其他入口的修改通过通知刷新当前管理窗口。
        feeds[1].enabled = true;
        window.dispatchEvent(new Event('wechat-reader:subscriptions-changed'));
        expect(modal.contentEl.querySelectorAll('.wr-manager-row')).toHaveLength(1);
    });
});
