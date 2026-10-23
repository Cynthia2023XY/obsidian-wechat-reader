"""独立采集索引、稳定身份与可恢复的单写入存储。"""
import hashlib
import json
import os
import shutil
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


# 所有 API 使用相同的可展示业务错误，避免返回内部异常及凭据。
class Problem(Exception):
    # 初始化可重试分类及用户动作。
    def __init__(self, code, message, retryable=False, action=None, retry_after=None):
        super().__init__(message)
        self.code, self.message = code, message
        self.retryable, self.action, self.retry_after = retryable, action, retry_after

    # 生成稳定协议错误结构。
    def payload(self):
        return dict(code=self.code, message=self.message, retryable=self.retryable,
                    action=self.action, retryAfter=self.retry_after)


# 生成跨时区一致的 UTC 时间。
def utc(timestamp=None):
    return datetime.fromtimestamp(timestamp or time.time(), timezone.utc).isoformat().replace('+00:00', 'Z')


# 保留微信文章定位参数，仅剔除已确认的追踪参数。
def canonical_url(url):
    parts = urlsplit(url.strip())
    if parts.scheme not in ('https', 'http') or parts.hostname != 'mp.weixin.qq.com' or parts.port or parts.username:
        raise Problem('INVALID_URL', '请粘贴 mp.weixin.qq.com 的文章链接')
    if not parts.path.startswith('/s'):
        raise Problem('INVALID_URL', '链接不是微信公众号文章')
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if k not in {'scene', 'from', 'isappinstalled', 'clicktime', 'enterid', 'subscene'}]
    return urlunsplit(('https', 'mp.weixin.qq.com', parts.path, urlencode(sorted(query)), ''))


# 通过身份摘要生成不含路径字符的内部 ID。
def stable_id(kind, value):
    return kind + '_' + hashlib.sha256(value.encode()).hexdigest()[:32]


# SQLite 是订阅、任务和文章的唯一索引；正文仅在完整写入后引用。
class Store:
    # 建立私有目录及数据库，并修复上次中断状态。
    def __init__(self, root):
        self.root = Path(root)
        self.lock = threading.RLock()
        for name in ('data', 'data/articles', 'data/credentials', 'runtime', 'logs'):
            folder = self.root / name
            folder.mkdir(parents=True, exist_ok=True, mode=0o700)
            folder.chmod(0o700)
        self.db = sqlite3.connect(self.root / 'data/collector.sqlite', check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS articles (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, account_id TEXT, state TEXT, data TEXT NOT NULL);
          CREATE UNIQUE INDEX IF NOT EXISTS active_job ON jobs(account_id) WHERE state IN ('queued','running');
          CREATE TABLE IF NOT EXISTS aliases (alias TEXT PRIMARY KEY, article_id TEXT NOT NULL);
          PRAGMA user_version=1;
        ''')
        for job in self.all('jobs'):
            if job['state'] in ('running', 'queued'):
                job.update(state='interrupted', finishedAt=utc(), error=Problem('INTERRUPTED', '上次采集已中断，可以重新同步', True).payload())
                self.put('jobs', job)
        for article in self.all('articles'):
            if article['state'] == 'downloading':
                article['state'] = 'temporary_failure'
                self.put('articles', article)
        for folder in (self.root / 'data/articles').glob('*.tmp'):
            if folder.is_dir():
                shutil.rmtree(folder)

    # 按内部主键读取对象。
    def get(self, table, key):
        with self.lock:
            row = self.db.execute(f'SELECT data FROM {table} WHERE id=?', (key,)).fetchone()
            if not row:
                raise Problem('NOT_FOUND', '记录不存在')
            return json.loads(row[0])

    # 读取指定业务表快照。
    def all(self, table):
        with self.lock:
            return [json.loads(row[0]) for row in self.db.execute(f'SELECT data FROM {table}')]

    # 原子持久化对象，任务同时维护防重索引。
    def put(self, table, value):
        with self.lock, self.db:
            raw = json.dumps(value, ensure_ascii=False)
            if table == 'jobs':
                self.db.execute('INSERT OR REPLACE INTO jobs VALUES (?,?,?,?)', (value['id'], value['accountId'], value['state'], raw))
            else:
                self.db.execute(f'INSERT OR REPLACE INTO {table} VALUES (?,?)', (value['id'], raw))
        return value

    # 添加订阅并保持改名后的身份与文章关联。
    def subscribe(self, identity, name):
        platform = identity.get('platformId', '')
        book = identity.get('bookId', '')
        if not platform or not book.startswith('MP_') or not name.strip() or name.strip() in ('微信公众号', '公众号'):
            raise Problem('IDENTITY_REQUIRED', '需要已解析的真实公众号身份及显示名称')
        key = stable_id('account', book)
        with self.lock:
            try:
                account = self.get('accounts', key)
                account.update(subscribed=True, displayName=name.strip())
            except Problem:
                account = dict(id=key, platformId=platform, bookId=book, originalName=identity.get('originalName', name),
                               displayName=name.strip(), subscribed=True, autoSync=True, nextSyncAt=0,
                               intervalMin=60, intervalMax=90, nextOffset=0, firstSync=True, blocked=None, lastJobId=None)
            return self.put('accounts', account)

    # 文章 URL 与上游 reviewId 建立别名；后得到 reviewId 不改变本地 ID。
    def discover(self, account, item):
        url = canonical_url(item['url'])
        review = item.get('reviewId') or ''
        aliases = [account['id'] + ':url:' + url]
        if review:
            aliases.append(account['id'] + ':review:' + review)
        with self.lock, self.db:
            for alias in aliases:
                match = self.db.execute('SELECT article_id FROM aliases WHERE alias=?', (alias,)).fetchone()
                if match:
                    key = match[0]
                    break
            else:
                key = stable_id('article', aliases[-1])
            try:
                article = self.get('articles', key)
                fresh = False
            except Problem:
                article = dict(id=key, accountId=account['id'], title=item.get('title') or '未命名文章',
                               url=url, originalUrl=item['url'], reviewId=review, publishedAt=item.get('publishedAt'),
                               summary=item.get('summary', ''), state='pending', assets=[], assetState='pending',
                               contentVersion=None, updatedAt=utc(), error=None)
                fresh = True
            if item.get('publishedAt') and not article.get('publishedAt'):
                article['publishedAt'] = item['publishedAt']
                article['updatedAt'] = utc()
            if review and not article.get('reviewId'):
                article['reviewId'] = review
            for alias in aliases:
                self.db.execute('INSERT OR IGNORE INTO aliases VALUES (?,?)', (alias, key))
            self.put('articles', article)
            return article, fresh

    # 重复点击或多个笔记库同时同步时返回同一有效任务。
    def enqueue(self, account_id, source='manual'):
        with self.lock:
            account = self.get('accounts', account_id)
            for job in self.all('jobs'):
                if job['accountId'] == account_id and job['state'] in ('queued', 'running'):
                    return job
            job = dict(id=uuid.uuid4().hex, accountId=account_id, state='queued', source=source,
                       discovered=0, succeeded=0, failed=0, createdAt=utc(), startedAt=None, finishedAt=None, error=None)
            self.put('jobs', job)
            account['lastJobId'] = job['id']
            self.put('accounts', account)
            return job

    # 只返回归属于指定文章的资源，阻止任意文件读取。
    def asset_path(self, article_id, asset_id):
        article = self.get('articles', article_id)
        asset = next((a for a in article['assets'] if a['id'] == asset_id and a['state'] == 'ready'), None)
        if not asset:
            raise Problem('NOT_FOUND', '图片未下载或不属于该文章')
        base = (self.root / 'data/articles' / article_id / article['contentVersion']).resolve()
        path = (base / asset['file']).resolve()
        if not path.is_relative_to(base) or not path.is_file():
            raise Problem('NOT_FOUND', '本地图片不存在')
        return path

    # 正文版本目录先原子落盘，再提交数据库；旧版本保留供回退。
    def commit_content(self, article, html, assets, temporary):
        if not html.strip():
            raise Problem('EMPTY_CONTENT', '文章没有可阅读正文', True)
        version = hashlib.sha256(html.encode()).hexdigest()[:12] + '-' + uuid.uuid4().hex[:8]
        temp = Path(temporary)
        (temp / 'content.html').write_text(html, encoding='utf-8')
        target = self.root / 'data/articles' / article['id'] / version
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(temp, target)
        article.update(state='ready', assets=assets, assetState='ready' if all(a['state'] == 'ready' for a in assets) else 'partial',
                       contentVersion=version, updatedAt=utc(), error=None)
        return self.put('articles', article)

    # 从已提交的版本读取正文。
    def content(self, article):
        if article['state'] != 'ready':
            return ''
        path = self.root / 'data/articles' / article['id'] / article['contentVersion'] / 'content.html'
        try:
            return path.read_text(encoding='utf-8')
        except OSError:
            raise Problem('CONTENT_MISSING', '正文文件丢失，请重新下载', True)
