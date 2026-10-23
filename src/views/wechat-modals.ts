import { Modal, Notice, Setting } from 'obsidian';
import type WeChatReaderPlugin from '../main';
import type { Account, Login, Resolution } from '../collector/types';
/** 登录状态的中文展示 */
const LOGIN_LABELS: Record<string, string> = { scanning: '请用微信扫描二维码', scanned: '已扫码，请在手机确认', success: '登录成功，可以添加公众号', failed: '登录失败，请重新获取二维码', expired: '二维码已过期，请重新扫码', idle: '尚未开始登录' };
/** 用户确认后才提交订阅，不创建身份不完整的空订阅 */
export class SubscribeModal extends Modal {
    /** 暂存解析成功的真实身份 */
    private resolution?: Resolution;
    /** 当前待确认的公众号显示名称 */
    private name = '';
    /** 当前粘贴的原文链接 */
    private url = '';
    /** 绑定当前库和完成回调 */
    constructor(private plugin: WeChatReaderPlugin, private done: () => Promise<void>) { super(plugin.app); }
    /** 两步引导：先解析身份，再确认名称和订阅 */
    onOpen(): void {
        this.contentEl.createEl('h2', { text: '添加公众号' });
        this.contentEl.createEl('p', { text: '粘贴任意一篇公众号文章链接。首次优先下载这篇原文，并同步近期文章，每轮最多 10 篇。' });
        new Setting(this.contentEl).setName('文章链接').addText(text => text.setPlaceholder('https://mp.weixin.qq.com/s/…').onChange(value => { this.url = value; this.resolution = undefined; }));
        // 身份展示只由已验证 API 填充。
        const identity = this.contentEl.createDiv({ cls: 'wr-status' });
        new Setting(this.contentEl).addButton(button => button.setButtonText('解析公众号').setCta().onClick(async () => {
            button.setDisabled(true);
            try {
                this.resolution = await (await this.plugin.provider()).call<Resolution>('/v1/accounts/resolve', 'POST', { url: this.url });
                this.name = this.resolution.originalName;
                identity.setText(`名称：${this.resolution.originalName} · ID：${this.resolution.bookId}。请在下方确认显示名称。`);
                nameInput.setValue(this.name === '微信公众号' ? '' : this.name);
            }
            catch (error) {
                identity.setText(error instanceof Error ? error.message : '解析失败');
            }
            finally {
                button.setDisabled(false);
            }
        }));
        // 显示名称可编辑，但不能充当身份主键。
        let nameInput: import('obsidian').TextComponent;
        new Setting(this.contentEl).setName('显示名称').setDesc('识别到占位名称时必须手动补充。').addText(text => { nameInput = text; text.onChange(value => { this.name = value; }); });
        new Setting(this.contentEl).addButton(button => button.setButtonText('确认订阅').setCta().onClick(async () => {
            if (!this.resolution || !this.name.trim() || ['微信公众号', '公众号'].includes(this.name.trim())) {
                new Notice('请先解析真实身份并确认显示名称');
                return;
            }
            button.setDisabled(true);
            try {
                await (await this.plugin.provider()).call('/v1/accounts', 'POST', { resolutionId: this.resolution.resolutionId, displayName: this.name });
                this.close();
                await this.done();
            }
            catch (error) {
                new Notice(error instanceof Error ? error.message : '订阅失败');
                button.setDisabled(false);
            }
        }));
    }
    /** 关闭引导时清理临时身份 */
    onClose(): void { this.resolution = undefined; this.contentEl.empty(); }
}
/** 扫码会话只在模态窗口打开时轮询 */
export class LoginModal extends Modal {
    /** 当前二维码会话 */
    private login?: Login;
    /** 当前二维码轮询计时器 */
    private timer?: ReturnType<typeof setInterval>;
    /** 模态窗口已关闭时不再追加图片 */
    private closed = false;
    /** 轮询防重标志 */
    private polling = false;
    /** 绑定插件的采集客户端 */
    constructor(private plugin: WeChatReaderPlugin) { super(plugin.app); }
    /** 展示登录流程并自动获取二维码 */
    onOpen(): void {
        this.contentEl.createEl('h2', { text: '微信读书扫码登录' });
        this.contentEl.createEl('p', { text: '登录凭据仅保存在本机私有目录，不写入笔记库。' });
        // 二维码容器显示服务返回的内嵌图片，不在 URL 中放密钥。
        const display = this.contentEl.createDiv({ cls: 'wr-login' });
        // 状态独立更新，避免二维码在轮询时闪烁。
        const status = this.contentEl.createEl('p');
        // 获取新会话前停止旧的界面轮询。
        const start = async (): Promise<void> => {
            if (this.timer)
                clearInterval(this.timer);
            try {
                this.login = await (await this.plugin.provider()).call<Login>('/v1/auth/login', 'POST', {});
                if (this.closed)
                    return;
                display.empty();
                if (this.login.qr && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=\s]+$/.test(this.login.qr))
                    display.createEl('img', { attr: { src: this.login.qr, alt: '微信读书登录二维码' } });
                status.setText(LOGIN_LABELS[this.login.state] || this.login.state);
                this.timer = setInterval(async () => {
                    if (this.polling || !this.login || this.closed)
                        return;
                    this.polling = true;
                    try {
                        this.login = await (await this.plugin.provider()).call<Login>(`/v1/auth/login/${this.login.id}`);
                        if (this.closed)
                            return;
                        status.setText(LOGIN_LABELS[this.login.state] || this.login.state);
                        if (['success', 'failed', 'expired'].includes(this.login.state)) {
                            clearInterval(this.timer);
                            display.empty();
                        }
                    }
                    catch (error) {
                        status.setText(error instanceof Error ? error.message : '登录状态读取失败');
                    }
                    finally {
                        this.polling = false;
                    }
                }, 2000);
            }
            catch (error) {
                status.setText(error instanceof Error ? error.message : '二维码获取失败');
            }
        };
        new Setting(this.contentEl).addButton(button => button.setButtonText('获取 / 刷新二维码').onClick(start));
        void start();
    }
    /** 离开窗口停止请求，服务端扫码会话按有效期自然终止 */
    onClose(): void { this.closed = true; if (this.timer)
        clearInterval(this.timer); this.contentEl.empty(); }
}
/** 订阅设置保留历史文章，删除订阅需明确确认 */
export class AccountModal extends Modal {
    /** 绑定当前公众号和刷新回调 */
    constructor(private plugin: WeChatReaderPlugin, private account: Account, private done: () => Promise<void>) { super(plugin.app); }
    /** 展示稳定身份、改名、暂停、间隔和取消订阅 */
    onOpen(): void {
        this.contentEl.createEl('h2', { text: '公众号设置' });
        this.contentEl.createEl('p', { text: `原始名称：${this.account.originalName} · 稳定 ID：${this.account.bookId}` });
        // 修改先暂存，点击保存才写入共享服务。
        let name = this.account.displayName;
        // 自动开关只影响后续调度，当前有界任务继续收尾。
        let auto = this.account.autoSync;
        // 随机同步间隔的下界。
        let minimum = this.account.intervalMin;
        // 随机同步间隔的上界。
        let maximum = this.account.intervalMax;
        new Setting(this.contentEl).setName('显示名称').addText(text => text.setValue(name).onChange(value => { name = value; }));
        new Setting(this.contentEl).setName('自动同步').addToggle(toggle => toggle.setValue(auto).onChange(value => { auto = value; }));
        new Setting(this.contentEl).setName('最短间隔（分钟）').addText(text => text.setValue(String(minimum)).onChange(value => { minimum = Number(value); }));
        new Setting(this.contentEl).setName('最长间隔（分钟）').addText(text => text.setValue(String(maximum)).onChange(value => { maximum = Number(value); }));
        new Setting(this.contentEl).addButton(button => button.setButtonText('保存设置').setCta().onClick(async () => {
            button.setDisabled(true);
            try {
                await (await this.plugin.provider()).call(`/v1/accounts/${this.account.id}`, 'PATCH', { displayName: name, autoSync: auto, intervalMin: minimum, intervalMax: maximum });
                this.close();
                await this.done();
            }
            catch (error) {
                new Notice(error instanceof Error ? error.message : '保存失败');
                button.setDisabled(false);
            }
        }));
        new Setting(this.contentEl).addButton(button => button.setButtonText(this.account.subscribed ? '取消订阅' : '恢复订阅').onClick(async () => {
            if (this.account.subscribed)
                new ConfirmModal(this.app, '取消订阅会停止后续自动采集，已下载文章、已读收藏及归档笔记都会保留。', async () => { await (await this.plugin.provider()).call(`/v1/accounts/${this.account.id}/subscription`, 'DELETE'); this.close(); await this.done(); }).open();
            else {
                await (await this.plugin.provider()).call(`/v1/accounts/${this.account.id}`, 'PATCH', { subscribed: true, autoSync: true });
                this.close();
                await this.done();
            }
        }));
    }
}
/** 危险程度较低但需要明确选择的业务确认窗口 */
export class ConfirmModal extends Modal {
    /** 保存确认文案和已授权操作 */
    constructor(app: import('obsidian').App, private message: string, private confirm: () => Promise<void>) { super(app); }
    /** 用户可以取消或执行明确展示的操作 */
    onOpen(): void {
        this.contentEl.createEl('p', { text: this.message });
        new Setting(this.contentEl).addButton(button => button.setButtonText('取消').onClick(() => this.close())).addButton(button => button.setButtonText('确认').setCta().onClick(async () => {
            button.setDisabled(true);
            try {
                await this.confirm();
                this.close();
            }
            catch (error) {
                new Notice(error instanceof Error ? error.message : '操作失败');
                button.setDisabled(false);
            }
        }));
    }
}
