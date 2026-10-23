/** 当前用例所需的隔离输入、依赖或断言结果 */
const { test } = require('node:test');
/** 当前用例所需的隔离输入、依赖或断言结果 */
const assert = require('node:assert/strict');
/** 当前用例所需的隔离输入、依赖或断言结果 */
const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
/** 当前用例所需的隔离输入、依赖或断言结果 */
const { tmpdir } = require('node:os');
/** 当前用例所需的隔离输入、依赖或断言结果 */
const { join } = require('node:path');
/** 当前用例所需的隔离输入、依赖或断言结果 */
const { DatabaseSync } = require('node:sqlite');
/** 当前用例所需的隔离输入、依赖或断言结果 */
const { Store, Collector, RuntimeServer, Scheduler, Problem, signature, canonicalUrl, writeJson } = require(process.env.TEST_RUNTIME_BUNDLE);
/** 每个测试使用一次性私有数据库，不读取真实账号文件 */
function fixture(t) {
    // 当前用例所需的隔离输入、依赖或断言结果。
    const root = mkdtempSync(join(tmpdir(), 'wechat-runtime-'));
    // 当前用例所需的隔离输入、依赖或断言结果。
    const store = new Store(root);
    t.after(async () => { if (store.__runtime)
        await store.__runtime.close(); try {
        store.db.close();
    }
    catch { } rmSync(root, { recursive: true, force: true }); });
    return { root, store };
}
/** 测试账号与种子文章的身份字段 */
function account(store, n = 123) { return store.subscribe({ platformId: 'MTIz', bookId: `MP_WXS_${n}`, originalName: '测试公众号' }, '测试公众号'); }
/** 无网络副作用的采集能力替身 */
function fake() { return { auth: { status: () => ({ loggedIn: false, state: 'idle' }), dispose() { } }, browserAvailable: () => false }; }
test('签名与一期固定样例逐字节一致，含 UTF8 和空参数', () => {
    assert.equal(signature([]), '803650dc58f1b68a4826c26926ff4b52dbdb6f948d6905227aa3d722b5abb836');
    assert.equal(signature(['']), '803650dc58f1b68a4826c26926ff4b52dbdb6f948d6905227aa3d722b5abb836');
    assert.equal(signature(['', 'device123', '1720000000000', '42', 'refresh-token']), 'af08a7dea891e077d9d443df113ad235a5110a72a7dbbdeb568cdf1d09bb8522');
    assert.equal(signature(['中文', '🙂', 'a']), '3d53d87e9ec85f32c83bcaca728c4f8a2097e01bf42643b300fd3eb5e15305c8');
});
test('旧数据库迁移备份、故障任务恢复与既有身份原样保留', t => {
    // 旧数据库迁移备份、故障任务恢复与既有身份原样保留所需的隔离输入、依赖或断言结果。
    const root = mkdtempSync(join(tmpdir(), 'wechat-migration-'));
    mkdirSync(join(root, 'data/credentials'), { recursive: true });
    writeFileSync(join(root, 'data/credentials/account_pool.json'), '[{"fixture":"private"}]', { mode: 0o600 });
    // 旧数据库迁移备份、故障任务恢复与既有身份原样保留所需的隔离输入、依赖或断言结果。
    const db = new DatabaseSync(join(root, 'data/collector.sqlite'));
    db.exec('CREATE TABLE accounts(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE articles(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE jobs(id TEXT PRIMARY KEY,account_id TEXT,state TEXT,data TEXT NOT NULL);');
    db.prepare('INSERT INTO articles VALUES(?,?)').run('legacy-id', JSON.stringify({ id: 'legacy-id', state: 'downloading', contentVersion: 'v1' }));
    db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run('j', 'a', 'running', JSON.stringify({ id: 'j', accountId: 'a', state: 'running' }));
    db.close();
    // 旧数据库迁移备份、故障任务恢复与既有身份原样保留所需的隔离输入、依赖或断言结果。
    const store = new Store(root);
    t.after(() => { store.db.close(); rmSync(root, { recursive: true, force: true }); });
    // 旧数据库迁移备份、故障任务恢复与既有身份原样保留所需的隔离输入、依赖或断言结果。
    const marker = JSON.parse(readFileSync(join(root, 'data/ts-migration.json')));
    assert.ok(existsSync(join(root, 'data', marker.backup)));
    assert.equal(readFileSync(join(root, 'data/credentials/account_pool.before-ts.json'), 'utf8'), '[{"fixture":"private"}]');
    assert.equal(store.get('articles', 'legacy-id').state, 'temporary_failure');
    assert.equal(store.get('jobs', 'j').state, 'interrupted');
    assert.equal(store.get('articles', 'legacy-id').contentVersion, 'v1');
});
test('规范化链接及后补 reviewId 保持同一文章，改名与同标题不丢历史', t => {
    // 规范化链接及后补 reviewId 保持同一文章，改名与同标题不丢历史所需的隔离输入、依赖或断言结果。
    const { store } = fixture(t), a = account(store);
    assert.equal(canonicalUrl('http://mp.weixin.qq.com/s/x?scene=1&mid=2&__biz=abc#x'), 'https://mp.weixin.qq.com/s/x?__biz=abc&mid=2');
    assert.throws(() => canonicalUrl('https://evil.example/s/x'));
    // 规范化链接及后补 reviewId 保持同一文章，改名与同标题不丢历史所需的隔离输入、依赖或断言结果。
    const first = store.discover(a, { url: 'https://mp.weixin.qq.com/s/one', title: '同标题' });
    // 规范化链接及后补 reviewId 保持同一文章，改名与同标题不丢历史所需的隔离输入、依赖或断言结果。
    const late = store.discover(a, { url: 'https://mp.weixin.qq.com/s/one?scene=2', reviewId: 'r1', publishedAt: '2024-01-02T00:00:00Z' });
    assert.equal(first.article.id, late.article.id);
    assert.equal(late.fresh, false);
    assert.equal(store.discover(a, { url: 'https://mp.weixin.qq.com/s/alternate', reviewId: 'r1' }).article.id, first.article.id);
    assert.notEqual(store.discover(a, { url: 'https://mp.weixin.qq.com/s/two', title: '同标题' }).article.id, first.article.id);
    assert.equal(account(store).id, a.id);
    assert.equal(store.all('articles').length, 2);
});
test('唯一活动任务与取消状态，已取消任务不会再运行', async (t) => {
    // 唯一活动任务与取消状态，已取消任务不会再运行所需的隔离输入、依赖或断言结果。
    const { store } = fixture(t), a = account(store), one = store.enqueue(a.id), two = store.enqueue(a.id);
    assert.equal(one.id, two.id);
    one.state = 'cancelled';
    store.put('jobs', one);
    // 唯一活动任务与取消状态，已取消任务不会再运行所需的隔离输入、依赖或断言结果。
    const scheduler = new Scheduler(store, { ...fake(), page: () => { throw new Error('不可复活'); } }, 0);
    await scheduler.run(one);
    assert.equal(store.get('jobs', one.id).state, 'cancelled');
    assert.notEqual(store.enqueue(a.id).id, one.id);
});
test('首轮下载额度、种子优先，以及运行中暂停与改名不会被覆盖', async (t) => {
    // 首轮下载额度、种子优先，以及运行中暂停与改名不会被覆盖所需的隔离输入、依赖或断言结果。
    const { store } = fixture(t), a = account(store), seed = store.discover(a, { url: 'https://mp.weixin.qq.com/s/history' }).article;
    // 本轮唯一队列任务的持久化快照。
    const job = store.enqueue(a.id);
    job.priorityArticleId = seed.id;
    store.put('jobs', job);
    // 首轮下载额度、种子优先，以及运行中暂停与改名不会被覆盖所需的隔离输入、依赖或断言结果。
    const order = [];
    // 首轮下载额度、种子优先，以及运行中暂停与改名不会被覆盖所需的隔离输入、依赖或断言结果。
    const collector = { ...fake(), page: async () => ({ items: Array.from({ length: 15 }, (_, i) => ({ url: `https://mp.weixin.qq.com/s/p${i}` })), more: true }), download: async (article) => {
            order.push(article.id);
            article.state = 'ready';
            store.put('articles', article);
            // 首轮下载额度、种子优先，以及运行中暂停与改名不会被覆盖所需的隔离输入、依赖或断言结果。
            const current = store.get('accounts', a.id);
            current.autoSync = false;
            current.displayName = '用户改名';
            store.put('accounts', current);
        } };
    await new Scheduler(store, collector, 0).run(job);
    assert.equal(order[0], seed.id);
    assert.equal(order.length, 10);
    assert.equal(store.get('jobs', job.id).succeeded, 10);
    assert.equal(store.get('accounts', a.id).displayName, '用户改名');
    assert.equal(store.get('accounts', a.id).autoSync, false);
});
test('验证受限时停止整轮并持久化等待，不把验证页计为成功', async (t) => {
    // 验证受限时停止整轮并持久化等待，不把验证页计为成功所需的隔离输入、依赖或断言结果。
    const { store } = fixture(t), a = account(store);
    // 本轮唯一队列任务的持久化快照。
    const job = store.enqueue(a.id);
    // 验证受限时停止整轮并持久化等待，不把验证页计为成功所需的隔离输入、依赖或断言结果。
    const collector = { ...fake(), page: async () => ({ items: [{ url: 'https://mp.weixin.qq.com/s/a' }, { url: 'https://mp.weixin.qq.com/s/b' }], more: false }), download: async () => { throw new Problem('VERIFICATION_REQUIRED', '需要验证', false, 'verify'); } };
    // 验证受限时停止整轮并持久化等待，不把验证页计为成功所需的隔离输入、依赖或断言结果。
    const scheduler = new Scheduler(store, collector, 0);
    await scheduler.run(job);
    assert.equal(store.get('jobs', job.id).state, 'waiting_verification');
    assert.equal(store.get('jobs', job.id).succeeded, 0);
    assert.equal(store.get('jobs', job.id).failed, 1);
    assert.equal(store.get('accounts', a.id).blocked.action, 'verify');
});
test('HTTP 管理鉴权、来源限制、租约与持久只读 RSS 令牌隔离', async (t) => {
    // HTTP 管理鉴权、来源限制、租约与持久只读 RSS 令牌隔离所需的隔离输入、依赖或断言结果。
    const { root, store } = fixture(t), a = account(store), b = account(store, 456);
    // HTTP 管理鉴权、来源限制、租约与持久只读 RSS 令牌隔离所需的隔离输入、依赖或断言结果。
    const entry = store.discover(a, { url: 'https://mp.weixin.qq.com/s/read', title: '标题<&' }).article;
    // 原子提交前的私有临时文件位置。
    const temporary = join(root, 'data/articles', entry.id + '.tmp');
    mkdirSync(temporary);
    writeFileSync(join(temporary, 'im.img'), Buffer.from([1, 2, 3]));
    store.commit(entry, '<p>正文</p><img src="asset:im">', [{ id: 'im', file: 'im.img', state: 'ready', mime: 'image/png' }], temporary);
    // HTTP 管理鉴权、来源限制、租约与持久只读 RSS 令牌隔离所需的隔离输入、依赖或断言结果。
    const server = new RuntimeServer(store, fake());
    await server.listen(0);
    store.__runtime = server;
    // 当前层 XML 声明的相对地址基准。
    const base = `http://127.0.0.1:${server.port}`;
    // HTTP 管理鉴权、来源限制、租约与持久只读 RSS 令牌隔离所需的隔离输入、依赖或断言结果。
    const call = (path, options = {}) => fetch(base + path, { ...options, headers: { 'X-Reader-Key': server.key, 'Content-Type': 'application/json', ...options.headers } });
    assert.equal((await fetch(base + '/v1/health')).status, 401);
    assert.equal((await call('/v1/health', { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await (await call('/v1/health')).json()).data.runtimeLanguage, 'typescript');
    // HTTP 管理鉴权、来源限制、租约与持久只读 RSS 令牌隔离所需的隔离输入、依赖或断言结果。
    const lease = (await (await call('/v1/clients', { method: 'POST', body: '{}' })).json()).data;
    assert.equal(server.clients.size, 1);
    await call(`/v1/clients/${lease.id}/renew`, { method: 'POST', body: '{}' });
    await call(`/v1/clients/${lease.id}`, { method: 'DELETE' });
    assert.equal(server.clients.size, 0);
    // HTTP 管理鉴权、来源限制、租约与持久只读 RSS 令牌隔离所需的隔离输入、依赖或断言结果。
    const url = (await (await call(`/v1/accounts/${a.id}/rss`)).json()).data.url;
    assert.ok(url && !url.includes(server.key));
    // HTTP 管理鉴权、来源限制、租约与持久只读 RSS 令牌隔离所需的隔离输入、依赖或断言结果。
    const xml = await (await fetch(url)).text();
    assert.ok(xml.includes('标题&lt;&amp;'));
    assert.ok(xml.includes('正文'));
    assert.ok(xml.includes('/feed-assets/'));
    // HTTP 管理鉴权、来源限制、租约与持久只读 RSS 令牌隔离所需的隔离输入、依赖或断言结果。
    const image = new URL(xml.match(/http:\/\/127[^<]+\/im/)[0].replaceAll('&amp;', '&'));
    assert.equal((await fetch(image)).status, 200);
    image.pathname = image.pathname.replace(a.id, b.id);
    assert.equal((await fetch(image)).status, 401);
    await call(`/v1/accounts/${a.id}/rss/token`, { method: 'POST', body: '{}' });
    assert.equal((await fetch(url)).status, 401);
    // 单篇文章元信息，用于补全标题、链接和发布时间。
    const detail = (await (await call('/v1/articles/' + entry.id)).json()).data;
    assert.equal(detail.assets[0].file, undefined);
    assert.equal(detail.assets[0].sourceUrl, undefined);
    assert.equal((await call('/v1/accounts', { method: 'POST', body: '{}' })).status, 400);
});
test('真实 TS 下载器清理脚本与装饰图，图片归属及补采版本不可变', async (t) => {
    // 真实 TS 下载器清理脚本与装饰图，图片归属及补采版本不可变所需的隔离输入、依赖或断言结果。
    const { root, store } = fixture(t), a = account(store), article = store.discover(a, { url: 'https://mp.weixin.qq.com/s/body' }).article;
    // 真实 TS 下载器清理脚本与装饰图，图片归属及补采版本不可变所需的隔离输入、依赖或断言结果。
    const collector = new Collector(root), original = global.fetch;
    t.after(() => { global.fetch = original; collector.auth.dispose(); });
    global.fetch = async (url) => String(url).includes('qpic.cn') ? new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }) : new Response('<html><body><h1 id="activity-name">测试</h1><div id="js_content"><script>evil()</script><p onclick="evil()">安全正文</p><img/><img data-src="https://mmbiz.qpic.cn/a"/></div></body></html>');
    // 真实 TS 下载器清理脚本与装饰图，图片归属及补采版本不可变所需的隔离输入、依赖或断言结果。
    const ready = await collector.download(article, store);
    assert.equal(ready.state, 'ready');
    assert.equal(ready.assets.length, 1);
    assert.equal(ready.assets[0].state, 'ready');
    assert.equal(ready.assets[0].mime, 'image/png');
    // 真实 TS 下载器清理脚本与装饰图，图片归属及补采版本不可变所需的隔离输入、依赖或断言结果。
    const html = store.content(ready), oldVersion = ready.contentVersion;
    assert.ok(!/script|onclick|https:/.test(html));
    assert.ok(html.includes('安全正文'));
    assert.throws(() => store.assetPath(ready.id, 'unknown'));
    ready.retryImages = true;
    ready.state = 'temporary_failure';
    store.put('articles', ready);
    global.fetch = async () => { throw new Error('成功图片应复用'); };
    // 真实 TS 下载器清理脚本与装饰图，图片归属及补采版本不可变所需的隔离输入、依赖或断言结果。
    const retried = await collector.download(ready, store);
    assert.notEqual(retried.contentVersion, oldVersion);
    assert.equal(retried.assets[0].state, 'ready');
    assert.ok(existsSync(join(root, 'data/articles', ready.id, oldVersion, 'content.html')));
});
test('401 只续期一次，429 转等待验证，其他499不伪装验证码', async (t) => {
    // 401 只续期一次，429 转等待验证，其他499不伪装验证码所需的隔离输入、依赖或断言结果。
    const { root } = fixture(t), collector = new Collector(root), original = global.fetch;
    t.after(() => { global.fetch = original; collector.auth.dispose(); });
    collector.auth.headers = () => ({});
    // 401 只续期一次，429 转等待验证，其他499不伪装验证码所需的隔离输入、依赖或断言结果。
    let refreshed = 0;
    collector.auth.refresh = async () => { refreshed++; return true; };
    // 401 只续期一次，429 转等待验证，其他499不伪装验证码所需的隔离输入、依赖或断言结果。
    let calls = 0;
    global.fetch = async () => ++calls === 1 ? new Response('{}', { status: 401 }) : new Response('{"ok":true}');
    assert.equal((await collector.api('/fixture')).ok, true);
    assert.equal(refreshed, 1);
    assert.equal(calls, 2);
    global.fetch = async () => new Response('{}', { status: 429 });
    await assert.rejects(collector.api('/fixture'), error => error.action === 'verify');
    global.fetch = async () => new Response('{"errcode":-999}', { status: 499 });
    await assert.rejects(collector.api('/fixture'), error => error.code === 'UPSTREAM_REJECTED' && !error.action);
});
test('二维码创建并发复用，扫码换票保留设备绑定，注销清空凭据', async (t) => {
    // 二维码创建并发复用，扫码换票保留设备绑定，注销清空凭据所需的隔离输入、依赖或断言结果。
    const { root } = fixture(t), collector = new Collector(root), auth = collector.auth, original = global.fetch;
    // 二维码创建并发复用，扫码换票保留设备绑定，注销清空凭据所需的隔离输入、依赖或断言结果。
    let ticketCalls = 0, qrCalls = 0, exchange;
    t.after(() => { global.fetch = original; auth.dispose(); });
    global.fetch = async (url, options) => {
        // 二维码创建并发复用，扫码换票保留设备绑定，注销清空凭据所需的隔离输入、依赖或断言结果。
        const address = String(url);
        if (address.includes('/wxticket')) {
            ticketCalls++;
            return Response.json({ timeStamp: 123, signature: 'fixture' });
        }
        if (address.includes('/sdk/qrconnect')) {
            qrCalls++;
            return Response.json({ uuid: 'fixture-id', qrcode: { qrcodebase64: 'Zml4dHVyZQ==' } });
        }
        if (address.includes('long.open.weixin'))
            return Response.json({ wx_errcode: 405, wx_code: 'fixture-authorization' });
        if (address.endsWith('/login')) {
            exchange = JSON.parse(options.body);
            return Response.json({ vid: 123, accessToken: 'fixture-access', refreshToken: 'fixture-refresh' });
        }
        throw Error('不允许的网络目标');
    };
    // 二维码创建并发复用，扫码换票保留设备绑定，注销清空凭据所需的隔离输入、依赖或断言结果。
    const [one, two] = await Promise.all([auth.startLogin(), auth.startLogin()]);
    assert.equal(one.id, two.id);
    assert.equal(ticketCalls, 1);
    assert.equal(qrCalls, 1);
    for (let i = 0; i < 10 && !auth.status().loggedIn; i++)
        await new Promise(resolve => setImmediate(resolve));
    assert.equal(auth.status().loggedIn, true);
    assert.equal(auth.credentials()[0].deviceId, exchange.deviceId);
    assert.equal(exchange.code, 'fixture-authorization');
    assert.ok(!JSON.stringify(one).includes('fixture-access'));
    auth.logout();
    assert.deepEqual(auth.credentials(), []);
    assert.equal(auth.status().loggedIn, false);
});
test('并发续期仅换票一次，注销期间返回的换票不能恢复授权', async (t) => {
    // 并发续期仅换票一次，注销期间返回的换票不能恢复授权所需的隔离输入、依赖或断言结果。
    const { root } = fixture(t), collector = new Collector(root), auth = collector.auth, original = global.fetch;
    // 并发续期仅换票一次，注销期间返回的换票不能恢复授权所需的隔离输入、依赖或断言结果。
    let finish, calls = 0;
    t.after(() => { global.fetch = original; auth.dispose(); });
    writeJson(join(root, 'data/credentials/account_pool.json'), [{ id: 'test', vid: '1', accessToken: 'old', refreshToken: 'refresh', deviceId: 'fixture', deviceName: 'Android', status: 'active' }]);
    global.fetch = async () => { calls++; return new Promise(resolve => { finish = resolve; }); };
    // 并发续期仅换票一次，注销期间返回的换票不能恢复授权所需的隔离输入、依赖或断言结果。
    const one = auth.refresh(), two = auth.refresh();
    auth.logout();
    finish(Response.json({ accessToken: 'new' }));
    assert.equal(await one, false);
    assert.equal(await two, false);
    assert.equal(calls, 1);
    assert.deepEqual(auth.credentials(), []);
});
