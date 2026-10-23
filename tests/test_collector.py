"""正文边界、失败分类和图片补采测试，固定响应不联网。"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion/upstream'))
from core import Store, Problem
from collector import WeChatCollector


# 下载器测试直接注入脱敏 HTTP 响应，不初始化真实登录账号。
class CollectorTests(unittest.TestCase):
    # 准备独立文章与临时目录。
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory()
        os.environ['WECHAT_READER_CREDENTIALS']=str(Path(self.temporary.name)/'data/credentials')
        self.store=Store(self.temporary.name)
        self.account=self.store.subscribe(dict(platformId='MzE=',bookId='MP_31'),'正文测试')
        self.article,_=self.store.discover(self.account,dict(url='https://mp.weixin.qq.com/s/test',title='正文',reviewId='rid'))
        self.collector=object.__new__(WeChatCollector)

    # 仅删除本例创建的临时目录。
    def tearDown(self):
        self.store.db.close()
        self.temporary.cleanup()

    # 实际短链响应可能只给 reviewId，数字公众号 ID 仍是稳定身份。
    def test_resolve_identity_from_review_id(self):
        url='https://mp.weixin.qq.com/s/fixtureShortId'
        with patch.object(self.collector,'api',side_effect=[{'reviewIds':[{'url':url,'reviewId':'MP_WXS_3281168092_fixtureShortId'}]},{'title':'真实公众号名称'},{'review':{'createTime':1727142718,'mpInfo':{'title':'链接原文标题'}}}]):
            identity=self.collector.resolve(url)
        self.assertEqual(identity['bookId'],'MP_WXS_3281168092')
        self.assertEqual(identity['originalName'],'真实公众号名称')
        self.assertEqual(identity['seedArticle']['title'],'链接原文标题')
        self.assertEqual(identity['seedArticle']['publishedAt'],'2024-09-24T01:51:58Z')

    # 伪装成成功 HTTP 响应的错误页不能记为正文成功。
    def test_error_page_not_counted_as_ready(self):
        with patch('backend.downloader.fetch_wechat_article_html',return_value=('<html><body>系统出错</body></html>','','')):
            with self.assertRaises(Problem) as context:self.collector.download(self.article,self.store)
        self.assertEqual(context.exception.code,'EMPTY_CONTENT')
        self.assertNotEqual(self.store.get('articles',self.article['id'])['state'],'ready')

    # 正文去掉执行内容与外部执行资源，失败图片仍保留独立状态。
    def test_content_sanitized_and_asset_failure_separate(self):
        raw='<html><div id="js_content"><p onclick="bad()">真实正文</p><script>bad()</script><iframe src="https://evil"></iframe><video src="https://evil"></video><img data-src="https://evil.example/pixel.png"></div></html>'
        with patch('backend.downloader.fetch_wechat_article_html',return_value=(raw,'','')):
            article=self.collector.download(self.article,self.store)
        self.assertEqual(article['state'],'ready')
        self.assertEqual(article['assetState'],'partial')
        content=self.store.content(article)
        self.assertIn('真实正文',content)
        self.assertNotIn('onclick',content)
        self.assertNotIn('script',content)
        self.assertNotIn('iframe',content)
        self.assertNotIn('evil',content)

    # 无来源的装饰图片不能让已完整下载的文章被误报为缺图。
    def test_empty_image_placeholder_not_counted_as_failure(self):
        with patch('backend.downloader.fetch_wechat_article_html',return_value=('<div id="js_content"><p>正文</p><img alt="装饰占位"></div>','','')):
            article=self.collector.download(self.article,self.store)
        self.assertEqual(article['assets'],[])
        self.assertEqual(article['assetState'],'ready')

    # 频控时返回需处理状态，而不是逐篇继续刷重试。
    def test_rate_limit_maps_to_verification(self):
        with patch('backend.downloader.fetch_wechat_article_html',return_value=('','','浏览器渲染仍被风控拦截: 环境异常')):
            with self.assertRaises(Problem) as context:self.collector.download(self.article,self.store)
        self.assertEqual(context.exception.action,'verify')
        self.assertFalse(context.exception.retryable)

    # 已下载正文的补图片操作不能重新抓取原文页面。
    def test_image_retry_reuses_body(self):
        raw='<div id="js_content"><p>可读正文</p><img data-src="https://evil.example/image.png"></div>'
        with patch('backend.downloader.fetch_wechat_article_html',return_value=(raw,'','')):
            article=self.collector.download(self.article,self.store)
        article.update(retryImages=True,state='downloading')
        self.store.put('articles',article)
        with patch('backend.downloader.fetch_wechat_article_html') as fetch:
            updated=self.collector.download(article,self.store)
            fetch.assert_not_called()
        self.assertEqual(updated['state'],'ready')
        self.assertIn('可读正文',self.store.content(updated))

    # 永久删除页以墓碑分类，不作为临时失败反复请求。
    def test_deleted_article_is_unavailable(self):
        with patch('backend.downloader.fetch_wechat_article_html',return_value=('<p>内容已被作者删除</p>','','')):
            with self.assertRaises(Problem) as context:self.collector.download(self.article,self.store)
        self.assertEqual(context.exception.code,'UNAVAILABLE')


if __name__=='__main__':
    unittest.main()
