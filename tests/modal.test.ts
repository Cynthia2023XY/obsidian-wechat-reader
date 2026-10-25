import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ArticleReaderModal, clipboardMarkdown } from '../src/views/article-modal';
import * as archive from '../src/archive/archive';
import { ReadingStore } from '../src/reading/state';
import type { Article } from '../src/collector/types';
/** 模拟 Obsidian 给 DOM 增加的便利方法，布局仍由 jsdom 真实生成 */
beforeAll(() => {
    Object.assign(HTMLElement.prototype, { addClass(...names: string[]) { this.classList.add(...names); }, empty() { this.replaceChildren(); }, setText(text: string) { this.textContent = text; }, createEl(tag: string, options: any = {}) {
            // 当前用例所需的隔离输入、依赖或断言结果。
            const element = document.createElement(tag);
            if (options.cls)
                element.className = options.cls;
            if (options.text)
                element.textContent = options.text;
            this.append(element);
            return element;
        }, createDiv(options: any) { return this.createEl('div', options); }, createSpan(options: any) { return this.createEl('span', options); }, scrollBy: vi.fn() });
});
/** 清理每个模态，避免将关闭状态带入下个用例 */
const modals: ArticleReaderModal[] = [];
afterEach(() => { for (const modal of modals.splice(0))
    modal.close(); vi.restoreAllMocks(); });
/** 正文夹具不触发任何网络资源读取 */
const article = (id: string): Article => ({ id, accountId: 'feed', title: id, url: 'https://example.com/' + id, publishedAt: null, contentVersion: 'v1', state: 'ready', assetState: 'ready', assets: [], html: '<p>可读正文</p>', contentKind: 'full' });
/** 插件替身保留真实读状态对象以检查副作用 */
function setup(read: (id: string) => Promise<Article> = async (id) => article(id)) {
    // 当前用例所需的隔离输入、依赖或断言结果。
    const plugin = { app: {}, register: vi.fn(), data: { reading: {}, archiveFolder: 'RSS' }, persist: vi.fn(async () => { }), service: { article: vi.fn(read), feeds: () => [{ id: 'feed', title: '源名称' }], onChange: vi.fn(), articles: () => ['rss_a', 'rss_b', 'rss_c'].map(article), retryArticle: vi.fn(async () => {}), contentProvider: () => ({ asset: vi.fn() }) } };
    // 当前用例所需的隔离输入、依赖或断言结果。
    const readingState = new ReadingStore(plugin.data as never, () => plugin.persist(), () => plugin.service.onChange());
    const configured = { ...plugin, readingState };
    const done = vi.fn();
    // 当前用例所需的隔离输入、依赖或断言结果。
    const modal = new ArticleReaderModal(configured as never, ['rss_a', 'rss_b', 'rss_c'], 'rss_a', done);
    modals.push(modal);
    modal.open();
    return { plugin: configured, modal, done };
}
describe('原生阅读弹窗交互', () => {
    it('正文展示后已读，固定队列切换不因已读过滤跳篇，首尾不循环', async () => {
        // 正文展示后已读，固定队列切换不因已读过滤跳篇，首尾不循环所需的隔离输入、依赖或断言结果。
        const { plugin, modal } = setup();
        await vi.waitFor(() => expect(plugin.data.reading).toHaveProperty('rss_a.read', true));
        await modal.navigate(1);
        expect(modal.contentEl.querySelector('h1')?.textContent).toBe('rss_b');
        await modal.navigate(1);
        await modal.navigate(1);
        expect(modal.contentEl.querySelector('h1')?.textContent).toBe('rss_c');
        expect((modal.contentEl.querySelector('.wr-next') as HTMLButtonElement).disabled).toBe(true);
        await modal.navigate(-1);
        expect(modal.contentEl.querySelector('h1')?.textContent).toBe('rss_b');
        expect(plugin.service.article).toHaveBeenCalledTimes(4);
        expect(Object.keys(plugin.data.reading)).toHaveLength(3);
    });
    it('旧异步响应不能覆盖新文章，也不能把未显示的正文标记已读', async () => {
        // 旧异步响应不能覆盖新文章，也不能把未显示的正文标记已读所需的隔离输入、依赖或断言结果。
        let finish!: (article: Article) => void;
        // 旧异步响应不能覆盖新文章，也不能把未显示的正文标记已读所需的隔离输入、依赖或断言结果。
        const { plugin, modal } = setup(id => id === 'rss_a' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(article(id)));
        await modal.navigate(1);
        finish(article('rss_a'));
        await Promise.resolve();
        expect(modal.contentEl.querySelector('h1')?.textContent).toBe('rss_b');
        expect(plugin.data.reading).not.toHaveProperty('rss_a');
        expect(plugin.data.reading).toHaveProperty('rss_b.read', true);
    });
    it('失败提示展示后自动已读；输入框方向键和长按不触发切换', async () => {
        // 失败提示展示后自动已读；输入框方向键和长按不触发切换所需的隔离输入、依赖或断言结果。
        const { plugin, modal } = setup(async () => ({ ...article('rss_a'), state: 'temporary_failure', html: '' }));
        await vi.waitFor(() => expect(modal.contentEl.querySelector('.wr-error')).toBeTruthy());
        await vi.waitFor(() => expect(plugin.data.reading).toHaveProperty('rss_a.read', true));
        expect(modal.contentEl.querySelector('.wr-retry')).toBeTruthy();
        // 失败提示展示后自动已读；输入框方向键和长按不触发切换所需的隔离输入、依赖或断言结果。
        const input = document.createElement('input');
        modal.contentEl.append(input);
        // 失败提示展示后自动已读；输入框方向键和长按不触发切换所需的隔离输入、依赖或断言结果。
        const key = new KeyboardEvent('keydown', { key: 'ArrowRight' });
        Object.defineProperty(key, 'target', { value: input });
        (modal.scope as any).handlers.get('ArrowRight')(key);
        await Promise.resolve();
        expect(plugin.service.article).toHaveBeenCalledTimes(1);
        // 失败提示展示后自动已读；输入框方向键和长按不触发切换所需的隔离输入、依赖或断言结果。
        const repeat = new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true });
        (modal.scope as any).handlers.get('ArrowRight')(repeat);
        expect(plugin.service.article).toHaveBeenCalledTimes(1);
    });
    it('手动标未读不会被稍后返回的正文覆盖', async () => {
        let finish!: (article: Article) => void;
        const { plugin } = setup(() => new Promise(resolve => { finish = resolve; }));
        await plugin.readingState.set(['rss_a'], false);
        finish(article('rss_a'));
        await vi.waitFor(() => expect(plugin.service.article).toHaveBeenCalled());
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(plugin.data.reading).not.toHaveProperty('rss_a.read', true);
    });
    it('请求失败呈现错误后已读，关闭后返回不标记', async () => {
        const { plugin, modal } = setup(async () => { throw new Error('正文读取失败'); });
        await vi.waitFor(() => expect(plugin.data.reading).toHaveProperty('rss_a.read', true));
        expect(modal.contentEl.querySelector('.wr-open-original')).toBeTruthy();
        let finish!: (article: Article) => void;
        const next = setup(() => new Promise(resolve => { finish = resolve; }));
        next.modal.close();
        finish(article('rss_a'));
        await Promise.resolve();
        expect(next.plugin.data.reading).toEqual({});
    });
    it('归档期间的手动未读和收藏修改不会被旧状态覆盖', async () => {
        let finish!: (state: any) => void;
        const save = vi.spyOn(archive, 'archiveArticle').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const { plugin, modal } = setup();
        await vi.waitFor(() => expect(plugin.data.reading).toHaveProperty('rss_a.read', true));
        (modal.contentEl.querySelector('.wr-save') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(save).toHaveBeenCalled());
        await plugin.readingState.set(['rss_a'], false);
        (plugin.data.reading as any).rss_a.starred = true;
        finish({ read: true, starred: false, archive: 'saved.md', version: 'v1' });
        await vi.waitFor(() => expect(plugin.data.reading).toHaveProperty('rss_a.archive', 'saved.md'));
        expect(plugin.data.reading).toHaveProperty('rss_a.read', false);
        expect(plugin.data.reading).toHaveProperty('rss_a.starred', true);
    });
    it('复制输出清理可执行内容，不包含 blob、asset 和本机鉴权图片', () => {
        // 复制输出清理可执行内容，不包含 blob、asset 和本机鉴权图片所需的隔离输入、依赖或断言结果。
        const output = clipboardMarkdown({ ...article('rss_a'), html: '<p onclick="evil()">文章<script>evil()</script></p><img src="asset:a">', assets: [{ id: 'a', state: 'ready', mime: 'image/png', sourceUrl: 'http://127.0.0.1/token' }] });
        expect(output).toContain('文章');
        expect(output).not.toMatch(/script|evil|asset:|blob:|127\.0\.0\.1|token/);
        expect(output).toContain('阅读原文');
    });
});
