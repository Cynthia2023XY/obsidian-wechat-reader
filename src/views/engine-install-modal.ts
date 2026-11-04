import { Modal, Notice, Setting } from 'obsidian';
import { ENGINE_PACKAGE, engineSupported } from '../runtime/engine-package';
import type { EngineInstaller } from '../runtime/engine-installer';
/** 下载之前展示来源、空间与目标目录；仅确认按钮触发安装。 */
export class EngineInstallModal extends Modal {
    private active = false;
    constructor(app: Modal['app'], private installer: EngineInstaller, private target: string, private done: () => void) { super(app); }
    onOpen(): void {
        const root = this.contentEl;
        new Setting(root).setName('安装公众号引擎').setHeading();
        root.createEl('p', { text: `可选功能：普通 RSS/Atom 无需安装。将下载公众号引擎 ${ENGINE_PACKAGE.version}，约 ${(ENGINE_PACKAGE.bytes / 1024 / 1024).toFixed(1)} MiB，解压后约 150 MiB。` });
        root.createEl('p', { text: '当前支持 macOS Apple Silicon；安装完成后再开启公众号功能并扫码。不会自动更新引擎，也不会替换订阅、阅读记录或归档。已有引擎与正在运行的采集程序保持原状，下次新启动时使用安装的版本。' });
        root.createEl('a', { text: '下载来源：GitHub · 1.0.0 完整安装包', href: ENGINE_PACKAGE.url, attr: { target: '_blank', rel: 'noopener noreferrer' } });
        root.createEl('p', { text: `保存位置：${this.target}/wechat-engine-…（独立版本目录）` });
        const message = root.createEl('p', { text: '点击后下载并校验安装包。网络不通时可以重试，或手动安装完整包。', attr: { 'aria-live': 'polite' } });
        const progress = root.createEl('progress', { attr: { max: '100', value: '0', 'aria-label': '引擎安装进度' } });
        const install = root.createEl('button', { text: '下载并安装' });
        const cancel = root.createEl('button', { text: '取消' });
        install.disabled = !engineSupported() || this.installer.busy;
        if (!engineSupported()) message.setText('此引擎仅支持 macOS Apple Silicon，普通 RSS/Atom 可继续使用。');
        cancel.onclick = () => { if (this.active) this.installer.cancel(); else this.close(); };
        install.onclick = () => {
            install.disabled = true; this.active = true;
            void this.installer.install(value => {
                message.setText(value.received === undefined ? value.phase : `${value.phase}：${(value.received / 1024 / 1024).toFixed(1)} / ${(ENGINE_PACKAGE.bytes / 1024 / 1024).toFixed(1)} MiB`);
                if (value.received === undefined) progress.removeAttribute('value');
                else progress.value = value.received / ENGINE_PACKAGE.bytes * 100;
            }).then(() => {
                progress.value = 100;
                new Notice('公众号引擎已安装，请启用微信公众号并扫码登录');
                this.done();
                install.setText('安装完成');
            }).catch((error: unknown) => {
                message.setText(error instanceof Error ? error.message : '安装失败，请重试');
                install.setText('重试安装'); install.disabled = false;
            }).finally(() => { this.active = false; cancel.setText('关闭'); });
        };
    }
    onClose(): void { if (this.active) this.installer.cancel(); this.contentEl.empty(); }
}
