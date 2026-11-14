import { describe, it, expect, vi } from 'vitest';
import { archiveArticle, archiveRoot, cleanArticle, safeName, passiveMarkdown } from '../src/archive/archive';
import { TFile } from 'obsidian';
import type { Article } from '../src/collector/types';

/** 归档安全与用户编辑保护确保保存过程不破坏已有笔记 */
describe('Markdown 归档与正文安全',()=>{
  it('拒绝绝对路径、上级目录与插件配置目录',()=>{
    for (const value of ['/tmp/escape','../escape','notes/../escape','C:\\escape','配置目录/plugins','']) expect(()=>archiveRoot(value, '配置目录')).toThrow();
    expect(archiveRoot('公众号阅读/科技', '配置目录')).toBe('公众号阅读/科技');
    expect(() => archiveRoot('配置目录', '配置目录')).toThrow();
    expect(() => archiveRoot('Config/plugins', 'config')).toThrow();
    expect(archiveRoot('config-notes', 'config')).toBe('config-notes');
  });
  it('文件名不能注入路径或 frontmatter 控制字符',()=>{
    expect(safeName('../坏:标题\n[注入]')).not.toMatch(/[\/:\n\[\]]/);
  });
  it('清理脚本、事件、iframe、SVG 和危险协议',()=>{
    // 恶意文章不能执行代码或绕过应用容器。
    const clean=cleanArticle('<p onclick="alert(1)">文字<script>alert(1)</script><iframe src="https://evil"></iframe><svg onload="alert(1)"></svg><a href="javascript:alert(1)">链接</a></p>');
    expect(clean).toContain('文字');
    expect(clean).not.toMatch(/onclick|script|iframe|svg|javascript:/i);
  });
  it('远端模板与内联查询保持被动文本',()=>{
    expect(passiveMarkdown('<% code %> `\$= dangerous()` `= value`')).toBe('&lt;% code %> `\\$= dangerous()` `\\= value`');
  });
  it('保留本地资源 ID 用于鉴权替换',()=>{
    expect(cleanArticle('<img src="asset:abc" alt="图">')).toContain('asset:abc');
  });
  it('重复归档打开现有文件且不覆盖用户编辑',async()=>{
    // 已有关联笔记必须复用，即使文章标题已经改变。
    const file=new TFile();
    // 只注入本例需要的 Vault 行为。
    const app={vault:{getAbstractFileByPath:()=>file,create:vi.fn()},workspace:{getLeaf:()=>({openFile:vi.fn()})}};
    // 正文无需重新读取即可打开原归档。
    const state={archive:'阅读/用户改过的文章.md',version:'old'};
    expect(await archiveArticle(app as never,{} as never,{} as Article,'公众号','阅读',state)).toBe(state);
    expect(app.vault.create).not.toHaveBeenCalled();
  });
  it.each([
    ['RSS', 'rss_12345678', 'https://example.com/photo.webp', true],
    ['公众号', 'article_12345678', 'https://mmbiz.qpic.cn/photo.png', true],
    ['缺少来源', 'article_12345678', undefined, false],
    ['本机资源', 'rss_12345678', 'http://127.0.0.1:8080/secret', false],
    ['本机域名', 'rss_12345678', 'http://localhost/secret', false],
    ['带凭据地址', 'rss_12345678', 'https://user:secret@example.com/photo', false],
    ['危险协议', 'rss_12345678', 'javascript:alert(1)', false],
  ])('%s 保存当天日期、无哈希且不下载图片', async (_label, id, sourceUrl, allowed) => {
    // 固定本地午夜后的保存时间，验证日期不依赖文章发布日期或 UTC 日期。
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 14, 0, 5));
    try {
      // 内存文件系统保留所有写入作为检查证据。
      const files = new Map<string, unknown>();
      // 使用真实文件类型，以便再次保存时复用已关联的笔记。
      const create = vi.fn(async (path: string, text: string) => {
        // 模拟 Obsidian 创建的文件对象，并保留正文便于验证。
        const file = new TFile();
        file.path = path;
        files.set(path, file);
        return file;
      });
      // 图片下载和二进制写入均应保持未调用。
      const app = { vault: { configDir: '配置目录', getAbstractFileByPath: (path: string) => files.get(path), createFolder: vi.fn(async (path: string) => { files.set(path, {}); }), createBinary: vi.fn(), create }, workspace: { getLeaf: () => ({ openFile: vi.fn() }) } };
      // 保存 Markdown 不依赖图片请求成功或资源下载状态。
      const provider = { asset: vi.fn() };
      // 带引号标题验证安全文件名和原始标题互不干扰。
      const article = { id, accountId: 'account_one', title: '标题 "测试"', url: 'https://example.com/article', publishedAt: '2026-10-23T00:00:00Z', state: 'ready', contentVersion: 'v1', html: '<p>文章正文</p><img src="asset:abc" alt="插图">', assets: [{ id: 'abc', mime: 'image/png', state: 'remote', sourceUrl }] } as Article;
      // 保存日期只用于命名，原始发布日期继续保留在元数据中。
      const state = await archiveArticle(app as never, provider as never, article, '科技', '公众号阅读', {}, false);
      expect(state.archive).toBe('公众号阅读/科技/2026-11-14 标题 -测试-.md');
      expect(provider.asset).not.toHaveBeenCalled();
      expect(app.vault.createBinary).not.toHaveBeenCalled();
      expect([...files.keys()].some(path => path.includes('/assets'))).toBe(false);
      // 验证导出只含公网图片来源，不包含内部占位和下载文件路径。
      const markdown = create.mock.calls[0][1];
      expect(markdown).toContain('文章正文');
      expect(markdown).toContain('publishedAt: "2026-10-23T00:00:00Z"');
      expect(markdown).toContain(`archivedAt: "${new Date().toISOString()}"`);
      expect(markdown).not.toContain('asset:');
      if (allowed) expect(markdown).toContain(`![插图](${sourceUrl})`);
      else {
        expect(markdown).toContain('图片请查看原文');
        if (sourceUrl) expect(markdown).not.toContain(sourceUrl);
      }
      // 已保存文章再次保存复用原笔记，不生成副本。
      expect(await archiveArticle(app as never, provider as never, article, '科技', '公众号阅读', state, false)).toBe(state);
      expect(create).toHaveBeenCalledTimes(1);
      // 未关联的同名文章依序添加副本号，保护已有文件。
      files.set('公众号阅读/科技/2026-11-14 标题 -测试- (2).md', new TFile());
      expect((await archiveArticle(app as never, provider as never, article, '科技', '公众号阅读', {}, false)).archive).toBe('公众号阅读/科技/2026-11-14 标题 -测试- (3).md');
    } finally {
      vi.useRealTimers();
    }
  });
  it('未就绪文章不生成空正文笔记',async()=>{
    await expect(archiveArticle({} as never,{} as never,{state:'temporary_failure'} as Article,'号','阅读',{})).rejects.toThrow('正文尚未就绪');
  });
});
