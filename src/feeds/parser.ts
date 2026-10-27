import { createHash } from 'node:crypto';
import type { Article, Asset, Feed, ImportFeed } from '../collector/types';
/** 为订阅和文章生成稳定摘要，保留不同源的身份边界 */
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 32); }
/** 仅接受明确的网络订阅地址，保留查询参数避免损坏私有订阅 */
export function feedUrl(value: string, base?: string): string {
    // URL 标准化只清理片段和默认端口，不修改业务查询条件。
    const url = new URL(value.trim(), base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('请输入有效的 HTTP/HTTPS 订阅地址');
    url.hash = '';
    return url.href;
}
/** 解析 XML 时拒绝文档实体和格式错误，不将 HTML 页面误当订阅 */
export function xmlDocument(value: string): Document {
    if (/<!DOCTYPE|<!ENTITY/i.test(value))
        throw new Error('订阅包含不支持的 XML 实体声明');
    // XML 解析器保留 RSS 和 Atom 命名空间。
    const document = new DOMParser().parseFromString(value, 'application/xml');
    if (document.querySelector('parsererror'))
        throw new Error('订阅 XML 格式不正确');
    return document;
}
/** 按本地名称读取直接子节点，避免跨条目误读取同名字段 */
function child(element: Element, names: string[]): Element | undefined { return Array.from(element.children).find(node => names.includes(node.localName)); }
/** 将来源日期转换为 UTC，无法确认时保留未知日期 */
function date(value?: string | null): string | null {
    // 不用当前时间伪装原文发布时间。
    const timestamp = Date.parse(value || '');
    return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}
/** 继承 XML 相对地址基准，用于 Atom 的 xml:base */
function xmlBase(element: Element, fallback: string): string {
    // 父层基准先解析，子层覆盖采用标准 URL 合并。
    const lineage: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement)
        lineage.unshift(node);
    for (const node of lineage) {
        // 当前层 XML 声明的相对地址基准。
        const base = node.getAttribute('xml:base');
        if (base)
            fallback = feedUrl(base, fallback);
    }
    return fallback;
}
/** 将正文中的远端图片转换为文章所有权下的资源占位 */
export function normalizeContent(value: string, base: string): {
    html: string;
    assets: Asset[];
} {
    // 隔离文档只用于解析，不直接挂载远端图片。
    const document = new DOMParser().parseFromString(value, 'text/html');
    // 资源 ID 稳定于原始地址，阅读时再鉴权/缓存读取。
    const assets: Asset[] = [];
    for (const image of Array.from(document.querySelectorAll('img'))) {
        try {
            // 懒加载地址优先，空装饰图片不计为缺图。
            const original = image.getAttribute('data-src') || image.getAttribute('src');
            if (!original) {
                image.remove();
                continue;
            }
            // 相对图片地址基于原文和 XML 声明解析。
            const url = feedUrl(original, base);
            // URL 摘要不作为跨文章可读取资源的授权。
            const id = digest(url);
            if (!assets.some(asset => asset.id === id))
                assets.push({ id, state: 'remote', mime: 'image/jpeg', sourceUrl: url });
            image.setAttribute('src', `asset:${id}`);
            image.removeAttribute('srcset');
            image.removeAttribute('data-src');
        }
        catch {
            image.replaceWith(document.createTextNode('[图片地址不可用]'));
        }
    }
    for (const link of Array.from(document.querySelectorAll('a[href]'))) {
        try {
            link.setAttribute('href', feedUrl(link.getAttribute('href')!, base));
        }
        catch {
            link.removeAttribute('href');
        }
    }
    return { html: document.body.innerHTML, assets };
}
/** 统一 RSS 2.0 与 Atom 字段，GUID 始终与所属订阅组合 */
export function parseFeed(value: string, feed: Feed): {
    title: string;
    kind: 'rss' | 'atom';
    articles: Article[];
} {
    // 只识别约定的根节点，网页地址需要用户提供实际 feed 地址。
    const document = xmlDocument(value);
    // Atom 和 RSS 的条目容器不同。
    const atom = document.documentElement.localName === 'feed';
    // RSS 根与频道必须有效，空列表也是合法订阅。
    const channel = atom ? document.documentElement : child(document.documentElement, ['channel']);
    if (!channel || (!atom && document.documentElement.localName !== 'rss'))
        throw new Error('该地址不是 RSS 2.0 或 Atom 订阅，请提供订阅 XML 地址');
    // 同一响应内重复条目只保留一个，不根据标题合并。
    const articles = new Map<string, Article>();
    for (const entry of Array.from(channel.children).filter(node => node.localName === (atom ? 'entry' : 'item'))) {
        // 原文相对地址可由 xml:base 指定。
        const base = xmlBase(entry, feed.url);
        // Atom 默认 alternate 链接作为原文，RSS 使用 link 文本。
        const link = atom ? Array.from(entry.children).find(node => node.localName === 'link' && (!node.getAttribute('rel') || node.getAttribute('rel') === 'alternate'))?.getAttribute('href') : child(entry, ['link'])?.textContent;
        // 源 ID 优先，缺失链接时仍可用 GUID 去重。
        const upstream = child(entry, [atom ? 'id' : 'guid'])?.textContent?.trim();
        // 只展示安全的 HTTP 原文入口。
        let url = feed.url;
        try {
            if (link?.trim())
                url = feedUrl(link, base);
        }
        catch { /* 无效原文入口回退到订阅地址。 */ }
        if (!upstream && !link?.trim())
            continue;
        // feedId 防止不同订阅复用 GUID 时串源。
        const id = `rss_${digest(`${feed.id}:${upstream || url}`)}`;
        // 优先使用真正正文；description/summary 明确作为摘要呈现。
        const content = atom ? child(entry, ['content']) : Array.from(entry.children).find(node => node.localName === 'encoded');
        // 摘要和纯文本正文都需要保持换行，不将远端代码执行。
        const summary = child(entry, atom ? ['summary'] : ['description']);
        // Atom XHTML 需要读取子树，其他类型使用文本中的 HTML 内容。
        const body = content || summary;
        // 摘要也可能采用 Atom XHTML，保持可读子树。
        const raw = body?.getAttribute('type') === 'xhtml' ? body.innerHTML : (body?.textContent || '');
        // 纯文本使用 DOM textContent 转义，不当作 HTML 插入。
        const plain = atom && (!body?.getAttribute('type') || body?.getAttribute('type') === 'text');
        // 纯文本容器只用于安全序列化。
        const escaped = createEl('p');
        escaped.textContent = raw;
        // 图片相对地址继承内容节点 xml:base。
        const normalized = normalizeContent(plain ? escaped.outerHTML : raw, body ? xmlBase(body, base) : base);
        articles.set(id, { id, accountId: feed.id, title: child(entry, ['title'])?.textContent?.trim() || '未命名文章', url,
            publishedAt: date(child(entry, atom ? ['published', 'updated'] : ['pubDate', 'date'])?.textContent), summary: summary?.textContent || '',
            state: normalized.html.trim() ? 'ready' : 'temporary_failure', assetState: 'ready', assets: normalized.assets, contentVersion: digest(normalized.html), html: normalized.html,
            contentKind: content ? 'full' : 'summary', author: child(entry, ['author', 'creator'])?.textContent?.trim() });
    }
    return { title: child(channel, ['title'])?.textContent?.trim() || feed.title, kind: atom ? 'atom' : 'rss', articles: [...articles.values()] };
}
/** OPML 只导入订阅配置，保留分组并预览无效项和重复 URL */
export function parseOpml(value: string, existing: Feed[]): ImportFeed[] {
    // 导入不读取原插件缓存或凭据。
    const document = xmlDocument(value);
    if (document.documentElement.localName !== 'opml')
        throw new Error('请选择 OPML 订阅清单');
    // 已有地址与本次导入条目共同参与去重。
    const seen = new Set(existing.map(feed => feed.url));
    // 保留非法地址以在预览中解释，而不是静默丢弃。
    const result: ImportFeed[] = [];
    for (const outline of Array.from(document.querySelectorAll('outline[xmlUrl]'))) {
        // 分组来自所有祖先 outline，名称不参与 feedId。
        const folders: string[] = [];
        for (let parent = outline.parentElement; parent?.localName === 'outline'; parent = parent.parentElement)
            folders.unshift(parent.getAttribute('text') || parent.getAttribute('title') || '未命名分组');
        // 清单名称只用于展示。
        const item: ImportFeed = { title: outline.getAttribute('title') || outline.getAttribute('text') || '未命名订阅', url: outline.getAttribute('xmlUrl') || '', folder: folders.join('/') };
        try {
            item.url = feedUrl(item.url);
            item.duplicate = seen.has(item.url);
            seen.add(item.url);
        }
        catch {
            item.error = '订阅地址无效';
        }
        result.push(item);
    }
    return result;
}
