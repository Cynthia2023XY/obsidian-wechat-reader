import { createHash, randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writeJson, Problem } from './core';
import { signature } from './signature';
/** 一期单账号凭据字段，原样兼容旧账号池 JSON */
export interface Credential {
    id: string;
    vid: string;
    accessToken: string;
    refreshToken?: string;
    skey?: string;
    deviceId: string;
    deviceName: string;
    installId?: string;
    userAgent?: string;
    nickname?: string;
    status: string;
    save_time?: number;
}
/** 扫码会话只向插件暴露二维码与状态，不返回换票内容 */
export interface LoginState {
    id: string | null;
    state: string;
    qr: string | null;
}
/** 微信读书的移动客户端协议头 */
const APP_UA = 'WeRead/7.5.0 (Android; 33; arm64-v8a)';
/** 所有外部请求都有有界超时，异常不带原始上游响应 */
export async function boundedFetch(url: string, options: RequestInit = {}, timeout = 20000): Promise<Response> { try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
}
catch {
    throw new Problem('NETWORK', '网络暂时不可用，请稍后重试', true, undefined, 120);
} }
/** TS 登录、账号续期和协议签名；不调用旧 Python 模块 */
export class Auth {
    /** 当前二维码登录会话 */
    login: LoginState = { id: null, state: 'idle', qr: null };
    /** 账号刷新共享一个请求，避免多接口同时换票 */
    private refreshing?: Promise<boolean>;
    /** 同时点击登录时共享二维码创建请求 */
    private starting?: Promise<LoginState>;
    /** 扫码状态在退出登录和关闭运行时后停止 */
    private stopped = false;
    /** 注销或退出后作废所有尚未完成的认证请求 */
    private generation = 0;
    /** 原有账号文件的位置保持不变以实现原地迁移 */
    private path: string;
    /** 绑定当前用户私有凭据目录 */
    constructor(root: string) { this.path = join(root, 'data/credentials/account_pool.json'); }
    /** 读取一期账号池文件，当前内测只使用一个有效账号 */
    credentials(): Credential[] { return readJson<Credential[]>(this.path, []); }
    /** 登录状态不把 Token、Cookie 或设备标识传到界面 */
    status(): {
        loggedIn: boolean;
        state: string;
    } { return { loggedIn: this.credentials().some(account => account.status === 'active' && !!account.accessToken), state: this.login.state }; }
    /** 当前账号请求头与扫码绑定的设备画像保持一致 */
    headers(): Record<string, string> {
        // 凭据无效时立即提示扫码，不循环刷请求。
        const account = this.credentials().find(account => account.status === 'active' && account.accessToken);
        if (!account)
            throw new Problem('AUTH_REQUIRED', '登录已失效，请重新扫码', false, 'login');
        return { 'User-Agent': account.userAgent || APP_UA, 'Content-Type': 'application/json; charset=UTF-8', vid: String(account.vid), accessToken: account.accessToken, skey: account.skey || account.accessToken, deviceId: account.deviceId, Cookie: `wr_vid=${account.vid}; wr_skey=${account.skey || account.accessToken}` };
    }
    /** 创建二维码，会话未过期时复用已有二维码避免多扫码线程 */
    async startLogin(): Promise<LoginState> {
        if (['scanning', 'scanned'].includes(this.login.state))
            return { ...this.login };
        if (!this.starting)
            this.starting = this.createLogin().finally(() => { this.starting = undefined; });
        return this.starting;
    }
    /** 独立创建二维码并启动有界轮询 */
    private async createLogin(): Promise<LoginState> {
        // 二维码网络请求不能在注销后重新激活会话。
        const generation = this.generation;
        // 微信读书签发官方扫码所需的票据。
        const ticket = await (await boundedFetch('https://i.weread.qq.com/wxticket?nonceStr=weread', { headers: { 'User-Agent': APP_UA } }, 10000)).json() as Record<string, string>;
        // 仅固定的微信 OAuth 地址接收票据。
        const params = new URLSearchParams({ appid: 'wxab9b71ad2b90ff34', noncestr: 'weread', timestamp: String(ticket.timeStamp), scope: 'snsapi_userinfo,snsapi_timeline,snsapi_friend,snsapi_favorites', signature: ticket.signature });
        // 二维码转换为内嵌图像，不在显示地址上拼接本机访问密钥。
        const data = await (await boundedFetch(`https://open.weixin.qq.com/connect/sdk/qrconnect?${params}`, { headers: { 'User-Agent': APP_UA } }, 10000)).json() as {
            uuid?: string;
            qrcode?: {
                qrcodebase64?: string;
            };
        };
        if (!data.uuid)
            throw new Problem('LOGIN_UNAVAILABLE', '暂时无法生成二维码，请稍后重试', true);
        // 微信也可能返回需要独立获取的二维码资源。
        let image = data.qrcode?.qrcodebase64;
        if (!image) {
            // 当前有界网络请求的响应，仅在内存中处理。
            const response = await boundedFetch(`https://open.weixin.qq.com/connect/qrcode/${encodeURIComponent(data.uuid)}`, {}, 15000);
            if (!response.ok)
                throw new Problem('LOGIN_UNAVAILABLE', '二维码获取失败', true);
            image = Buffer.from(await response.arrayBuffer()).toString('base64');
        }
        if (generation !== this.generation)
            throw new Problem('LOGIN_CANCELLED', '登录已取消');
        this.stopped = false;
        this.login = { id: randomUUID().replace(/-/g, ''), state: 'scanning', qr: `data:image/jpeg;base64,${image}` };
        void this.poll(this.login.id!, data.uuid);
        return { ...this.login };
    }
    /** 清除原有凭据，取消会话，不留下可重新自动导入的登录文件 */
    logout(): {
        loggedIn: boolean;
        state: string;
    } { this.generation++; this.stopped = true; this.login = { id: null, state: 'idle', qr: null }; writeJson(this.path, []); return this.status(); }
    /** 程序结束后取消二维码轮询的后续请求 */
    dispose(): void { this.generation++; this.stopped = true; }
    /** 401 时共享有限续期，失败后持久化失效状态 */
    async refresh(): Promise<boolean> { if (!this.refreshing)
        this.refreshing = this.refreshAccount().finally(() => { this.refreshing = undefined; }); return this.refreshing; }
    /** 换取新的访问凭据，保留原有设备绑定 */
    private async refreshAccount(): Promise<boolean> {
        // 续期请求使用旧账号绑定的 refreshToken。
        const account = this.credentials().find(account => account.status === 'active');
        if (!account?.refreshToken)
            return false;
        // 注销期间完成的旧换票不能重新写回凭据。
        const generation = this.generation;
        // 时间和随机值与签名参数严格对应。
        const timestamp = Date.now(), random = randomInt(1000);
        // 协议字段复用一期已经验证的官方客户端行为。
        const body = { refreshToken: account.refreshToken, deviceId: account.deviceId, wxToken: 0, inBackground: 0, trackId: '', kickType: 1, refCgi: '', timestamp, random, signature: signature(['', account.deviceId, String(timestamp), String(random), account.refreshToken]), virtualChannelId: '', deviceName: 'Android' };
        try {
            // 不把凭据或换票响应写入日志。
            const response = await boundedFetch('https://i.weread.qq.com/login', { method: 'POST', headers: { 'User-Agent': APP_UA, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 12000);
            // 只使用必要字段，不泄露上游错误正文。
            const data = await response.json() as Partial<Credential>;
            if (generation !== this.generation)
                return false;
            if (response.ok && data.accessToken) {
                Object.assign(account, { accessToken: data.accessToken, refreshToken: data.refreshToken || account.refreshToken, skey: data.skey || data.accessToken, status: 'active', save_time: Date.now() / 1000 });
                writeJson(this.path, [account]);
                return true;
            }
        }
        catch { /* 续期失败统一进入重新扫码流程。 */ }
        if (generation !== this.generation)
            return false;
        account.status = 'invalid';
        writeJson(this.path, [account]);
        return false;
    }
    /** 二维码轮询有五分钟上限，退出或换会话后不再存储结果 */
    private async poll(id: string, uuid: string): Promise<void> {
        // 每次扫码分配一份完整设备画像，后续续期继续复用。
        const device = { deviceId: createHash('md5').update(randomUUID()).digest('hex'), deviceName: 'Android', installId: randomUUID(), userAgent: APP_UA };
        // 轮询到期后需要用户主动刷新二维码。
        const deadline = Date.now() + 300000;
        while (!this.stopped && this.login.id === id && Date.now() < deadline) {
            try {
                // 官方扫码长轮询超时不超过一次有界请求。
                const response = await boundedFetch(`https://long.open.weixin.qq.com/connect/l/qrconnect?f=json&uuid=${encodeURIComponent(uuid)}`, {}, 28000);
                // 这里只读取状态码和成功授权码，不返回给插件。
                const data = await response.json() as {
                    wx_errcode?: number;
                    errcode?: number;
                    wx_code?: string;
                };
                // 兼容微信两个状态字段命名。
                const code = data.wx_errcode ?? data.errcode;
                if (this.stopped || this.login.id !== id)
                    return;
                if (code === 404)
                    this.login.state = 'scanned';
                if (code === 402 || code === 403)
                    break;
                if (code === 405) {
                    // 扫码授权与时间、设备绑定的摘要保持一致。
                    const timestamp = Date.now(), random = randomInt(1000);
                    // 换票采用独立设备指纹，而不是复用旧程序的终端。
                    const body = { code: data.wx_code, deviceId: device.deviceId, trackId: '', timestamp, random, signature: createHash('sha256').update(`${timestamp}${device.deviceId}${random}`).digest('hex'), wxToken: 1, appFirstInstall: 0, virtualChannelId: '', installId: device.installId, isFromQrcode: 1, isAutoLogout: 0, deviceName: 'Android', deviceType: 1 };
                    // 官方微信读书登录接口负责最终授权。
                    const result = await (await boundedFetch('https://i.weread.qq.com/login', { method: 'POST', headers: { 'User-Agent': APP_UA, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 12000)).json() as Partial<Credential> & {
                        user?: {
                            name?: string;
                        };
                    };
                    if (this.stopped || this.login.id !== id)
                        return;
                    if (!result.vid || !result.accessToken) {
                        this.login.state = 'failed';
                        return;
                    }
                    writeJson(this.path, [{ ...result, ...device, id: randomUUID().replace(/-/g, ''), vid: String(result.vid), nickname: result.user?.name || '微信读书用户', status: 'active', save_time: Date.now() / 1000 }]);
                    this.login = { id, state: 'success', qr: null };
                    return;
                }
            }
            catch {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        if (this.login.id === id)
            this.login = { id, state: 'expired', qr: null };
    }
}
