/** 测试专用笔记文件标识，不加载真实 Obsidian 运行时 */
export class TFile {
  /** 当前笔记库内的相对路径 */
  path = '';
}
/** 测试保持与项目使用方式一致的路径分隔符 */
export function normalizePath(value: string): string {return value.replace(/\/+/g,'/');}
/** 测试必须显式替换网络请求，不允许意外访问真实采集实例 */
export async function requestUrl(_request: unknown): Promise<unknown> {throw new Error('测试未提供网络响应');}
