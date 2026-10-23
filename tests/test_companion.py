"""使用脱敏内存采集器验证身份、任务恢复、安全边界和 RSS。"""
import json
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from xml.etree.ElementTree import fromstring

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from core import Store, Problem, canonical_url
from server import create_app
from jobs import Scheduler


# 固定夹具不联网，也不读取任何真实登录凭据。
class FakeCollector:
    # 初始化可控分页与错误注入。
    def __init__(self):
        self.login = dict(id='login', state='idle', qr=None)
        self.pages = {}
        self.downloaded = []
        self.problem = None

    # 夹具总是有登录态以验证调度。
    def auth_status(self):
        return dict(loggedIn=True, state='success')

    # 返回固定扫码占位状态，不生成真实授权请求。
    def start_login(self):
        return self.login

    # 模拟退出登录。
    def logout(self):
        return dict(loggedIn=False)

    # 模拟解析出明确的稳定公众号身份。
    def resolve(self, url):
        canonical_url(url)
        return dict(platformId='MzE=', bookId='MP_31', originalName='测试公众号')

    # 用偏移列表验证不会见到旧文章就停止整轮。
    def page(self, account, offset, count):
        if self.problem:
            raise self.problem
        return self.pages.get(offset, ([], False))

    # 写入真实临时正文文件并提交 SQLite，验证文件一致性。
    def download(self, article, store):
        self.downloaded.append(article['id'])
        temporary = store.root / 'data/articles' / (article['id'] + '.tmp')
        temporary.mkdir(exist_ok=True)
        store.commit_content(article, '<p>离线正文 &amp; 证据</p>', [], temporary)


# 每个测试隔离 SQLite、凭据目录与正文文件。
class CompanionTests(unittest.TestCase):
    # 准备安全 API 测试客户端与固定公众号。
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = Store(self.temporary.name)
        self.collector = FakeCollector()
        self.account = self.store.subscribe(dict(platformId='MzE=', bookId='MP_31', originalName='原名'), '测试公众号')
        self.app = create_app(self.store, self.collector, 'secret-for-test', 'instance')
        self.client = self.app.test_client()
        self.headers = {'X-Reader-Key': 'secret-for-test', 'Host': '127.0.0.1'}

    # 关闭连接后删除隔离数据。
    def tearDown(self):
        self.store.db.close()
        self.temporary.cleanup()

    # 生成具有独立稳定文章身份的脱敏文章。
    def item(self, index, title='相同标题'):
        return dict(url=f'https://mp.weixin.qq.com/s/fixture{index}', title=title, reviewId=f'review-{index}', publishedAt='2026-10-23T00:00:00Z')

    # 拒绝无密钥访问，不把程序身份当作鉴权替代。
    def test_requires_secret(self):
        response = self.client.get('/v1/health', headers={'Host': '127.0.0.1'})
        self.assertEqual(response.status_code, 401)
        self.assertIn('requestId', response.json)

    # 恶意网页即使知道密钥也不能驱动写入。
    def test_rejects_web_origin(self):
        response = self.client.post('/v1/clients', json={}, headers=dict(self.headers, Origin='https://attacker.example'))
        self.assertEqual(response.status_code, 403)

    # 严格 Host 检查拒绝 DNS rebinding 类请求。
    def test_rejects_foreign_host(self):
        self.assertEqual(self.client.get('/v1/health', headers={'X-Reader-Key':'secret-for-test','Host':'attacker.example'}).status_code,403)

    # 写入请求必须显式使用 JSON。
    def test_requires_json(self):
        self.assertEqual(self.client.post('/v1/clients', data='{}',headers=self.headers).status_code,400)

    # 不允许任意网络地址作为公众号输入。
    def test_rejects_non_wechat_input(self):
        for url in ('file:///etc/passwd','https://127.0.0.1/s/a','https://mp.weixin.qq.com.evil/s/a','https://mp.weixin.qq.com:443/s/a'):
            with self.assertRaises(Problem): canonical_url(url)

    # URL 仅去除追踪信息，定位参数必须保留。
    def test_canonical_keeps_identity_parameters(self):
        url = canonical_url('https://mp.weixin.qq.com/s?__biz=abc&mid=1&idx=2&sn=xx&scene=3#rd')
        self.assertIn('mid=1',url)
        self.assertIn('idx=2',url)
        self.assertIn('sn=xx',url)
        self.assertNotIn('scene',url)

    # 改显示名与重复订阅不创建新公众号。
    def test_rename_preserves_account_identity(self):
        other = self.store.subscribe(self.account,'新显示名')
        self.assertEqual(other['id'],self.account['id'])
        self.assertEqual(len(self.store.all('accounts')),1)

    # 相同标题的两篇文章必须独立保存。
    def test_same_title_not_deduplicated(self):
        first,_=self.store.discover(self.account,self.item(1))
        second,_=self.store.discover(self.account,self.item(2))
        self.assertNotEqual(first['id'],second['id'])

    # 后补可靠 reviewId 必须保留已分配 articleId。
    def test_late_review_id_keeps_article_id(self):
        item=self.item(1); item.pop('reviewId')
        first,_=self.store.discover(self.account,item)
        second,fresh=self.store.discover(self.account,self.item(1))
        self.assertEqual(first['id'],second['id'])
        self.assertFalse(fresh)
        self.assertEqual(second['reviewId'],'review-1')

    # 并发点击和多个客户端只能获得一个有效任务。
    def test_enqueue_concurrent_deduplication(self):
        with ThreadPoolExecutor(max_workers=8) as executor:
            jobs=list(executor.map(lambda _:self.store.enqueue(self.account['id']),range(20)))
        self.assertEqual(len({job['id'] for job in jobs}),1)

    # 整页中夹有旧文章时不能漏掉后续新项或下一页。
    def test_pagination_crosses_old_item(self):
        self.account['firstSync']=False
        self.store.put('accounts',self.account)
        self.store.discover(self.account,self.item(1))
        self.collector.pages={0:([self.item(1),self.item(2)],True),10:([self.item(3)],False)}
        job=self.store.enqueue(self.account['id'])
        Scheduler(self.store,self.collector,0).run(job)
        result=self.store.get('jobs',job['id'])
        self.assertEqual(result['discovered'],2)
        self.assertEqual(result['succeeded'],3)
        self.assertEqual(len(self.collector.downloaded),3)

    # 首轮有上限并记录积压游标，后轮继续。
    def test_first_round_limited_to_ten(self):
        self.collector.pages={0:([self.item(i) for i in range(10)],True)}
        job=self.store.enqueue(self.account['id'])
        Scheduler(self.store,self.collector,0).run(job)
        self.assertEqual(len(self.collector.downloaded),10)
        self.assertEqual(self.store.get('accounts',self.account['id'])['nextOffset'],10)

    # 验证要求必须暂停自动调度，不当作成功空列表。
    def test_verification_pauses_account(self):
        self.collector.problem=Problem('VERIFICATION_REQUIRED','请验证',False,'verify')
        job=self.store.enqueue(self.account['id'])
        scheduler=Scheduler(self.store,self.collector,0)
        scheduler.run(job)
        self.assertEqual(self.store.get('jobs',job['id'])['state'],'waiting_verification')
        self.assertEqual(self.store.get('accounts',self.account['id'])['blocked']['action'],'verify')
        scheduler.schedule_due()
        self.assertEqual(len(self.store.all('jobs')),1)

    # 排队取消与工作线程提取同时发生时，不能重新启动已取消任务。
    def test_cancelled_job_not_restarted(self):
        job=self.store.enqueue(self.account['id'])
        cancelled=dict(job,state='cancelled')
        self.store.put('jobs',cancelled)
        Scheduler(self.store,self.collector,0).run(job)
        self.assertEqual(self.store.get('jobs',job['id'])['state'],'cancelled')
        self.assertEqual(self.collector.downloaded,[])

    # 补图片不依赖文章分页接口，避免验证阻塞无关资源恢复。
    def test_image_retry_skips_discovery_requests(self):
        article,_=self.store.discover(self.account,self.item(1))
        article['state']='temporary_failure'
        self.store.put('articles',article)
        self.collector.problem=Problem('VERIFICATION_REQUIRED','分页不可用',False,'verify')
        job=self.store.enqueue(self.account['id'],'retry')
        Scheduler(self.store,self.collector,0).run(job)
        self.assertEqual(self.store.get('jobs',job['id'])['state'],'succeeded')
        self.assertEqual(len(self.collector.downloaded),1)

    # 用户粘贴的历史文章必须优先进入首轮，不被近期列表挤出数量上限。
    def test_input_article_prioritized_before_recent_items(self):
        seed,_=self.store.discover(self.account,self.item(99))
        self.collector.pages={0:([self.item(i) for i in range(10)],True)}
        job=self.store.enqueue(self.account['id'])
        job['priorityArticleId']=seed['id']
        self.store.put('jobs',job)
        Scheduler(self.store,self.collector,0).run(job)
        self.assertEqual(self.collector.downloaded[0],seed['id'])
        self.assertEqual(len(self.collector.downloaded),10)

    # 服务异常重启修复下载状态及中断任务。
    def test_restart_repairs_interrupted_state(self):
        article,_=self.store.discover(self.account,self.item(1)); article['state']='downloading'; self.store.put('articles',article)
        job=self.store.enqueue(self.account['id']);job['state']='running';self.store.put('jobs',job)
        self.store.db.close()
        self.store=Store(self.temporary.name)
        self.assertEqual(self.store.get('jobs',job['id'])['state'],'interrupted')
        self.assertEqual(self.store.get('articles',article['id'])['state'],'temporary_failure')

    # 客户端租约相互独立，一个退出不能删除另一个。
    def test_multiple_clients_leases(self):
        first=self.client.post('/v1/clients',json={},headers=self.headers).json['data']['id']
        second=self.client.post('/v1/clients',json={},headers=self.headers).json['data']['id']
        self.client.delete('/v1/clients/'+first,headers=self.headers)
        self.assertEqual(self.client.post('/v1/clients/'+second+'/renew',json={},headers=self.headers).status_code,200)
        self.assertIn(second,self.app.extensions['clients'])

    # 没有服务端确认凭据不能凭名称创建空订阅。
    def test_resolve_confirmation_required(self):
        response=self.client.post('/v1/accounts',json={'displayName':'伪造'},headers=self.headers)
        self.assertEqual(response.status_code,400)
        self.assertEqual(len(self.store.all('accounts')),1)

    # 已同步公众号的重复订阅复用原记录，不额外触发新一轮采集。
    def test_repeat_subscription_does_not_start_new_job(self):
        job=self.store.enqueue(self.account['id'])
        job['state']='succeeded';self.store.put('jobs',job)
        account=self.store.get('accounts',self.account['id']);account['firstSync']=False;self.store.put('accounts',account)
        resolution=self.client.post('/v1/accounts/resolve',json={'url':'https://mp.weixin.qq.com/s/fixture'},headers=self.headers).json['data']
        response=self.client.post('/v1/accounts',json={'resolutionId':resolution['resolutionId'],'displayName':'测试公众号'},headers=self.headers)
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json['data']['jobId'],job['id'])
        self.assertEqual(len(self.store.all('jobs')),1)

    # 取消订阅不会删除文章，排队任务同步取消。
    def test_unsubscribe_preserves_content(self):
        self.store.discover(self.account,self.item(1))
        job=self.store.enqueue(self.account['id'])
        self.client.delete(f'/v1/accounts/{self.account["id"]}/subscription',headers=self.headers)
        self.assertEqual(len(self.store.all('articles')),1)
        self.assertEqual(self.store.get('jobs',job['id'])['state'],'cancelled')

    # 运行中的任务不能被伪装为即时取消。
    def test_running_job_cannot_be_cancelled(self):
        job=self.store.enqueue(self.account['id']);job['state']='running';self.store.put('jobs',job)
        self.assertEqual(self.client.delete('/v1/jobs/'+job['id'],headers=self.headers).status_code,400)

    # 资源必须归属当前文章，不能利用路径穿越读取其他文件。
    def test_asset_ownership_and_traversal(self):
        article,_=self.store.discover(self.account,self.item(1))
        article.update(state='ready',contentVersion='version',assets=[dict(id='bad',file='../../../../collector.sqlite',state='ready',mime='image/png')])
        self.store.put('articles',article)
        with self.assertRaises(Problem):self.store.asset_path(article['id'],'bad')
        with self.assertRaises(Problem):self.store.asset_path(article['id'],'unknown')

    # RSS 只导出正文成功项，稳定 GUID 不含凭据。
    def test_rss_contains_ready_articles_only(self):
        article,_=self.store.discover(self.account,self.item(1))
        self.store.discover(self.account,self.item(2))
        self.collector.download(article,self.store)
        response=self.client.get(f'/v1/feeds/{self.account["id"]}.xml',headers=self.headers)
        root=fromstring(response.data)
        items=root.findall('./channel/item')
        self.assertEqual(len(items),1)
        self.assertEqual(items[0].findtext('guid'),article['id'])
        self.assertNotIn(b'secret-for-test',response.data)
        self.assertNotIn(b'127.0.0.1',response.data)

    # 睡眠造成多次错过调度时，每账号也只有一个补同步任务。
    def test_due_schedule_coalesces(self):
        scheduler=Scheduler(self.store,self.collector,0)
        for _ in range(10):scheduler.schedule_due()
        self.assertEqual(len(self.store.all('jobs')),1)

    # 改名或暂停在采集中发生时不能被任务结束覆盖。
    def test_job_preserves_concurrent_setting_change(self):
        self.collector.pages={0:([self.item(1)],False)}
        original=self.collector.download
        def download(article,store):
            current=store.get('accounts',self.account['id']);current.update(displayName='任务中改名',autoSync=False);store.put('accounts',current)
            original(article,store)
        self.collector.download=download
        Scheduler(self.store,self.collector,0).run(self.store.enqueue(self.account['id']))
        account=self.store.get('accounts',self.account['id'])
        self.assertEqual(account['displayName'],'任务中改名')
        self.assertFalse(account['autoSync'])


if __name__=='__main__':
    unittest.main()
