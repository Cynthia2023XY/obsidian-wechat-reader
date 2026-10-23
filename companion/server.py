"""仅监听回环地址、带随机密钥和客户端租约的版本化 API。"""
import argparse
import fcntl
import hmac
import json
import logging
import os
import secrets
import shutil
import signal
import sys
import threading
import time
import uuid
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, tostring
from email.utils import format_datetime
from datetime import datetime

from flask import Flask, Response, g, jsonify, request, send_file
from werkzeug.exceptions import HTTPException
from werkzeug.serving import make_server
from core import Problem, Store, utc
from jobs import Scheduler


# 程序固定身份供插件识别，不能只确认端口开放。
PROGRAM_ID = 'obsidian-wechat-reader-companion'


# 创建可注入测试采集器的服务，不启动上游 Web 应用。
def create_app(store, collector, secret, instance_id):
    app = Flask(__name__)
    app.config['MAX_CONTENT_LENGTH'] = 64 * 1024
    clients = {}
    client_lock = threading.RLock()
    resolved = {}
    resolve_lock = threading.Lock()
    scheduler = Scheduler(store, collector)
    app.extensions.update(store=store, collector=collector, scheduler=scheduler, clients=clients, client_lock=client_lock)

    # 所有端点要求密钥；网页来源必须精确匹配 Obsidian。
    @app.before_request
    def protect():
        g.request_id = uuid.uuid4().hex
        if request.host.split(':')[0] != '127.0.0.1':
            raise Problem('FORBIDDEN', '不允许的主机')
        if request.headers.get('Origin') not in (None, 'app://obsidian.md'):
            raise Problem('FORBIDDEN', '不允许的请求来源')
        if not hmac.compare_digest(request.headers.get('X-Reader-Key', ''), secret):
            raise Problem('UNAUTHORIZED', '本机访问密钥无效')
        if request.method in ('POST', 'PATCH') and not request.is_json:
            raise Problem('JSON_REQUIRED', '写操作必须使用 JSON')

    # 响应均带请求 ID，正文不进入日志。
    @app.after_request
    def headers(response):
        response.headers['X-Request-Id'] = g.get('request_id', '')
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    # 统一错误结构，禁止泄露堆栈和文件路径。
    @app.errorhandler(Exception)
    def error_response(error):
        if isinstance(error, Problem):
            status = {'UNAUTHORIZED': 401, 'FORBIDDEN': 403, 'NOT_FOUND': 404, 'AUTH_REQUIRED': 401}.get(error.code, 400)
        elif isinstance(error, HTTPException):
            status = error.code
            error = Problem('HTTP_ERROR', '请求不存在或格式不正确')
        else:
            status = 500
            error = Problem('INTERNAL', '本机程序处理失败，请重试或检查版本', True)
        return jsonify(error=error.payload(), requestId=g.get('request_id')), status

    # 数据响应统一添加请求 ID。
    def reply(data, status=200):
        return jsonify(data=data, requestId=g.request_id), status

    # 健康信息包含浏览器能力和存储占用。
    @app.get('/v1/health')
    def health():
        browsers = [str(path) for path in (Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), Path('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')) if path.exists()]
        return reply(dict(programId=PROGRAM_ID, instanceId=instance_id, engineVersion='0.1.0', apiVersion=1, schemaVersion=1,
                          capabilities=['login', 'subscriptions', 'articles', 'assets', 'rss-export', 'leases'],
                          browserAvailable=bool(browsers), diskFree=shutil.disk_usage(store.root).free,
                          diskUsed=sum(path.stat().st_size for path in (store.root / 'data').rglob('*') if path.is_file())))

    # 注册笔记库客户端，租约不包含笔记内容。
    @app.post('/v1/clients')
    def register_client():
        key = uuid.uuid4().hex
        with client_lock:
            clients[key] = time.monotonic() + 90
        return reply(dict(id=key, leaseSeconds=90), 201)

    # 客户端以独立接口续租；崩溃后无需依赖父 PID 回收。
    @app.post('/v1/clients/<key>/renew')
    def renew_client(key):
        with client_lock:
            if key not in clients:
                raise Problem('NOT_FOUND', '客户端租约已过期')
            clients[key] = time.monotonic() + 90
        return reply(dict(id=key, leaseSeconds=90))

    # 释放一个客户端，不影响其他笔记库。
    @app.delete('/v1/clients/<key>')
    def release_client(key):
        with client_lock:
            clients.pop(key, None)
        return reply(dict(released=True))

    # 返回脱敏登录状态。
    @app.get('/v1/auth/status')
    def auth_status():
        return reply(collector.auth_status())

    # 创建或复用当前二维码登录会话。
    @app.post('/v1/auth/login')
    def login():
        return reply(collector.start_login())

    # 查询当前二维码状态。
    @app.get('/v1/auth/login/<key>')
    def login_state(key):
        if key != collector.login['id']:
            raise Problem('NOT_FOUND', '二维码会话已失效')
        return reply(collector.login.copy())

    # 退出登录并暂停自动任务。
    @app.delete('/v1/auth/session')
    def logout():
        return reply(collector.logout())

    # 链接解析返回短时确认凭据，客户端不能伪造订阅身份。
    @app.post('/v1/accounts/resolve')
    def resolve():
        with resolve_lock:
            identity = collector.resolve(request.get_json().get('url', ''))
            key = uuid.uuid4().hex
            resolved[key] = (identity, time.monotonic() + 600)
            return reply(dict(**identity, resolutionId=key))

    # 列出订阅及最近同步结果。
    @app.get('/v1/accounts')
    def accounts():
        items = store.all('accounts')
        for item in items:
            item['lastJob'] = store.get('jobs', item['lastJobId']) if item.get('lastJobId') else None
        return reply(dict(items=items, nextCursor=None))

    # 订阅后立即排队采集最近十篇。
    @app.post('/v1/accounts')
    def subscribe():
        data = request.get_json()
        identity, expiry = resolved.get(data.get('resolutionId'), ({}, 0))
        if expiry < time.monotonic():
            raise Problem('RESOLUTION_EXPIRED', '解析结果已过期，请重新粘贴链接')
        with store.lock:
            account = store.subscribe(identity, data.get('displayName', ''))
            seed = identity.get('seedArticle')
            article, fresh = store.discover(account, seed) if seed else (None, False)
            needs_sync = account['firstSync'] or not account.get('lastJobId') or (article and article['state'] in ('pending', 'temporary_failure'))
            job = store.enqueue(account['id'], 'initial') if needs_sync else store.get('jobs', account['lastJobId'])
            if article and needs_sync:
                if fresh:
                    job['discovered'] += 1
                job['priorityArticleId'] = article['id']
                store.put('jobs', job)
        return reply(dict(account=account, jobId=job['id']), 201 if needs_sync else 200)

    # 修改显示名称、自动同步及已明确的间隔范围。
    @app.patch('/v1/accounts/<key>')
    def update_account(key):
        data = request.get_json()
        with store.lock:
            account = store.get('accounts', key)
            if 'displayName' in data:
                if not isinstance(data['displayName'], str) or not data['displayName'].strip():
                    raise Problem('INVALID_NAME', '显示名称不能为空')
                account['displayName'] = data['displayName'].strip()[:120]
            for field in ('autoSync', 'subscribed'):
                if field in data:
                    if not isinstance(data[field], bool):
                        raise Problem('INVALID_SETTING', '开关必须为布尔值')
                    account[field] = data[field]
            minimum, maximum = data.get('intervalMin', account['intervalMin']), data.get('intervalMax', account['intervalMax'])
            if not isinstance(minimum, int) or not isinstance(maximum, int) or not 60 <= minimum <= maximum <= 1440:
                raise Problem('INVALID_INTERVAL', '间隔范围须为 60～1440 分钟')
            account.update(intervalMin=minimum, intervalMax=maximum)
            store.put('accounts', account)
        return reply(account)

    # 取消订阅保留所有正文、资源和文章元数据。
    @app.delete('/v1/accounts/<key>/subscription')
    def unsubscribe(key):
        with store.lock:
            account = store.get('accounts', key)
            account.update(subscribed=False, autoSync=False)
            store.put('accounts', account)
            for job in store.all('jobs'):
                if job['accountId'] == key and job['state'] == 'queued':
                    job.update(state='cancelled', finishedAt=utc())
                    store.put('jobs', job)
        return reply(account)

    # 手动同步、失败重试共用同一防重任务入口。
    @app.post('/v1/accounts/<key>/sync')
    def sync(key):
        with store.lock:
            account = store.get('accounts', key)
            account['blocked'] = None
            store.put('accounts', account)
            job = store.enqueue(key)
        return reply(dict(jobId=job['id']), 202)

    # 查询持久化进度。
    @app.get('/v1/jobs/<key>')
    def job(key):
        return reply(store.get('jobs', key))

    # 只支持取消排队任务，运行任务保持有界请求收尾。
    @app.delete('/v1/jobs/<key>')
    def cancel_job(key):
        with store.lock:
            job = store.get('jobs', key)
            if job['state'] != 'queued':
                raise Problem('JOB_RUNNING', '只能取消排队任务，请暂停后续自动同步')
            job.update(state='cancelled', finishedAt=utc())
            store.put('jobs', job)
        return reply(job)

    # 文章列表支持稳定排序分页和更新时间游标。
    @app.get('/v1/articles')
    def articles():
        rows = store.all('articles')
        for field in ('accountId', 'state'):
            if request.args.get(field):
                rows = [a for a in rows if a[field] == request.args[field]]
        if request.args.get('updatedAfter'):
            rows = [a for a in rows if a['updatedAt'] > request.args['updatedAfter']]
        rows.sort(key=lambda a: (a.get('publishedAt') or '', a['id']), reverse=True)
        try:
            offset = max(0, int(request.args.get('cursor', 0)))
            limit = min(100, max(1, int(request.args.get('limit', 50))))
        except ValueError:
            raise Problem('INVALID_CURSOR', '分页游标无效')
        return reply(dict(items=rows[offset:offset + limit], nextCursor=str(offset + limit) if offset + limit < len(rows) else None))

    # 元信息与正文不泄露本机文件路径。
    @app.get('/v1/articles/<key>')
    def article(key):
        item = store.get('articles', key)
        assets = [{k: v for k, v in a.items() if k not in ('file', 'sourceUrl')} for a in item['assets']]
        return reply(dict(**{k: v for k, v in item.items() if k != 'assets'}, assets=assets, html=store.content(item)))

    # 图片补采仍通过唯一任务队列，保留已成功正文与资源。
    @app.post('/v1/articles/<key>/retry')
    def retry_article(key):
        with store.lock:
            article = store.get('articles', key)
            if article['state'] == 'unavailable':
                raise Problem('UNAVAILABLE', '永久不可用的文章不重复下载')
            article['retryImages'] = article['state'] == 'ready'
            article['state'] = 'temporary_failure'
            store.put('articles', article)
            job = store.enqueue(article['accountId'], 'retry')
        return reply(dict(jobId=job['id']), 202)

    # 鉴权后按归属读取图片，响应只允许已验证的图片类型。
    @app.get('/v1/articles/<key>/assets/<asset_id>')
    def asset(key, asset_id):
        path = store.asset_path(key, asset_id)
        mime = next(a['mime'] for a in store.get('articles', key)['assets'] if a['id'] == asset_id)
        return send_file(path, mimetype=mime)

    # 以同一索引导出 RSS 2.0，正文仅包含本地采集成功的文章。
    @app.get('/v1/feeds/<account_id>.xml')
    def feed(account_id):
        account = store.get('accounts', account_id)
        root = Element('rss', version='2.0')
        channel = SubElement(root, 'channel')
        SubElement(channel, 'title').text = account['displayName']
        SubElement(channel, 'link').text = 'https://mp.weixin.qq.com/'
        SubElement(channel, 'description').text = '个人本地公众号订阅导出'
        rows = [a for a in store.all('articles') if a['accountId'] == account_id and a['state'] == 'ready']
        for article in sorted(rows, key=lambda a: a.get('publishedAt') or '', reverse=True)[:100]:
            item = SubElement(channel, 'item')
            SubElement(item, 'title').text = article['title']
            SubElement(item, 'link').text = article['url']
            SubElement(item, 'guid', isPermaLink='false').text = article['id']
            if article.get('publishedAt'):
                SubElement(item, 'pubDate').text = format_datetime(datetime.fromisoformat(article['publishedAt'].replace('Z', '+00:00')))
            # 导出文件不引用鉴权资源或 localhost，图片由 Markdown 离线归档承担。
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(store.content(article), 'html.parser')
            for image in soup.find_all('img'):
                image.decompose()
            SubElement(item, 'description').text = str(soup)
        return Response(tostring(root, encoding='utf-8', xml_declaration=True), mimetype='application/rss+xml')

    return app


# 以动态端口启动单实例，最后一个租约过期后安全退出。
def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--check-browser', action='store_true')
    args = parser.parse_args()
    root = Path(args.root).expanduser().resolve()
    (root / 'runtime').mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = (root / 'runtime/instance.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    store = Store(root)
    # 所有上游文件必须写入独立凭据目录，日志不记录上游敏感响应。
    os.environ['WECHAT_READER_CREDENTIALS'] = str(root / 'data/credentials')
    sys.path.insert(0, str(Path(__file__).parent / 'upstream'))
    logging.disable(logging.CRITICAL)
    from collector import WeChatCollector
    if args.check_browser:
        from playwright.sync_api import sync_playwright
        from backend.runtime import launch_chromium
        with sync_playwright() as playwright:
            browser = launch_chromium(playwright.chromium, headless=True)
            page = browser.new_page()
            page.set_content('<p id=probe>browser-ready</p>')
            print(json.dumps(dict(browserReady=page.locator('#probe').inner_text() == 'browser-ready', browserVersion=browser.version)))
            browser.close()
        store.db.close()
        lock.close()
        return
    collector = WeChatCollector()
    instance_id, secret = uuid.uuid4().hex, secrets.token_urlsafe(32)
    app = create_app(store, collector, secret, instance_id)
    server = make_server('127.0.0.1', 0, app, threaded=True)
    discovery = root / 'runtime/instance.json'
    temporary = discovery.with_suffix('.tmp')
    temporary.write_text(json.dumps(dict(programId=PROGRAM_ID, apiVersion=1, engineVersion='0.1.0', instanceId=instance_id,
                                         port=server.server_port, key=secret)), encoding='utf-8')
    temporary.chmod(0o600)
    os.replace(temporary, discovery)
    scheduler = app.extensions['scheduler']
    scheduler.start()
    quit_event = threading.Event()

    # 信号处理仅请求停止，当前有界下载结束后再退出。
    def request_stop(*_):
        quit_event.set()
        scheduler.stop.set()
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    # 监控租约，初次启动给予插件注册宽限期。
    def monitor():
        grace = time.monotonic() + 60
        while not quit_event.wait(2):
            with app.extensions['client_lock']:
                clients = app.extensions['clients']
                for key, expires in list(clients.items()):
                    if expires <= time.monotonic():
                        clients.pop(key, None)
                alive = bool(clients)
            if time.monotonic() > grace and not alive:
                scheduler.stop.set()
                if not scheduler.busy:
                    break
        scheduler.stop.set()
        while scheduler.busy:
            time.sleep(0.5)
        server.shutdown()
    threading.Thread(target=monitor, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        scheduler.stop.set()
        discovery.unlink(missing_ok=True)
        store.db.close()
        lock.close()


if __name__ == '__main__':
    main()
