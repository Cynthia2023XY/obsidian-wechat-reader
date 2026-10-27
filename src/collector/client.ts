import { requestUrl } from 'obsidian';
import type { Asset, CollectorProvider, Health } from './types';

/** 私有发现文件内容，仅驻留内存，绝不写入插件 data.json */
export interface Discovery { programId: string; apiVersion: number; engineVersion: string; instanceId: string; port: number; key: string }
/** HTTP 错误保留协议码供租约与重连逻辑判断 */
export class CollectorFailure extends Error {
  /** 用协议错误创建用户可读异常 */
  constructor(message: string, public code: string) { super(message); }
}
/** 使用 Obsidian requestUrl 访问受保护的本机程序 */
export class LocalCollectorClient implements CollectorProvider {
  /** 保存已验证的本机发现信息 */
  constructor(private discovery: Discovery) {}
  /** 按固定回环地址构造请求，拒绝将密钥发往其他主机 */
  private url(path: string): string {
    if (!path.startsWith('/v1/') || path.includes('..') || !Number.isInteger(this.discovery.port) || this.discovery.port < 1 || this.discovery.port > 65535) throw new Error('采集程序地址无效');
    return `http://127.0.0.1:${this.discovery.port}${path}`;
  }
  /** 发起 JSON API 请求并统一转换结构化错误 */
  async call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    // 请求密钥只在头部传递，避免进入图片地址或归档正文。
    const response = await requestUrl({ url: this.url(path), method, headers: { 'X-Reader-Key': this.discovery.key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), throw: false });
    // 仅读取服务明确返回的业务错误，避免泄露响应正文。
    const result = response.json as { data?: T; error?: { message?: unknown; code?: unknown } };
    if (!result || typeof result !== 'object') throw new CollectorFailure('采集程序响应格式无效', 'PROTOCOL');
    if (response.status >= 400 || result.error) throw new CollectorFailure(typeof result.error?.message === 'string' ? result.error.message : '采集程序请求失败', typeof result.error?.code === 'string' ? result.error.code : 'NETWORK');
    return result.data as T;
  }
  /** 健康检查同时验证固定身份和当前实例，防止复用错误服务 */
  async health(): Promise<Health> {
    // 程序与发现文件必须属于同一实例和协议。
    const health = await this.call<Health>('/v1/health');
    if (health.programId !== 'obsidian-wechat-reader-companion' || health.apiVersion !== 1 || health.engineVersion !== 'ts-1' || health.instanceId !== this.discovery.instanceId) throw new Error('本机采集程序版本或身份不兼容');
    return health;
  }
  /** 先鉴权下载图片，再由插件生成受控本地显示资源 */
  async asset(articleId: string, asset: Asset): Promise<ArrayBuffer> {
    // ID 编码避免调用方拼入路径或查询参数。
    const response = await requestUrl({ url: this.url(`/v1/articles/${encodeURIComponent(articleId)}/assets/${encodeURIComponent(asset.id)}`), headers: { 'X-Reader-Key': this.discovery.key }, throw: false });
    if (response.status !== 200) throw new Error('图片读取失败');
    return response.arrayBuffer;
  }
  /** 导出 RSS 文件供兼容阅读器使用，不包含访问密钥 */
  async rss(accountId: string): Promise<string> {
    // RSS 响应为 XML，不经 JSON 协议解码。
    const response = await requestUrl({url: this.url(`/v1/feeds/${encodeURIComponent(accountId)}.xml`), headers: {'X-Reader-Key': this.discovery.key}, throw: false});
    if (response.status !== 200) throw new Error('RSS 导出失败');
    return response.text;
  }
}
