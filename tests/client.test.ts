import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as obsidian from 'obsidian';
import { PythonCollectorClient, CollectorFailure } from '../src/collector/client';
/** 测试固定的程序发现夹具不含真实凭据 */
const discovery={programId:'obsidian-wechat-reader-companion',apiVersion:1,engineVersion:'0.1.0',instanceId:'fixture-instance',port:54321,key:'fixture-key-only-for-tests'};
/** 本机 Provider 必须验证程序身份，密钥不得进入文章 URL */
describe('本机 CollectorProvider',()=>{
  beforeEach(()=>{vi.restoreAllMocks();});
  it('鉴权只通过请求头，POST 明确使用 JSON',async()=>{
    // 返回一个已排队任务，不访问真实端口。
    const request=vi.spyOn(obsidian,'requestUrl').mockResolvedValue({status:202,json:{data:{jobId:'fixture'}}} as never);
    // 实例发现来自私有目录的固定夹具。
    const client=new PythonCollectorClient(discovery);
    expect(await client.call('/v1/accounts/one/sync','POST',{})).toEqual({jobId:'fixture'});
    expect(request.mock.calls[0][0]).toMatchObject({url:'http://127.0.0.1:54321/v1/accounts/one/sync',headers:{'X-Reader-Key':discovery.key,'Content-Type':'application/json'},body:'{}'});
    expect(String((request.mock.calls[0][0] as {url:string}).url)).not.toContain(discovery.key);
  });
  it('拒绝程序身份相同但实例已经变化的响应',async()=>{
    vi.spyOn(obsidian,'requestUrl').mockResolvedValue({status:200,json:{data:{programId:discovery.programId,apiVersion:1,engineVersion:'0.1.0',instanceId:'other'}}} as never);
    await expect(new PythonCollectorClient(discovery).health()).rejects.toThrow('身份不兼容');
  });
  it('拒绝旧 API 或不兼容引擎，不能只依据端口可用',async()=>{
    vi.spyOn(obsidian,'requestUrl').mockResolvedValue({status:200,json:{data:{programId:discovery.programId,apiVersion:2,engineVersion:'0.1.0',instanceId:discovery.instanceId}}} as never);
    await expect(new PythonCollectorClient(discovery).health()).rejects.toThrow('不兼容');
  });
  it('阻止调用方拼入其他主机或路径穿越',async()=>{
    // 即使调用方传入危险路径，也不产生网络请求。
    const request=vi.spyOn(obsidian,'requestUrl');
    await expect(new PythonCollectorClient(discovery).call('https://evil.example/v1/health')).rejects.toThrow('地址无效');
    await expect(new PythonCollectorClient(discovery).call('/v1/../../etc/passwd')).rejects.toThrow('地址无效');
    expect(request).not.toHaveBeenCalled();
  });
  it('保留可恢复协议码且不泄露服务器原始诊断内容',async()=>{
    vi.spyOn(obsidian,'requestUrl').mockResolvedValue({status:401,json:{error:{code:'AUTH_REQUIRED',message:'请重新扫码'},internal:'不应展示'}} as never);
    await expect(new PythonCollectorClient(discovery).call('/v1/auth/status')).rejects.toMatchObject({code:'AUTH_REQUIRED',message:'请重新扫码'});
  });
  it('RSS 使用 XML 响应且不插入实例访问密钥',async()=>{
    // 文件导出读取 text，不对 XML 调用 JSON 解码。
    const request=vi.spyOn(obsidian,'requestUrl').mockResolvedValue({status:200,text:'<rss version="2.0"/>'} as never);
    expect(await new PythonCollectorClient(discovery).rss('account_one')).toContain('<rss');
    expect(request.mock.calls[0][0]).toMatchObject({url:'http://127.0.0.1:54321/v1/feeds/account_one.xml'});
  });
});
