/** 测试专用笔记文件标识，不加载真实 Obsidian 运行时 */
export class TFile {
  /** 当前笔记库内的相对路径 */
  path = '';
}
/** 测试保持与项目使用方式一致的路径分隔符 */
export function normalizePath(value: string): string {return value.replace(/\/+/g,'/');}
/** 测试必须显式替换网络请求，不允许意外访问真实采集实例 */
export async function requestUrl(_request: unknown): Promise<unknown> {throw new Error('测试未提供网络响应');}
/** 原生模态的测试替身，仅记录作用域注册，不影响真实应用 */
export class Modal {
  /** 测试内的模态外壳 */
  modalEl=document.createElement('div');
  /** 模态正文挂载点 */
  contentEl=document.createElement('div');
  /** 方向键只注册到当前模态的作用域 */
  scope={handlers:new Map<string,(event:KeyboardEvent)=>unknown>(),register:(_modifiers:string[],key:string,callback:(event:KeyboardEvent)=>unknown)=>{this.scope.handlers.set(key,callback);}};
  /** 应用对象不需要加载真实 Obsidian */
  constructor(public app:unknown){this.modalEl.append(this.contentEl);}
  /** 模拟打开并挂载 DOM */
  open():void{document.body.append(this.modalEl);(this as unknown as {onOpen:()=>void}).onOpen();}
  /** 模拟关闭并触发生命周期 */
  close():void{(this as unknown as {onClose:()=>void}).onClose();this.modalEl.remove();}
}
/** 提示只供断言，不显示系统通知 */
export class Notice {/** 保存提示文本 */ constructor(public message:string) {}}
/** 本组测试未使用设置控件，保留导出供模块加载 */
export class Setting {}
/** 订阅面板使用的原生视图与菜单替身。 */
export class ItemView {
  contentEl = document.createElement('div');
  containerEl = this.contentEl;
  constructor(public leaf: unknown) {}
}
export function setIcon(element: HTMLElement, name: string): void { element.dataset.icon = name; }
export class Menu {
  static latest: Menu;
  items: Array<{ title: string; click: () => unknown }> = [];
  addItem(build: (item: any) => unknown): this {
    const value = { title: '', click: () => {} };
    const item = { setTitle: (title: string) => { value.title = title; return item; }, setIcon: () => item, onClick: (click: () => unknown) => { value.click = click; return item; } };
    build(item); this.items.push(value); return this;
  }
  showAtMouseEvent(): void { Menu.latest = this; }
}
