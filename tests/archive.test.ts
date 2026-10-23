import { describe, it, expect, vi } from 'vitest';
import { archiveArticle, archiveRoot, cleanArticle, safeName } from '../src/archive/archive';
import { TFile } from 'obsidian';
import type { Article } from '../src/collector/types';

/** 归档安全与用户编辑保护是跨设备离线阅读的关键约束 */
describe('离线归档与正文安全',()=>{
  it('拒绝绝对路径、上级目录与插件配置目录',()=>{
    for (const value of ['/tmp/escape','../escape','notes/../escape','C:\\escape','.obsidian/plugins','']) expect(()=>archiveRoot(value)).toThrow();
    expect(archiveRoot('公众号阅读/科技')).toBe('公众号阅读/科技');
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
  it('归档下载图片、生成相对链接及可独立阅读的 Markdown',async()=>{
    // 内存文件系统保留所有写入作为检查证据。
    const files=new Map<string,unknown>();
    // 使用真实 TFile 类型识别现有归档行为。
    const create=vi.fn(async(path:string,text:string)=>{const file=new TFile();file.path=path;files.set(path,text);return file;});
    // 归档只通过 Vault API 写入，无 Node 绝对路径写操作。
    const app={vault:{getAbstractFileByPath:(path:string)=>files.get(path),createFolder:async(path:string)=>{files.set(path,{});},createBinary:async(path:string,bytes:ArrayBuffer)=>{files.set(path,bytes);},create},workspace:{getLeaf:()=>({openFile:vi.fn()})}};
    // 模拟鉴权资源请求，响应不包含 Cookie 或密钥。
    const provider={asset:vi.fn(async()=>new ArrayBuffer(4))};
    // 带引号标题验证 YAML 可安全编码。
    const article={id:'article_12345678',accountId:'account_one',title:'标题 "测试"',url:'https://mp.weixin.qq.com/s/test',publishedAt:'2026-10-23T00:00:00Z',state:'ready',contentVersion:'v1',html:'<p>离线正文</p><img src="asset:abc">',assets:[{id:'abc',mime:'image/png',state:'ready'}]} as Article;
    // 保存结果中的关联版本必须在文件写入成功后产生。
    const state=await archiveArticle(app as never,provider as never,article,'科技','公众号阅读',{});
    expect(state.archive).toContain('12345678.md');
    expect(provider.asset).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][1]).toContain('assets/article_12345678/abc-v1.png');
    expect(create.mock.calls[0][1]).toContain('离线正文');
    expect(create.mock.calls[0][1]).not.toContain('localhost');
    expect(create.mock.calls[0][1]).not.toContain('tags:');
    expect([...files.keys()]).toContain('公众号阅读/科技/assets/article_12345678/abc-v1.png');
  });
  it('未就绪文章不生成空正文笔记',async()=>{
    await expect(archiveArticle({} as never,{} as never,{state:'temporary_failure'} as Article,'号','阅读',{})).rejects.toThrow('正文尚未就绪');
  });
});
