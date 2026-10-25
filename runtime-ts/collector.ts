import { parseHTML } from 'linkedom';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, copyFileSync, writeFileSync, statfsSync } from 'node:fs';
import { Auth, boundedFetch } from './auth';
import { Problem, canonicalUrl, sha, Store, utc } from './core';
import type { DiscoveredArticle, StoredAccount, StoredAsset } from './core';
import type { Article } from '../src/collector/types';
/** 上游对象仅在适配层使用，界面不依赖腾讯内部结构 */
type Upstream = Record<string, any>;
/** 已确认公众号身份与输入文章元信息 */
export interface Resolution {
    platformId: string;
    bookId: string;
    originalName: string;
    seedArticle: DiscoveredArticle;
}
/** 允许在清理后正文中保留的非执行标签 */
const TAGS = new Set('p br div span section article h1 h2 h3 h4 h5 h6 strong b em i u s blockquote ul ol li pre code table thead tbody tr th td hr a img figure figcaption'.split(' '));
/** 当前系统支持的浏览器位置，不读取 shell PATH */
const BROWSERS = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
/** 微信图文请求使用的普通移动浏览器画像 */
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.43';
/** 优先使用上游原文地址，仅生成微信短链时还原微信读书的下划线编码 */
function articleUrl(info: Upstream, review: string): string {
    if (typeof info.doc_url === 'string' && info.doc_url.trim()) {
        try { return canonicalUrl(info.doc_url); }
        catch { /* 无效原文入口不能阻断稳定短链兜底。 */ }
    }
    // 原始 reviewId 仍用于上游请求和身份别名，不在此修改。
    const suffix = review.match(/^MP_WXS_\d+_([A-Za-z0-9_~\-]+)$/)?.[1];
    // originalId 与 reviewId 的文章后缀都可能以波浪线表示下划线。
    for (const candidate of [info.originalId, suffix]) {
        if (typeof candidate === 'string' && /^[A-Za-z0-9_~\-]+$/.test(candidate))
            return canonicalUrl(`https://mp.weixin.qq.com/s/${candidate.replace(/~/g, '_')}`);
    }
    return '';
}
/** 检测上游验证页，不能把 HTTP 200 当作正文就绪 */
export function riskPage(value: string): boolean { return ['环境异常', '访问过于频繁', '验证后继续', 'wappoc_appmsgcaptcha', 'TCaptcha', '请完成下方验证'].some(marker => value.includes(marker)); }
/** 由固定官方接口完成登录后的唯一 TS 公众号采集适配器 */
export class Collector {
    /** 当前用户的独立认证管理器 */
    auth: Auth;
    /** 绑定共享数据根目录，不接触旧项目 checkout */
    constructor(root: string) { this.auth = new Auth(root); }
    /** 根据账号凭据发起有限重试，频控不连续刷请求 */
    async api(path: string, params?: Record<string, string | number>, body?: unknown): Promise<Upstream> {
        for (let attempt = 0; attempt < 2; attempt++) {
            // 请求头每次重新读取，续期成功后立即使用新凭据。
            const headers = this.auth.headers();
            // 请求路径只能由适配层的固定接口调用构造。
            const url = new URL(`https://i.weread.qq.com${path}`);
            for (const [key, value] of Object.entries(params || {}))
                url.searchParams.set(key, String(value));
            // 每次网络失败最多重试一次，保留有界退避。
            let response: Response;
            try {
                response = await boundedFetch(url.href, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
            }
            catch (error) {
                if (attempt === 0) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }
                throw error;
            }
            // 原始响应只在内存分类，不写日志。
            const text = await response.text();
            // 401 时只允许一次账号续期，失败后要求重新扫码。
            if (response.status === 401) {
                if (attempt === 0 && await this.auth.refresh())
                    continue;
                throw new Problem('AUTH_REQUIRED', '登录已失效，请重新扫码', false, 'login');
            }
            // JSON 只作为数据解析，禁止执行上游响应。
            let data: Upstream = {};
            try {
                data = JSON.parse(text);
            }
            catch {
                if (response.status === 200)
                    throw new Problem('UPSTREAM_FORMAT', '上游返回了非 JSON 内容', true);
            }
            if (response.status === 499 && data.errcode === -2041 && attempt === 0) {
                if (await this.activate(headers))
                    continue;
            }
            if (response.status === 429 || (response.status === 499 && [-2014, -2041].includes(data.errcode)) || riskPage(text))
                throw new Problem('VERIFICATION_REQUIRED', '需要验证或请求受限，请在手机微信读书中处理后重试', false, 'verify', 3600);
            if (!response.ok || data.errcode)
                throw new Problem('UPSTREAM_REJECTED', '微信读书拒绝了该请求，请检查文章身份或稍后重试', true);
            return data;
        }
        throw new Problem('AUTH_REQUIRED', '请重新扫码登录', false, 'login');
    }
    /** 文章短链与长链都转换为稳定 MP_WXS_ 公众号身份 */
    async resolve(url: string): Promise<Resolution> {
        // 参数规范化与一期 URL 别名保持一致。
        url = canonicalUrl(url);
        // 长链携带 Base64 编码的公众号数字 ID。
        let biz = new URL(url).searchParams.get('__biz') || '', book = '', review = '';
        if (biz) {
            // 从公众号链接中解码得到的数字身份。
            const numeric = Buffer.from(biz, 'base64').toString();
            if (!/^\d+$/.test(numeric))
                throw new Problem('INVALID_IDENTITY', '链接中的公众号身份无效');
            book = `MP_WXS_${numeric}`;
        }
        // 短链可能只返回 reviewId，而没有独立 bookId。
        if (!book) {
            // 当前官方接口返回的业务数据。
            const data = await this.api('/mp/getreviewid', undefined, { urls: [url] });
            // 当前上游条目或分块结果，读取后进行边界校验。
            const item = (data.reviewIds || []).find((item: Upstream) => item.url === url);
            review = item?.reviewId || '';
            book = data.bookId || item?.bookId || '';
            if (!book) {
                // 只提取固定公众号前缀，文章后缀可以使用微信读书特有编码。
                const match = review.match(/^MP_WXS_(\d+)_/);
                if (match)
                    book = `MP_WXS_${match[1]}`;
            }
        }
        if (!/^MP_WXS_\d+$/.test(book))
            throw new Problem('IDENTITY_REQUIRED', '未能解析公众号身份，请使用有效文章链接');
        if (!biz)
            biz = Buffer.from(book.slice(7)).toString('base64');
        // 元信息名称仅用于展示，绝不作为主键。
        const info = await this.api('/book/info', { bookId: book });
        // 输入的历史文章需要独立元信息，不能依赖近期分页覆盖到它。
        const seed: DiscoveredArticle = { url, reviewId: review, title: `${info.title || '微信公众号'} · 链接文章`, publishedAt: null };
        if (review) {
            // 单篇文章元信息，用于补全标题、链接和发布时间。
            const detail = await this.api('/review/single', { reviewId: review });
            // 统一后的文章元信息字段。
            const meta = detail.review || detail;
            seed.title = meta.mpInfo?.title || seed.title;
            // 上游原始发布时间，不以采集时间替代。
            const timestamp = meta.createTime || meta.mpInfo?.time;
            if (timestamp)
                seed.publishedAt = utc(timestamp);
        }
        return { platformId: biz, bookId: book, originalName: info.title || '微信公众号', seedArticle: seed };
    }
    /** 按稳定 reviewId 分页，标题相同也不会丢弃条目 */
    async page(account: StoredAccount, offset: number, count: number): Promise<{
        items: DiscoveredArticle[];
        more: boolean;
    }> {
        // 上游分页可能返回多于请求 count 的记录，调度器按偏移和本轮上限处理。
        const data = await this.api('/mp/chapters', { bookId: account.bookId, offset, count, pf: 'android' });
        // 兼容已验证的三种列表字段。
        let rows: Upstream[] = data.data || data.chapters || data.list || [];
        if (!rows.length && offset === 0) {
            // 主列表为空时使用的备用文章列表。
            const fallback = await this.api('/article/list', { bookId: account.bookId, synckey: 0 });
            rows = (fallback.reviews || fallback.data || []).slice(0, count);
            if (!rows.length) {
                // 备用封面入口返回的文章标识。
                const cover = await this.api('/mp/cover', { bookId: account.bookId });
                if (cover.reviewId)
                    rows = [{ ...cover, mpInfo: { title: cover.title, doc_url: cover.doc_url } }];
            }
        }
        if (!Array.isArray(rows))
            throw new Problem('UPSTREAM_FORMAT', '文章列表格式已变化，需要更新采集程序');
        // 无法解析原文地址时明确失败，不将整轮伪装为成功空列表。
        const items: DiscoveredArticle[] = [];
        for (const row of rows) {
            // reviewId 中的短链可以直接定位原文。
            const info = row.mpInfo || {}, review = row.reviewId || '';
            // 原文地址优先，短链兜底不以标题定位，且不能直接使用编码后的波浪线。
            let url = articleUrl(info, review);
            if (!url && review) {
                // 单篇文章元信息，用于补全标题、链接和发布时间。
                const detail = await this.api('/review/single', { reviewId: review });
                // 单篇文章的原文定位信息。
                const metadata = (detail.review || detail).mpInfo || {};
                url = articleUrl(metadata, review);
            }
            if (!url)
                throw new Problem('ARTICLE_URL_MISSING', '文章缺少原文链接，本轮未计为成功', true);
            items.push({ url: canonicalUrl(url), title: info.title || row.title, reviewId: review, publishedAt: row.createTime || info.time ? utc(row.createTime || info.time) : null, summary: info.digest || '' });
        }
        return { items, more: data.hasMore === undefined ? rows.length >= count : !!data.hasMore };
    }
    /** 获取正文与图片，支持独立补图片而不重新抓取原文 */
    async download(article: Article, store: Store): Promise<Article> {
        // 延用一期磁盘下限，满盘时停止而非静默淘汰历史。
        const disk = statfsSync(store.root);
        if (disk.bavail * disk.bsize < 100 * 1024 * 1024)
            throw new Problem('DISK_FULL', '可用空间不足 100 MB，请释放空间', false, 'free_disk');
        // 已下载正文的图片补采只使用已提交内容版本。
        const raw = article.retryImages && article.contentVersion ? store.content({ ...article, state: 'ready' }) : await this.articleHtml(article);
        // 删除/屏蔽页保存墓碑状态，避免反复重试。
        if (['内容已被作者删除', '此内容因违规无法查看', '该内容暂时无法查看'].some(text => raw.includes(text)))
            throw new Problem('UNAVAILABLE', '文章已删除或不可用');
        if (riskPage(raw))
            throw new Problem('VERIFICATION_REQUIRED', '文章需要验证，请在微信打开原文处理', false, 'verify');
        // HTML 解析不执行脚本。
        const { document } = parseHTML(article.retryImages ? `<html><body>${raw}</body></html>` : raw);
        // 保留原文准确标题，避免历史链接停留在待下载占位名称。
        const title = document.querySelector('#activity-name,.rich_media_title') || document.querySelector('meta[property="og:title"]');
        if (title)
            article.title = (title.getAttribute('content') || title.textContent || article.title).trim().slice(0, 500);
        // 只接受明确文章正文容器，错误页不算正文就绪。
        const content = article.retryImages ? document.body : document.querySelector('#js_content,.rich_media_content,#js_article');
        if (!content || (!content.textContent?.trim() && !content.querySelector('img')))
            throw new Problem('EMPTY_CONTENT', '页面缺少有效正文，未计入阅读成功', true);
        // 删除脚本、表单与嵌入式执行内容，随后按标签白名单清理。
        for (const tag of content.querySelectorAll('script,style,iframe,object,embed,form,input,svg,math,link,meta,base'))
            tag.remove();
        // 临时目录不成为文章成功索引的一部分。
        const temporary = join(store.root, 'data/articles', `${article.id}.tmp`);
        rmSync(temporary, { recursive: true, force: true });
        mkdirSync(temporary, { mode: 0o700 });
        // 资源独立记录失败，文字成功不依赖全部图片成功。
        const assets: StoredAsset[] = [];
        for (const tag of Array.from(content.querySelectorAll('*'))) {
            // 白名单之外仅保留其文本子节点。
            if (!TAGS.has(tag.localName)) {
                tag.replaceWith(...Array.from(tag.childNodes));
                continue;
            }
            for (const attribute of Array.from(tag.attributes))
                if (!['src', 'href', 'data-src', 'alt', 'title', 'colspan', 'rowspan'].includes(attribute.name) || attribute.name.startsWith('on'))
                    tag.removeAttribute(attribute.name);
            if (tag.localName === 'a' && !/^https?:\/\//i.test(tag.getAttribute('href') || ''))
                tag.removeAttribute('href');
            if (tag.localName !== 'img') {
                tag.removeAttribute('src');
                tag.removeAttribute('data-src');
                continue;
            }
            // 无来源的装饰占位不计入缺图。
            let url = tag.getAttribute('data-src') || tag.getAttribute('src') || '';
            if (!url) {
                tag.remove();
                continue;
            }
            // 补图片时恢复原资源 URL，已成功资源可直接复用。
            const previous = (article.assets as StoredAsset[]).find(asset => `asset:${asset.id}` === url);
            if (previous)
                url = previous.sourceUrl || '';
            if (url.startsWith('//'))
                url = `https:${url}`;
            // 标准微信 CDN 可将存量 HTTP 地址安全升级为 HTTPS。
            if (url.startsWith('http://'))
                url = url.replace(/^http:/, 'https:');
            // 每个图片路径只使用内部摘要 ID。
            const id = previous?.id || sha(url).slice(0, 24);
            // 不暴露文件名到界面。
            const asset: StoredAsset = { id, file: `${id}.img`, state: 'failed', mime: 'application/octet-stream', sourceUrl: url };
            if (previous?.state === 'ready') {
                try {
                    copyFileSync(store.assetPath(article.id, id), join(temporary, asset.file));
                    asset.state = 'ready';
                    asset.mime = previous.mime;
                }
                catch { /* 已丢失的缓存需要重新下载。 */ }
            }
            if (asset.state !== 'ready') {
                try {
                    // 只允许微信图片 CDN，禁止任意网页驱动内网资源下载。
                    const parsed = new URL(url);
                    if (parsed.protocol !== 'https:' || !/(^|\.)(qpic|qlogo)\.cn$/.test(parsed.hostname))
                        throw new Error();
                    // 不跟随未经验证的资源重定向。
                    const response = await boundedFetch(url, { redirect: 'error' }, 20000);
                    // 实际 MIME 验证与读取大小上限共同约束资源。
                    const mime = response.headers.get('content-type')?.split(';')[0] || '';
                    if (!response.ok || !['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'].includes(mime))
                        throw new Error();
                    // 流式读取避免恶意超大响应耗尽内存。
                    const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
                    // 图片单资源限额沿用一期 20 MB。
                    let size = 0;
                    while (true) {
                        // 当前上游条目或分块结果，读取后进行边界校验。
                        const item = await reader.read();
                        if (item.done)
                            break;
                        size += item.value.byteLength;
                        if (size > 20 * 1024 * 1024) {
                            await reader.cancel();
                            throw new Error();
                        }
                        chunks.push(item.value);
                    }
                    writeFileSync(join(temporary, asset.file), Buffer.concat(chunks));
                    asset.state = 'ready';
                    asset.mime = mime;
                }
                catch { /* 缺图独立标记，正文仍然可读。 */ }
            }
            if (!assets.some(item => item.id === id))
                assets.push(asset);
            // 图片读取必须先鉴权，原文地址不直接进入插件 DOM。
            const alt = tag.getAttribute('alt') || '文章图片';
            for (const attribute of Array.from(tag.attributes))
                tag.removeAttribute(attribute.name);
            tag.setAttribute('src', `asset:${id}`);
            tag.setAttribute('alt', alt);
        }
        return store.commit(article, content.innerHTML, assets, temporary);
    }
    /** 浏览器检测使用显式位置，封装程序无需额外 Python 环境 */
    browserAvailable(): boolean { return BROWSERS.some(path => existsSync(path)); }
    /** 浏览器能力实际验证入口，不访问公众号或凭据 */
    async checkBrowser(): Promise<string> {
        // 按需加载浏览器能力，普通 HTTP 请求不启动浏览器。
        const { chromium } = await import('playwright-core');
        for (const path of BROWSERS) {
            if (!existsSync(path))
                continue;
            // 本轮独立浏览器实例，完成后始终关闭。
            const browser = await chromium.launch({ executablePath: path, headless: true });
            try {
                // 本轮读取的页面或分页结果。
                const page = await browser.newPage();
                await page.setContent('<p id="probe">ready</p>');
                if (await page.locator('#probe').textContent() !== 'ready')
                    throw new Error();
                return browser.version();
            }
            finally {
                await browser.close();
            }
        }
        throw new Problem('BROWSER_MISSING', '未检测到可用 Chrome 或 Edge');
    }
    /** 手机会话未激活时只做一次官方终端同步 */
    private async activate(headers: Record<string, string>): Promise<boolean> {
        try {
            // 与一期固定 mobileSync 字段保持兼容，不上报阅读内容。
            const keys = 'shelf bookInventory shelfLecture notifications config gift payItem balance reviewTimeline follower readingExchange chat chatRemovedSynckey wechatFriend inBackground refluxSynckey following applyList mcard discoverFeedSynckey rateSynckey browse medal medalUrl regionResource discoverColumnSynckey friendReviewSynckey wehearSyncKey'.split(' ');
            // 同步请求使用普通浏览器 UA，沿用既有激活流程。
            const payload: Record<string, string | number> = Object.fromEntries(keys.map(key => [key, 0]));
            Object.assign(payload, { preferTab: 1, localBrowseTab: '', localCommunityTab: '' });
            // 不把响应内容或认证头写日志。
            const h = { ...headers, 'User-Agent': MOBILE_UA };
            // 三个有界请求串行执行，失败不无限激活。
            const response = await boundedFetch('https://i.weread.qq.com/mobileSync', { method: 'POST', headers: h, body: JSON.stringify(payload) }, 8000);
            if (!response.ok)
                return false;
            await boundedFetch('https://i.weread.qq.com/shelf/sync?synckey=0', { headers: h }, 6000);
            await boundedFetch('https://i.weread.qq.com/mp/list?listType=0&count=50&synckey=0', { headers: h }, 6000);
            return true;
        }
        catch {
            return false;
        }
    }
    /** HTTP、微信读书正文和浏览器按顺序有限兜底 */
    private async articleHtml(article: Article): Promise<string> {
        // 不将“200 但无正文”作为 HTTP 抓取成功。
        let raw = '';
        try {
            // 当前有界网络请求的响应，仅在内存中处理。
            const response = await boundedFetch(canonicalUrl(article.url), { headers: { 'User-Agent': MOBILE_UA, 'X-Requested-With': 'com.tencent.mm' } }, 25000);
            if (response.ok) {
                raw = await response.text();
                if (!riskPage(raw) && /id=["']js_content["']|rich_media_content|已被作者删除|内容因违规/.test(raw))
                    return raw;
            }
        }
        catch { /* 转向已授权的微信读书正文接口。 */ }
        if (article.reviewId) {
            try {
                // 仅供当前官方接口使用的认证请求头。
                const h = this.auth.headers();
                // 当前有界网络请求的响应，仅在内存中处理。
                const response = await boundedFetch(`https://weread.qq.com/web/mp/content?reviewId=${encodeURIComponent(article.reviewId)}`, { headers: { Cookie: h.Cookie, 'User-Agent': h['User-Agent'], Referer: 'https://weread.qq.com/', Origin: 'https://weread.qq.com' } }, 15000);
                // 本轮取得的正文候选，后续仍需验证和清理。
                const html = await response.text();
                if (response.ok && /js_content|rich_media_content/.test(html))
                    return html;
            }
            catch { /* 最后尝试本机已安装的浏览器。 */ }
        }
        // 仅使用本机 Chrome/Edge，不自动安装或下载浏览器。
        const { chromium } = await import('playwright-core');
        for (const path of BROWSERS) {
            if (!existsSync(path))
                continue;
            // 浏览器未启动成功时不持有无效引用。
            let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
            try {
                browser = await chromium.launch({ executablePath: path, headless: true });
                // 本轮读取的页面或分页结果。
                const page = await browser.newPage({ userAgent: MOBILE_UA, viewport: { width: 414, height: 896 } });
                await page.goto(article.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
                await page.locator('#js_content,.rich_media_content,#js_article').first().waitFor({ timeout: 8000 }).catch(() => undefined);
                // 本轮取得的正文候选，后续仍需验证和清理。
                const html = await page.content();
                if (riskPage(html))
                    throw new Problem('VERIFICATION_REQUIRED', '浏览器页面仍需验证，请在手机处理', false, 'verify');
                if (/js_content|rich_media_content/.test(html))
                    return html;
            }
            catch (error) {
                if (error instanceof Problem)
                    throw error;
            }
            finally {
                await browser?.close();
            }
        }
        if (riskPage(raw))
            throw new Problem('VERIFICATION_REQUIRED', '文章需要验证，请在手机处理后重试', false, 'verify');
        if (!raw)
            throw new Problem(this.browserAvailable() ? 'DOWNLOAD_FAILED' : 'BROWSER_MISSING', this.browserAvailable() ? '正文下载失败，请稍后重试' : '正文需要浏览器兜底，请安装 Chrome 或 Edge', true);
        return raw;
    }
}
