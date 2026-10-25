import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as obsidian from 'obsidian';
import { RuntimeManager } from '../src/runtime/manager';
/** 实例测试不读写真实发现文件，也不启动本机程序 */
vi.mock('node:fs/promises',()=>{
  // 同时暴露 ESM 与 Node 默认导出，防止测试工具触发真实文件访问。
  const mock={readFile:vi.fn(),access:vi.fn(),stat:vi.fn()};
  return {...mock,default:mock};
});
/** 运行管理必须有界重试，并复用同用户已有实例 */
describe('附属程序生命周期',()=>{
  afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
  it('连续失败停止自动拉起，明确重试后才重新尝试',async()=>{
    vi.useFakeTimers();
    vi.mocked(fs.stat).mockRejectedValue(new Error('无实例'));
    vi.mocked(fs.access).mockRejectedValue(new Error('缺少程序'));
    // 记录接口不访问外部应用。
    const runtime=new RuntimeManager('/fixture/plugin',vi.fn());
    for(let count=0;count<5;count++){
      // 提前附加拒绝处理，避免假计时器产生未处理异常。
      const result=runtime.connect().catch(error=>error);
      await vi.runAllTimersAsync();
      expect(await result).toBeInstanceOf(Error);
    }
    expect(fs.access).toHaveBeenCalledTimes(3);
    // 用户明确重试重置失败计数。
    const retry=runtime.retry().catch(error=>error);
    await vi.runAllTimersAsync();
    await retry;
    expect(fs.access).toHaveBeenCalledTimes(4);
    await runtime.dispose();
  });
  it('健康实例复用且卸载仅释放当前库租约',async()=>{
    // 安全发现文件由当前用户独享。
    vi.mocked(fs.stat).mockResolvedValue({uid:process.getuid?.(),mode:0o100600} as never);
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({programId:'obsidian-wechat-reader-companion',apiVersion:1,engineVersion:'ts-1',instanceId:'fixture',port:54321,key:'fixture-key-with-sufficient-length-32'}));
    vi.mocked(fs.access).mockClear();
    // 按 URL 返回健康响应或客户端租约，不使用真实网络。
    const request=vi.spyOn(obsidian,'requestUrl').mockImplementation(async(options:any)=>({status:200,json:{data:options.url.endsWith('/health') ? {programId:'obsidian-wechat-reader-companion',apiVersion:1,engineVersion:'ts-1',instanceId:'fixture',capabilities:['power-save','portable-subscriptions']} : {id:'client-fixture'}}}) as never);
    // 对已有实例只能注册租约，不应访问或拉起可执行程序。
    const runtime=new RuntimeManager('/fixture/plugin',vi.fn());
    expect(await runtime.connect()).toBe(await runtime.connect());
    expect(fs.access).not.toHaveBeenCalled();
    await runtime.dispose();
    expect(request.mock.calls.some(([request]:any[])=>request.method==='DELETE' && request.url.endsWith('/v1/clients/client-fixture'))).toBe(true);
    await expect(runtime.connect()).rejects.toThrow('插件已卸载');
  });
  it('短操作空闲后释放租约，长操作与常驻模式持续保护连接', async () => {
    vi.useFakeTimers();
    vi.mocked(fs.stat).mockResolvedValue({uid:process.getuid?.(),mode:0o100600} as never);
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({programId:'obsidian-wechat-reader-companion',apiVersion:1,engineVersion:'ts-1',instanceId:'fixture',port:54321,key:'fixture-key-with-sufficient-length-32'}));
    const request=vi.spyOn(obsidian,'requestUrl').mockImplementation(async(options:any)=>({status:200,json:{data:options.url.endsWith('/health') ? {programId:'obsidian-wechat-reader-companion',apiVersion:1,engineVersion:'ts-1',instanceId:'fixture',capabilities:['power-save','portable-subscriptions']} : {id:'client-fixture'}}}) as never);
    const runtime=new RuntimeManager('/fixture/plugin',vi.fn());
    const release=await runtime.acquire();
    await vi.advanceTimersByTimeAsync(90000);
    expect(request.mock.calls.filter(([options]:any[])=>options.method==='DELETE')).toHaveLength(0);
    release();
    await vi.advanceTimersByTimeAsync(15001);
    expect(request.mock.calls.filter(([options]:any[])=>options.method==='DELETE')).toHaveLength(1);
    await runtime.setPersistent(true);
    await vi.advanceTimersByTimeAsync(90000);
    expect(request.mock.calls.filter(([options]:any[])=>options.method==='DELETE')).toHaveLength(1);
    await runtime.setPersistent(false);
    await vi.advanceTimersByTimeAsync(15001);
    expect(request.mock.calls.filter(([options]:any[])=>options.method==='DELETE')).toHaveLength(2);
    await runtime.dispose();
  });

});
