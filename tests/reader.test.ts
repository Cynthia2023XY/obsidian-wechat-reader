import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Menu } from 'obsidian';
import { ReaderView } from '../src/views/reader';
import { ArticleReaderModal } from '../src/views/article-modal';
import { ReadingStore } from '../src/reading/state';
import type { Article, ReaderData } from '../src/collector/types';
beforeAll(() => {
    Object.assign(HTMLElement.prototype, {
        addClass(...names: string[]) { this.classList.add(...names); },
        empty() { this.replaceChildren(); }, setText(text: string) { this.textContent = text; },
        createEl(tag: string, options: any = {}) {
            // 模拟 Obsidian 创建的原生元素。
            const element = document.createElement(tag);
            if (options.cls) element.className = options.cls;
            if (options.text) element.textContent = options.text;
            for (const [name, value] of Object.entries(options.attr || {})) element.setAttribute(name, String(value));
            this.append(element); return element;
        },
        createDiv(options: any) { return this.createEl('div', options); },
        createSpan(options: any) { return this.createEl('span', options); },
    });
});
/** 构建跨来源的本库文章与原生侧栏测试环境 */
async function setup(count = 46) {
    // 覆盖分页边界的跨来源文章夹具。
    const articles: Article[] = Array.from({ length: count }, (_, index) => ({ id: `rss_${index}`, accountId: index % 2 ? 'feed_b' : 'feed', title: `文章${index}`, url: 'https://example.com/', publishedAt: null, summary: '', state: index ? 'ready' : 'temporary_failure', assetState: 'ready', contentVersion: 'v1', assets: [] }));
    // 独立于真实笔记库的订阅与阅读配置。
    const data: ReaderData = { archiveFolder: 'RSS', reading: {}, feeds: [], wechatFeeds: [], wechatEnabled: false };
    // 以本地文章夹具替代采集服务，禁止真实网络请求。
    const service = { feeds: () => [{ id: 'feed', title: '测试源', folder: '技术', kind: 'rss', enabled: false }, { id: 'feed_b', title: '公众号 B', folder: '资讯', kind: 'wechat', enabled: true }], article: vi.fn(async (id: string) => articles.find(article => article.id === id)!), articles: (id?: string) => articles.filter(article => !id || article.accountId === id), onChange: () => view.render(), lastError: '' };
    // 记录阅读状态保存次数，不写入真实笔记库。
    const persist = vi.fn(async () => {});
    // 阅读视图所需的最小插件依赖。
    const plugin = { app: {}, register: vi.fn(), data, service, persist, readingState: new ReadingStore(data, persist, service.onChange) };
    // 本次测试挂载的原生侧栏视图。
    const view = new ReaderView({} as never, plugin as never);
    document.body.append(view.contentEl);
    await view.onOpen();
    return { view, data, articles, persist, plugin, service };
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
describe('聚合文章侧栏', () => {
    it('全部和已读没有计数，已读筛选使用本库状态', async () => {
        // 当前用例挂载的侧栏及本库阅读状态。
        const { view, data } = await setup();
        data.reading.rss_0 = { read: true };
        view.render();
        // 四个聚合筛选入口用于验证计数和选中范围。
        const aggregates = [...view.contentEl.querySelectorAll<HTMLButtonElement>('.wr-aggregate button')];
        expect(aggregates.map(button => button.querySelector('.wr-row-label')?.textContent)).toEqual(['全部文章', '未读', '已读', '收藏']);
        expect(aggregates[0].querySelector('.wr-count')).toBeNull();
        expect(aggregates[2].querySelector('.wr-count')).toBeNull();
        aggregates[2].click();
        expect(view.contentEl.querySelectorAll('.wr-article-row')).toHaveLength(1);
        expect(view.contentEl.querySelector('.wr-row-meta')?.textContent).toContain('已读 · 正文获取失败');
        await view.onClose();
    });
    it('全局标记包含停用源与分页外文章，不影响操作开始后新增条目', async () => {
        // 当前用例挂载的侧栏及本库阅读状态。
        const { view, data, articles, persist } = await setup();
        view.contentEl.querySelector<HTMLButtonElement>('[aria-label="全部标为已读"]')!.click();
        articles.push({ ...articles[0], id: 'rss_new' });
        await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
        expect(Object.values(data.reading).filter(state => state.read)).toHaveLength(46);
        expect(data.reading.rss_new).toBeUndefined();
        await view.onClose();
    });
    it('源和分组右键均提供标记为已读', async () => {
        // 当前用例挂载的侧栏及本库阅读状态。
        const { view } = await setup();
        view.contentEl.querySelector<HTMLButtonElement>('[data-nav-key="sources"]')!.click();
        for (const selector of ['[data-feed-id="feed"]', '.wr-folder-title']) {
            view.contentEl.querySelector(selector)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
            expect((Menu as any).latest.items.some((item: any) => item.title === '标记为已读')).toBe(true);
        }
        await view.onClose();
    });
});

/** 按可见入口触发操作，避免测试依赖内部状态字段 */
function click(view: ReaderView, key: string): void {
    // 导航和加载操作使用与业务范围一致的稳定标识。
    view.contentEl.querySelector<HTMLButtonElement>(`[data-nav-key="${key}"]`)!.click();
}

describe('聚合分页与阅读上下文', () => {
    it('初始50篇，每次追加50篇，数量覆盖全集，各入口保留分页与滚动位置', async () => {
        // 首屏只渲染部分文章，统计仍覆盖全部来源。
        const { view, data } = await setup(126);
        expect(view.contentEl.querySelectorAll('.wr-article-row')).toHaveLength(50);
        expect(view.contentEl.querySelector('.wr-list-progress')?.textContent).toBe('已显示 50 / 126 篇');
        expect(view.contentEl.querySelector('[data-nav-key="unread"] .wr-count')?.textContent).toBe('126');
        click(view, 'more');
        expect(view.contentEl.querySelectorAll('.wr-article-row')).toHaveLength(100);
        // 切换列表不丢失原列表的加载条数与滚动位置。
        view.contentEl.querySelector<HTMLElement>('.wr-results')!.scrollTop = 240;
        click(view, 'unread');
        expect(view.contentEl.querySelectorAll('.wr-article-row')).toHaveLength(50);
        expect(view.contentEl.querySelector<HTMLElement>('.wr-results')!.scrollTop).toBe(0);
        click(view, 'all');
        expect(view.contentEl.querySelectorAll('.wr-article-row')).toHaveLength(100);
        expect(view.contentEl.querySelector<HTMLElement>('.wr-results')!.scrollTop).toBe(240);
        click(view, 'more');
        expect(view.contentEl.querySelectorAll('.wr-article-row')).toHaveLength(126);
        expect(view.contentEl.querySelector('[data-nav-key="more"]')).toBeNull();
        // 收藏筛选立即展示跨来源结果，取消后出现明确空态。
        data.reading.rss_1 = { starred: true };
        click(view, 'starred');
        expect(view.contentEl.querySelectorAll('.wr-article-row')).toHaveLength(1);
        expect(view.contentEl.querySelector('.wr-row-meta')?.textContent).toContain('公众号 B');
        data.reading.rss_1.starred = false;
        view.render();
        expect(view.contentEl.querySelector('.wr-empty-feed')?.textContent).toBe('暂无收藏文章');
    });
    it('后台新增文章时按原文章锚点恢复滚动位置', async () => {
        // 为 DOM 测试提供可测量的行布局，验证插入文章后的视觉位置。
        const { view, articles } = await setup(60);
        vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
            // 每篇文章具有固定高度，仅模拟文章结果区布局。
            return this.matches('.wr-article-row') ? Array.from(this.parentElement!.children).indexOf(this) * 60 : 0;
        });
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.matches('.wr-article-row') ? 60 : 0; });
        view.contentEl.querySelector<HTMLElement>('.wr-results')!.scrollTop = 325;
        articles.unshift({ ...articles[0], id: 'rss_new', publishedAt: '2026-11-02T12:00:00Z' });
        view.render();
        expect(view.contentEl.querySelector<HTMLElement>('.wr-results')!.scrollTop).toBe(385);
    });
    it('来源独立于聚合筛选，停用源历史可见，分组与源菜单仍可使用', async () => {
        // 当前用例挂载的侧栏及本库阅读状态。
        const { view, data } = await setup();
        data.reading.rss_0 = { read: true };
        click(view, 'read');
        click(view, 'sources');
        click(view, 'feed:feed');
        expect(view.contentEl.querySelector('.wr-results-heading')?.textContent).toBe('测试源');
        expect(view.contentEl.querySelectorAll('.wr-article-row')).toHaveLength(23);
        expect(view.contentEl.querySelectorAll('.wr-aggregate .is-active')).toHaveLength(0);
        expect(view.contentEl.querySelectorAll('[data-feed-id].is-active')).toHaveLength(1);
        click(view, 'unread');
        expect(view.contentEl.querySelectorAll('[data-feed-id].is-active')).toHaveLength(0);
        expect(view.contentEl.querySelectorAll('.wr-article-row')).toHaveLength(45);
    });
    it('跨时区按实际时间排序，同时间按ID排序，无效或未知时间置后', async () => {
        // 当前用例挂载的侧栏及本库阅读状态。
        const { view, articles, data } = await setup(5);
        articles[0].publishedAt = '2026-11-02T09:00:00+08:00';
        articles[1].publishedAt = '2026-11-02T02:00:00Z';
        articles[2].publishedAt = '2026-11-02T10:00:00+08:00';
        articles[3].publishedAt = 'invalid';
        // 时间基准导致的隐式已读也参与聚合筛选。
        articles[0].id = 'article_baseline';
        data.readBefore = Date.parse('2026-11-02T01:30:00Z');
        view.render();
        expect([...view.contentEl.querySelectorAll<HTMLElement>('[data-article-id]')].map(row => row.dataset.articleId)).toEqual(['rss_1', 'rss_2', 'article_baseline', 'rss_3', 'rss_4']);
        click(view, 'read');
        expect(view.contentEl.querySelectorAll('.wr-article-row')).toHaveLength(1);
        expect(view.contentEl.querySelector<HTMLElement>('[data-article-id]')?.dataset.articleId).toBe('article_baseline');
    });
    it('仅冻结已展示50篇，自动已读和后台新增不改变跨来源阅读队列，关闭恢复附近焦点', async () => {
        // 当前用例挂载的侧栏及本库阅读状态。
        const { view, articles, data, service } = await setup(60);
        // 观察真实阅读弹窗打开时的实例。
        const open = vi.spyOn(ArticleReaderModal.prototype, 'open');
        click(view, 'unread');
        // 打开弹窗前的可见文章顺序作为冻结队列基准。
        const ids = [...view.contentEl.querySelectorAll<HTMLElement>('[data-article-id]')].map(row => row.dataset.articleId!);
        view.contentEl.querySelector<HTMLButtonElement>('.wr-article-row')!.click();
        // 本次打开的阅读弹窗用于验证队列与关闭行为。
        const modal = open.mock.contexts[0] as ArticleReaderModal;
        await vi.waitFor(() => expect(data.reading[ids[0]]?.read).toBe(true));
        expect(modal.contentEl.querySelector('.wr-position')?.textContent).toBe('1 / 50');
        expect(view.contentEl.querySelector(`[data-article-id="${ids[0]}"]`)).toBeNull();
        articles.unshift({ ...articles[0], id: 'rss_new', publishedAt: '2026-11-02T12:00:00Z' });
        view.render();
        await modal.navigate(1);
        expect(service.article).toHaveBeenLastCalledWith(ids[1]);
        await modal.navigate(48);
        expect(service.article).toHaveBeenLastCalledWith(ids[49]);
        expect(modal.contentEl.querySelector('.wr-position')?.textContent).toBe('50 / 50');
        expect(modal.contentEl.querySelector<HTMLButtonElement>('.wr-next')?.disabled).toBe(true);
        modal.close();
        expect(view.contentEl.contains(document.activeElement)).toBe(true);
        expect(document.activeElement?.classList.contains('wr-article-row')).toBe(true);
    });
    it('最后一篇未读读完后，关闭回到空列表标题', async () => {
        // 当前用例挂载的侧栏及本库阅读状态。
        const { view, data } = await setup(1);
        // 观察真实阅读弹窗打开时的实例。
        const open = vi.spyOn(ArticleReaderModal.prototype, 'open');
        click(view, 'unread');
        view.contentEl.querySelector<HTMLButtonElement>('.wr-article-row')!.click();
        // 本次打开的阅读弹窗用于验证队列与关闭行为。
        const modal = open.mock.contexts[0] as ArticleReaderModal;
        await vi.waitFor(() => expect(data.reading.rss_0?.read).toBe(true));
        modal.close();
        expect(view.contentEl.querySelector('.wr-empty-feed')?.textContent).toBe('暂无未读文章');
        expect(document.activeElement).toBe(view.contentEl.querySelector('.wr-results-heading'));
    });
});
