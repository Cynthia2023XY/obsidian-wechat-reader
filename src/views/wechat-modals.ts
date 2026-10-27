import { intervalMinutes, intervalHours, nextRefresh } from '../feeds/interval';
import { Modal, Notice, Setting } from 'obsidian';
import type WeChatReaderPlugin from '../main';
import { wechatAccountId } from '../collector/subscriptions';
import type { Account, Login, Resolution, Feed } from '../collector/types';
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
    constructor(private plugin: WeChatReaderPlugin, private done: () => Promise<void>, private recovery?: Feed) { super(plugin.app); }
    /** 两步引导：先解析身份，再确认名称和订阅 */
    onOpen(): void {
        this.contentEl.createEl('h2', { text: this.recovery ? '补充公众号恢复链接' : '添加公众号' });
        this.contentEl.createEl('p', { text: '粘贴任意一篇公众号文章链接。首次优先下载这篇原文，并同步近期文章，每轮最多 10 篇。' });
        new Setting(this.contentEl).setName('文章链接').addText(text => text.setPlaceholder('https://mp.weixin.qq.com/s/…').onChange(value => { this.url = value; this.resolution = undefined; }));
        // 身份展示只由已验证 API 填充。
        const identity = this.contentEl.createDiv({ cls: 'wr-status' });
        new Setting(this.contentEl).addButton(button => button.setButtonText('解析公众号').setCta().onClick(async () => {
            button.setDisabled(true);
            try {
                const resolution = await (await this.plugin.provider()).call<Resolution>('/v1/accounts/resolve', 'POST', { url: this.url });
                if (this.recovery && wechatAccountId(resolution.bookId) !== this.recovery.id) throw new Error('这篇文章不属于原来的公众号，请更换链接');
                this.resolution = resolution;
                this.name = this.recovery?.title || resolution.originalName;
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
                await this.plugin.service.subscribeWeChat(this.resolution, this.url, this.name);
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
    private releaseSession?: () => void;
    /** 当前二维码轮询计时器 */
    private timer?: number;
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
                window.clearInterval(this.timer);
            try {
                if (!this.releaseSession) this.releaseSession = await this.plugin.runtime.acquire();
                if (this.closed) { this.releaseSession(); this.releaseSession = undefined; return; }
                this.login = await (await this.plugin.provider()).call<Login>('/v1/auth/login', 'POST', {});
                if (this.closed)
                    return;
                display.empty();
                if (this.login.qr && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=\s]+$/.test(this.login.qr))
                    display.createEl('img', { attr: { src: this.login.qr, alt: '微信读书登录二维码' } });
                status.setText(LOGIN_LABELS[this.login.state] || this.login.state);
                this.timer = window.setInterval(() => { // DOM 回调同步返回，异步任务在内部处理失败。
void (async () => {
                    if (this.polling || !this.login || this.closed)
                        return;
                    this.polling = true;
                    try {
                        this.login = await (await this.plugin.provider()).call<Login>(`/v1/auth/login/${this.login.id}`);
                        if (this.closed)
                            return;
                        status.setText(LOGIN_LABELS[this.login.state] || this.login.state);
                        if (['success', 'failed', 'expired'].includes(this.login.state)) {
                            window.clearInterval(this.timer);
                            display.empty();
                            if (this.login.state === 'success') {
                                status.setText('登录成功，正在恢复本库公众号订阅…');
                                const result = await this.plugin.service.restoreSubscriptions(true);
                                if (result.restored) await this.plugin.service.syncWeChat();
                                if (!this.closed) status.setText(`登录成功，已恢复 ${result.restored} 个订阅${result.needsLink ? `；${result.needsLink} 个旧订阅需右键补充恢复链接` : ''}${result.failed ? `；${result.failed} 个恢复失败，请稍后重试` : ''}。`);
                            }
                            this.releaseSession?.();
                            this.releaseSession = undefined;
                        }
                    }
                    catch (error) {
                        status.setText(error instanceof Error ? error.message : '登录状态读取失败');
                        if (this.login?.state === 'success') { this.releaseSession?.(); this.releaseSession = undefined; }
                    }
                    finally {
                        this.polling = false;
                    }
                })(); }, 2000);
            }
            catch (error) {
                status.setText(error instanceof Error ? error.message : '二维码获取失败');
            }
        };
        new Setting(this.contentEl).addButton(button => button.setButtonText('获取 / 刷新二维码').onClick(start));
        void start();
    }
    /** 离开窗口停止请求，服务端扫码会话按有效期自然终止 */
    onClose(): void { this.closed = true; this.releaseSession?.(); this.releaseSession = undefined; if (this.timer)
        window.clearInterval(this.timer); this.contentEl.empty(); }
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
        let minimum = intervalHours(this.account.intervalMin);
        // 随机同步间隔的上界。
        let maximum = intervalHours(this.account.intervalMax);
        new Setting(this.contentEl).setName('显示名称').addText(text => text.setValue(name).onChange(value => { name = value; }));
        new Setting(this.contentEl).setName('自动同步').addToggle(toggle => toggle.setValue(auto).onChange(value => { auto = value; }));
        new Setting(this.contentEl).setName('最短间隔（小时）').setDesc('每轮同步结束后，在最短与最长间隔之间随机安排下一次；范围 1～24 小时。').addText(text => text.setValue(minimum).onChange(value => { minimum = value; }));
        new Setting(this.contentEl).setName('最长间隔（小时）').addText(text => text.setValue(maximum).onChange(value => { maximum = value; }));
        this.contentEl.createEl('p', { text: nextRefresh(this.account.nextSyncAt * 1000) });
        new Setting(this.contentEl).addButton(button => button.setButtonText('保存设置').setCta().onClick(async () => {
            button.setDisabled(true);
            try {
                await (await this.plugin.provider()).call(`/v1/accounts/${this.account.id}`, 'PATCH', { displayName: name, autoSync: auto, intervalMin: intervalMinutes(minimum, 60, 1440), intervalMax: intervalMinutes(maximum, 60, 1440) });
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
