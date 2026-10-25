import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Menu } from 'obsidian';
import { ReaderView } from '../src/views/reader';
import { ReadingStore } from '../src/reading/state';
import type { Article, ReaderData } from '../src/collector/types';
beforeAll(() => {
    Object.assign(HTMLElement.prototype, {
        addClass(...names: string[]) { this.classList.add(...names); },
        empty() { this.replaceChildren(); }, setText(text: string) { this.textContent = text; },
        createEl(tag: string, options: any = {}) {
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
async function setup() {
    const articles: Article[] = Array.from({ length: 46 }, (_, index) => ({ id: `rss_${index}`, accountId: 'feed', title: `文章${index}`, url: 'https://example.com/', publishedAt: null, summary: '', state: index ? 'ready' : 'temporary_failure', assetState: 'ready', contentVersion: 'v1', assets: [] }));
    const data: ReaderData = { archiveFolder: 'RSS', reading: {}, feeds: [], wechatFeeds: [], wechatEnabled: false };
    const service = { feeds: () => [{ id: 'feed', title: '测试源', folder: '技术', kind: 'rss', enabled: false }], articles: (id?: string) => articles.filter(article => !id || article.accountId === id), onChange: () => view.render(), lastError: '' };
    const persist = vi.fn(async () => {});
    const plugin = { data, service, persist, readingState: new ReadingStore(data, persist, service.onChange) };
    const view = new ReaderView({} as never, plugin as never);
    await view.onOpen();
    return { view, data, articles, persist };
}
describe('订阅面板已读入口', () => {
    it('全部和已读没有计数，已读筛选使用本库状态', async () => {
        const { view, data } = await setup();
        data.reading.rss_0 = { read: true };
        view.render();
        const aggregates = [...view.contentEl.querySelectorAll<HTMLButtonElement>('.wr-aggregate button')];
        expect(aggregates.map(button => button.querySelector('.wr-row-label')?.textContent)).toEqual(['全部文章', '未读', '已读', '收藏']);
        expect(aggregates[0].querySelector('.wr-count')).toBeNull();
        expect(aggregates[2].querySelector('.wr-count')).toBeNull();
        aggregates[2].click();
        view.contentEl.querySelector<HTMLButtonElement>('[data-feed-id="feed"]')!.click();
        expect(view.contentEl.querySelectorAll('.wr-article-row')).toHaveLength(1);
        expect(view.contentEl.querySelector('.wr-row-meta')?.textContent).toContain('已读 · 正文获取失败');
        await view.onClose();
    });
    it('全局标记包含停用源与分页外文章，不影响操作开始后新增条目', async () => {
        const { view, data, articles, persist } = await setup();
        view.contentEl.querySelector<HTMLButtonElement>('[aria-label="全部标为已读"]')!.click();
        articles.push({ ...articles[0], id: 'rss_new' });
        await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
        expect(Object.values(data.reading).filter(state => state.read)).toHaveLength(46);
        expect(data.reading.rss_new).toBeUndefined();
        await view.onClose();
    });
    it('源和分组右键均提供标记为已读', async () => {
        const { view } = await setup();
        for (const selector of ['[data-feed-id="feed"]', '.wr-folder-title']) {
            view.contentEl.querySelector(selector)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
            expect((Menu as any).latest.items.some((item: any) => item.title === '标记为已读')).toBe(true);
        }
        await view.onClose();
    });
});
