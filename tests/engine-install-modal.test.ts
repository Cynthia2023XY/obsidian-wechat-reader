import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineInstallModal } from '../src/views/engine-install-modal';
import type { EngineInstaller } from '../src/runtime/engine-installer';
const platform = process.platform, arch = process.arch;
beforeAll(() => {
    Object.assign(HTMLElement.prototype, {
        empty() { this.replaceChildren(); }, setText(value: string) { this.textContent = value; },
        createEl(tag: string, options: { text?: string; attr?: Record<string, string>; href?: string } = {}) {
            const element = document.createElement(tag);
            element.textContent = options.text || '';
            if (options.href) element.setAttribute('href', options.href);
            for (const [key, value] of Object.entries(options.attr || {})) element.setAttribute(key, value);
            this.append(element); return element;
        },
    });
});
beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
});
afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    Object.defineProperty(process, 'arch', { value: arch }); document.body.replaceChildren();
});
function fixture(install = vi.fn(async () => {})) {
    const installer = { install, cancel: vi.fn(), busy: false };
    const done = vi.fn();
    const modal = new EngineInstallModal({} as never, installer as unknown as EngineInstaller, '/fixture/plugin', done); modal.open();
    return { modal, installer, done, buttons: () => [...modal.contentEl.querySelectorAll('button')] };
}
describe('可选引擎安装的确认入口', () => {
    it('展示来源和大小，打开弹窗不安装；明确点击才安装', async () => {
        const { modal, installer, done, buttons } = fixture();
        expect(modal.contentEl.textContent).toContain('45.5 MiB');
        expect(modal.contentEl.querySelector('a')?.href).toContain('github.com/');
        expect(installer.install).not.toHaveBeenCalled();
        buttons()[0].click();
        await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
        expect(installer.install).toHaveBeenCalledTimes(1);
        expect(buttons()[0].disabled).toBe(true); modal.close();
    });
    it('失败显示重试入口，不自动循环重试', async () => {
        const { modal, installer, done, buttons } = fixture(vi.fn(async () => { throw new Error('下载校验失败'); }));
        buttons()[0].click();
        await vi.waitFor(() => expect(buttons()[0].textContent).toBe('重试安装'));
        expect(buttons()[0].disabled).toBe(false); expect(done).not.toHaveBeenCalled();
        expect(installer.install).toHaveBeenCalledTimes(1); modal.close();
    });
    it('关闭进行中的安装会取消；不支持的平台禁止下载', async () => {
        let reject!: (error: Error) => void;
        const result = fixture(vi.fn(() => new Promise<void>((_, failed) => { reject = failed; })));
        result.buttons()[0].click(); result.modal.close();
        expect(result.installer.cancel).toHaveBeenCalledTimes(1);
        reject(new Error('已取消')); await Promise.resolve();
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const unsupported = fixture();
        expect(unsupported.buttons()[0].disabled).toBe(true);
        unsupported.buttons()[0].click(); expect(unsupported.installer.install).not.toHaveBeenCalled(); unsupported.modal.close();
    });
});
