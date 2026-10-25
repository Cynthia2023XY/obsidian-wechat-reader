import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
/** 隔离中文与空格路径，验证安装包不依赖用户 Node/Python */
const directory = await mkdtemp(join(tmpdir(), 'RSS 中文验收 '));
/** 附属程序从完整安装包内的启动器运行 */
const engine = join(directory, '独立 运行程序');
await symlink(resolve('dist/engine/wechat-reader-companion'), engine);
/** 只有本次测试根目录会被清理 */
const root = join(directory, '私有 数据');
await mkdir(join(root, 'data/articles/article_fixture/v1'), { recursive: true, mode: 0o700 });
await writeFile(join(root, 'data/articles/article_fixture/v1/content.html'), '<p>安装包回归正文</p>');
/** 构造一期兼容索引，避免真实授权及外部请求 */
const db = new DatabaseSync(join(root, 'data/collector.sqlite'));
db.exec('CREATE TABLE accounts(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE articles(id TEXT PRIMARY KEY,data TEXT NOT NULL);');
db.prepare('INSERT INTO accounts VALUES(?,?)').run('account_fixture', JSON.stringify({ id: 'account_fixture', bookId: 'MP_WXS_123', displayName: '安装包回归', subscribed: true, autoSync: false, firstSync: false, nextSyncAt: 0 }));
db.prepare('INSERT INTO articles VALUES(?,?)').run('article_fixture', JSON.stringify({ id: 'article_fixture', accountId: 'account_fixture', title: '回归文章', url: 'https://mp.weixin.qq.com/s/fixture', publishedAt: null, state: 'ready', contentVersion: 'v1', assets: [] }));
db.close();
/** 已启动的测试进程只有正常退出后才释放测试目录 */
const children = [];
/** 使用最小环境，启动不依赖 shell 中的语言工具 */
function launch() {
    // 使用随包 Node，PATH 不包含开发环境。
    const child = spawn(join(engine, 'wechat-reader-companion'), ['--root', root], { env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR }, stdio: 'pipe' });
    children.push(child);
    return child;
}
/** 有界等待服务健康，不输出发现文件中的密钥 */
async function health() {
    // 测试上限十秒，失败保留明确断言。
    for (let index = 0; index < 100; index++) {
        try {
            // 安装包独立运行验证的启动、响应或客户端信息。
            const info = JSON.parse(await readFile(join(root, 'runtime/instance.json'), 'utf8'));
            // 当前有界网络请求的响应，仅在内存中处理。
            const response = await fetch(`http://127.0.0.1:${info.port}/v1/health`, { headers: { 'X-Reader-Key': info.key } });
            if (response.ok)
                return info;
        }
        catch { /* 启动期间尚未创建发现文件。 */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('安装包未在十秒内启动');
}
/** 进程退出等待必须先订阅，避免错过已发生的退出 */
async function exited(child) { if (child.exitCode !== null || child.signalCode !== null)
    return; await new Promise(resolve => child.once('exit', resolve)); }
try {
    // 第一次启动接管一期数据，同时生成稳定只读订阅地址。
    const first = launch(), info = await health();
    // 管理请求只在内存中使用访问密钥。
    const call = async (path, method = 'GET') => (await fetch(`http://127.0.0.1:${info.port}${path}`, { method, headers: { 'X-Reader-Key': info.key, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined })).json();
    /** 安装包独立运行验证的启动、响应或客户端信息 */
    assert.ok((await call('/v1/health')).data.capabilities.includes('portable-subscriptions'));
    const leaseA = (await call('/v1/clients', 'POST')).data, leaseB = (await call('/v1/clients', 'POST')).data;
    await call(`/v1/clients/${leaseA.id}`, 'DELETE');
    assert.equal((await call(`/v1/clients/${leaseB.id}/renew`, 'POST')).data.id, leaseB.id);
    /** 安装包独立运行验证的启动、响应或客户端信息 */
    const url = (await call('/v1/accounts/account_fixture/rss')).data.url;
    assert.ok((await (await fetch(url)).text()).includes('安装包回归正文'));
    // 第二次启动退出，不夺取租约或改写现有实例。
    const duplicate = launch();
    await exited(duplicate);
    assert.equal(duplicate.exitCode, 0);
    assert.equal((await health()).instanceId, info.instanceId);
    first.kill('SIGTERM');
    await exited(first);
    // 安全重启后端口、源令牌及旧正文继续可读。
    const second = launch(), after = await health();
    assert.equal(after.port, info.port);
    assert.notEqual(after.instanceId, info.instanceId);
    assert.ok((await (await fetch(url)).text()).includes('安装包回归正文'));
    // 不持有租约时应自行退出，不能只检查接口状态。
    await Promise.race([exited(second), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('省电模式未在 22 秒内退出')), 22000); timer.unref(); })]);
    assert.equal(second.exitCode, 0);
    const third = launch(), awake = await health();
    assert.notEqual(awake.instanceId, after.instanceId);
    assert.equal(awake.port, info.port);
    third.kill('SIGTERM');
    await exited(third);
    console.log('安装包回归通过：中文空格路径、随包 Node、单实例、双客户端租约、稳定端口、RSS 令牌重启复用、真实空闲退出与再次唤醒');
}
finally {
    for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            await exited(child);
        }
    }
    await rm(directory, { recursive: true, force: true });
}
