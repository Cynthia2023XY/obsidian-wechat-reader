import { App, normalizePath, TFile } from 'obsidian';
import DOMPurify from 'dompurify';
import TurndownService from 'turndown';
import type { Article, CollectorProvider, ReadingState } from '../collector/types';

/** 将用户标题转换为适合笔记库的单段文件名 */
export function safeName(value: string): string { return Array.from(value, char => char.charCodeAt(0) < 32 || /[\\/:*?"<>|#[\]]/.test(char) ? '-' : char).join('').replace(/^\.+$/, '-').trim().slice(0, 90) || '未命名'; }
/** 验证归档目录，阻止绝对路径或路径穿越 */
export function archiveRoot(value: string, configDir: string): string {
  if (!value.trim() || /^(\/|\\|[a-z]:)/i.test(value) || value.split(/[\\/]/).some(segment => segment === '..') || normalizePath(value).toLowerCase() === normalizePath(configDir).toLowerCase() || normalizePath(value).toLowerCase().startsWith(`${normalizePath(configDir).toLowerCase()}/`)) throw new Error('请选择笔记库内的普通归档目录');
  return normalizePath(value);
}
/** 清理不可信 HTML，保留图片占位供阅读与导出分别处理 */
export function cleanArticle(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ['p','br','div','span','section','article','h1','h2','h3','h4','h5','h6','strong','b','em','i','u','s','blockquote','ul','ol','li','pre','code','table','thead','tbody','tr','th','td','hr','a','img','figure','figcaption'], ALLOWED_ATTR:['href','src','alt','title','colspan','rowspan'], ALLOW_DATA_ATTR: false, ADD_URI_SAFE_ATTR: ['src'] });
}
/** 将远端文本保存为被动 Markdown，避免被已安装的模板或查询插件执行 */
export function passiveMarkdown(value: string): string {return value.replace(/<%/g,'&lt;%').replace(/`(?=\$=|=)/g,'`\\');}
/** 通过 Vault API 保存正文和云端图片链接，重复保存默认打开已有笔记 */
export async function archiveArticle(app: App, _provider: CollectorProvider, article: Article, accountName: string, folder: string, state: ReadingState, open = true): Promise<ReadingState> {
  if (state.archive) {
    // 已归档笔记归用户维护，不覆盖其内容和当前文章版本。
    const existing = app.vault.getAbstractFileByPath(state.archive);
    if (existing instanceof TFile) { if (open) await app.workspace.getLeaf(false).openFile(existing); return state; }
  }
  if (article.state !== 'ready' || !article.html) throw new Error('正文尚未就绪，无法归档');
  // 保存目录经过校验后再创建。
  const root = archiveRoot(folder, app.vault.configDir);
  // 每个订阅来源使用独立目录。
  const directory = normalizePath(`${root}/${safeName(accountName)}`);
  // 逐层创建目录，兼容并发归档已经存在的文件夹。
  const ensureFolder = async (path: string): Promise<void> => {
    // Vault API 不保证递归创建父目录。
    let current = '';
    for (const part of path.split('/')) {
      current = current ? `${current}/${part}` : part;
      if (!app.vault.getAbstractFileByPath(current)) {
        try { await app.vault.createFolder(current); } catch (error) { if (!app.vault.getAbstractFileByPath(current)) throw error; }
      }
    }
  };
  await ensureFolder(directory);
  // 隔离 DOM 用于替换图片占位，不挂载不可信文章。
  const document = new DOMParser().parseFromString(cleanArticle(article.html), 'text/html');
  for (const image of Array.from(document.querySelectorAll('img'))) {
    // 只从当前文章声明的资源恢复原始地址，不导出本机缓存或鉴权端点。
    const asset = article.assets.find(item => image.getAttribute('src') === `asset:${item.id}`);
    try {
      // 只保存无用户名密码的网络图片链接，兼容未下载的远程图片。
      const url = new URL(asset?.sourceUrl || '');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || ['localhost', '[::1]', '0.0.0.0'].includes(url.hostname) || /^127\./.test(url.hostname) || url.hostname.endsWith('.localhost')) throw new Error('图片地址不可导出');
      image.setAttribute('src', url.href);
    } catch {
      image.replaceWith(document.createTextNode('[图片请查看原文]'));
    }
  }
  // 安全清理后的正文转换为普通 Markdown。
  const markdown = passiveMarkdown(new TurndownService({headingStyle:'atx', codeBlockStyle:'fenced'}).turndown(document.body));
  // 文件名与归档元数据共用保存时刻，文件日期采用用户电脑的本地日期。
  const savedAt = new Date();
  // 按本地年月日生成日期，避免 UTC 日期在午夜前后偏移一天。
  const savedDate = `${savedAt.getFullYear()}-${String(savedAt.getMonth() + 1).padStart(2, '0')}-${String(savedAt.getDate()).padStart(2, '0')}`;
  // YAML 字符串使用 JSON 双引号编码，防止标题破坏 frontmatter。
  const frontmatter = Object.entries({ source:article.id.startsWith('rss_')?'RSS':'微信公众号', contentKind:article.contentKind || 'full', accountId:article.accountId, articleId:article.id, originalUrl:article.url, publishedAt:article.publishedAt, archivedAt:savedAt.toISOString(), contentVersion:article.contentVersion }).map(([key,value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  // 碰撞时生成新副本，不根据标题覆盖其他文件。
  const base = `${directory}/${savedDate} ${safeName(article.title)}`;
  // 新副本序号用于保护用户已存在但未关联的文件。
  let path = `${base}.md`;
  for (let suffix = 2; app.vault.getAbstractFileByPath(path); suffix++) path = `${base} (${suffix}).md`;
  // 文件创建成功后调用方才持久化归档关联。
  const file = await app.vault.create(path, `---\n${frontmatter}\n---\n\n# ${article.title.replace(/[\r\n]/g, ' ')}\n\n${markdown}\n\n[阅读原文](${article.url})\n`);
  if (open) await app.workspace.getLeaf(false).openFile(file);
  return {...state, archive:path, version:article.contentVersion};
}
