import { vi } from 'vitest';

/** 模拟 Obsidian 全局元素助手；业务代码不直接创建原生元素 */
vi.stubGlobal('createEl', (tag: string) => document.createElement(tag));
/** 撤销通知通过宿主助手构建无脚本片段 */
vi.stubGlobal('createFragment', () => document.createDocumentFragment());
