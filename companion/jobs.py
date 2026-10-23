"""全局串行队列与唯一订阅调度器。"""
import random
import threading
import time
from core import Problem, utc


# 所有客户端、手动请求与定时请求共享一个下载线程。
class Scheduler:
    # 在独立程序中建立唯一队列，不由插件调度采集。
    def __init__(self, store, collector, delay=5):
        self.store, self.collector, self.delay = store, collector, delay
        self.stop = threading.Event()
        self.busy = False
        self.thread = threading.Thread(target=self.loop, daemon=True)

    # 启动串行工作线程。
    def start(self):
        self.thread.start()

    # 只为到期订阅补排一次任务；登录失效与验证状态暂停自动采集。
    def schedule_due(self):
        if not self.collector.auth_status()['loggedIn']:
            return
        for account in self.store.all('accounts'):
            if account['subscribed'] and account['autoSync'] and not account['blocked'] and account['nextSyncAt'] <= time.time():
                self.store.enqueue(account['id'], 'automatic')

    # 依次处理队列，并在无任务时等待，避免空转。
    def loop(self):
        while not self.stop.is_set():
            try:
                self.schedule_due()
                queued = sorted((j for j in self.store.all('jobs') if j['state'] == 'queued'), key=lambda j: j['createdAt'])
                if queued:
                    self.busy = True
                    try:
                        self.run(queued[0])
                    finally:
                        self.busy = False
                else:
                    self.stop.wait(2)
            except Exception:
                self.stop.wait(5)

    # 一轮有界采集：整页无新增再停止，失败项独立重试。
    def run(self, job):
        with self.store.lock:
            job = self.store.get('jobs', job['id'])
            if job['state'] != 'queued':
                return
            account = self.store.get('accounts', job['accountId'])
            job.update(state='running', startedAt=utc())
            self.store.put('jobs', job)
        limit = 10 if account['firstSync'] else 30
        pending = []
        if job.get('priorityArticleId'):
            article = self.store.get('articles', job['priorityArticleId'])
            if article['state'] in ('pending', 'temporary_failure'):
                pending.append(article['id'])
        try:
            offset = 0
            has_more = False
            while offset < limit and job['source'] != 'retry':
                rows, has_more = self.collector.page(account, offset, 10)
                new_count = 0
                for item in rows[:10]:
                    article, fresh = self.store.discover(account, item)
                    new_count += int(fresh)
                    job['discovered'] += int(fresh)
                    if article['state'] in ('pending', 'temporary_failure') and article['id'] not in pending:
                        pending.append(article['id'])
                self.store.put('jobs', job)
                offset += 10
                if not rows or not has_more or new_count == 0:
                    break
            # 前轮积压从已保存偏移继续，不以某一篇旧文章作为整轮终点。
            backlog = account.get('nextOffset', 0)
            if job['source'] != 'retry' and not account['firstSync'] and backlog and len(pending) < limit and offset < limit:
                rows, more_backlog = self.collector.page(account, backlog, 10)
                for item in rows[:10]:
                    article, fresh = self.store.discover(account, item)
                    job['discovered'] += int(fresh)
                    if article['state'] in ('pending', 'temporary_failure') and article['id'] not in pending:
                        pending.append(article['id'])
                account['nextOffset'] = backlog + 10 if more_backlog else 0
            elif has_more and offset >= limit:
                account['nextOffset'] = max(backlog, offset)
            for article in self.store.all('articles'):
                if article['accountId'] == account['id'] and article['state'] in ('pending', 'temporary_failure') and article['id'] not in pending:
                    pending.append(article['id'])
            for key in pending[:limit]:
                article = self.store.get('articles', key)
                article['state'] = 'downloading'
                self.store.put('articles', article)
                try:
                    self.collector.download(article, self.store)
                    job['succeeded'] += 1
                except Problem as error:
                    article.update(state='unavailable' if error.code == 'UNAVAILABLE' else 'temporary_failure', error=error.payload(), updatedAt=utc())
                    self.store.put('articles', article)
                    job['failed'] += 1
                    if error.action or error.code == 'DISK_FULL':
                        raise
                self.store.put('jobs', job)
                if self.stop.wait(self.delay):
                    raise Problem('INTERRUPTED', '程序已安全停止，可以重新同步', True)
            job['state'] = ('partial' if job['succeeded'] else 'failed') if job['failed'] else 'succeeded'
            account.update(firstSync=False, blocked=None)
        except Problem as error:
            job.update(state='waiting_verification' if error.action in ('login', 'verify') else 'failed', error=error.payload())
            if error.action:
                account['blocked'] = error.payload()
        except Exception:
            job.update(state='failed', error=Problem('INTERNAL', '采集异常，请重新同步或检查程序版本', True).payload())
        finally:
            # 重新读取可能由用户同时修改的订阅设置，避免覆盖暂停和改名。
            current = self.store.get('accounts', account['id'])
            current.update({key: account[key] for key in ('firstSync', 'blocked', 'nextOffset')})
            current['nextSyncAt'] = time.time() + random.uniform(current['intervalMin'], current['intervalMax']) * 60
            job['finishedAt'] = utc()
            self.store.put('jobs', job)
            self.store.put('accounts', current)
