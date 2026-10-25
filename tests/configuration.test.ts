import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSubscriptionConfiguration, parseSubscriptionConfiguration, planSubscriptionImport } from '../src/feeds/configuration';
import { renderSubscriptionLinks, SubscriptionImportModal } from '../src/views/subscription-settings';
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
            for (const [name, value] of Object.entries(options.attr || {})) element.setAttribute(name, String(value));
            this.append(element); return element;
        }, createDiv(options: any) { return this.createEl('div', options); },
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
