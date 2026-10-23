"""固定上游的安全适配层；不启动上游管理服务和调度器。"""
import base64
import hashlib
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import requests
from bs4 import BeautifulSoup
from core import Problem, canonical_url, utc


# 微信读书采集适配器只维护一个登录账号和一个二维码会话。
class WeChatCollector:
    # 凭据路径已由入口注入，导入不会接触旧服务数据。
    def __init__(self):
        from backend import auth
        from backend.account_pool import account_pool, get_weread_session, borrow_weread_session
        self.auth, self.pool = auth, account_pool
        self.session, self.borrow = get_weread_session(), borrow_weread_session
        self.login = dict(id=None, state='idle', qr=None)
        self.login_lock = threading.RLock()

    # 检测是否有本地可用凭据；实际请求仍会验证和续期。
    def auth_status(self):
        accounts = self.pool.list_accounts()
        return dict(loggedIn=any(a['status'] == 'active' for a in accounts), state=self.login['state'])

    # 清理当前独立凭据目录中的账号与登录会话。
    def logout(self):
        with self.login_lock:
            self.login = dict(id=None, state='idle', qr=None)
            for account in self.pool.list_accounts():
                self.pool.remove(account['id'])
            from backend.config import DATA_DIR
            (DATA_DIR / '.session.json').unlink(missing_ok=True)
        return self.auth_status()

    # 获取二维码并开启有限时长的扫码轮询。
    def start_login(self):
        with self.login_lock:
            if self.login['state'] in ('scanning', 'scanned'):
                return self.login.copy()
            try:
                data = self.auth.get_qr_data()
                key = data.get('uuid')
                if not key:
                    raise ValueError()
                image = data.get('qrcode', {}).get('qrcodebase64')
                if not image:
                    response = requests.get('https://open.weixin.qq.com/connect/qrcode/' + key, timeout=15, allow_redirects=False)
                    response.raise_for_status()
                    image = base64.b64encode(response.content).decode()
            except Exception:
                raise Problem('LOGIN_UNAVAILABLE', '暂时无法生成二维码，请检查网络后重试', True)
            self.login = dict(id=uuid.uuid4().hex, state='scanning', qr='data:image/jpeg;base64,' + image)
            threading.Thread(target=self.poll_login, args=(self.login['id'], key), daemon=True).start()
            return self.login.copy()

    # 扫码成功后仅保存一个账号，不向界面返回原始换票内容。
    def poll_login(self, login_id, key):
        from backend.account_pool import generate_random_device_profile
        deadline = time.monotonic() + 300
        profile = generate_random_device_profile()
        while time.monotonic() < deadline and self.login['id'] == login_id:
            try:
                response = self.session.get('https://long.open.weixin.qq.com/connect/l/qrconnect',
                                            params={'f': 'json', 'uuid': key}, timeout=28).json()
                code = response.get('wx_errcode', response.get('errcode'))
                with self.login_lock:
                    if self.login['id'] != login_id:
                        return
                    if code == 405:
                        info = self.auth.exchange_weread_token(response.get('wx_code'), profile)
                        if not info.get('vid') or not info.get('accessToken'):
                            self.login['state'] = 'failed'
                            return
                        for account in self.pool.list_accounts():
                            self.pool.remove(account['id'])
                        info.update(vid=str(info['vid']), nickname=info.get('user', {}).get('name', '微信读书用户'))
                        self.pool.add_or_update(info)
                        self.login.update(state='success', qr=None)
                        return
                    if code == 404:
                        self.login['state'] = 'scanned'
                    if code in (402, 403):
                        break
            except Exception:
                time.sleep(2)
        with self.login_lock:
            if self.login['id'] == login_id:
                self.login.update(state='expired', qr=None)

    # 凭据续期及上游错误统一映射，频控时立即暂停本轮请求。
    def api(self, path, params=None, body=None):
        for attempt in range(2):
            try:
                account_id, _, _, headers = self.borrow()
                # 延用扫码绑定的移动设备身份，避免同一凭据切换客户端画像。
                account = next((item for item in self.pool._load() if item['id'] == account_id), {})
                headers.update({'deviceId': account.get('deviceId', ''), 'User-Agent': account.get('userAgent') or self.auth.APP_HEADERS['User-Agent']})
            except RuntimeError:
                raise Problem('AUTH_REQUIRED', '登录已失效，请重新扫码', False, 'login')
            try:
                response = self.session.request('POST' if body is not None else 'GET',
                                               'https://i.weread.qq.com' + path, params=params,
                                               json=body, headers=headers, timeout=20)
            except requests.RequestException:
                if attempt == 0:
                    time.sleep(2)
                    continue
                raise Problem('NETWORK', '网络暂时不可用，请稍后重试', True, retry_after=120)
            if response.status_code == 401:
                self.pool.report(account_id, status_code=401)
                if attempt == 0:
                    continue
                raise Problem('AUTH_REQUIRED', '登录已失效，请重新扫码', False, 'login')
            if response.status_code == 499 and attempt == 0:
                try:
                    activation_required = response.json().get('errcode') == -2041
                except ValueError:
                    activation_required = False
                if activation_required:
                    from backend.weread_signer import activate_terminal_session
                    if activate_terminal_session(headers, session=self.session):
                        continue
            if response.status_code == 499:
                try:
                    upstream_code = response.json().get('errcode')
                except ValueError:
                    upstream_code = None
                if upstream_code not in (-2014, -2041) and not any(marker in response.text for marker in ('TCaptcha', 'captcha')):
                    raise Problem('UPSTREAM_REJECTED', '微信读书拒绝了公众号请求，请检查文章身份或稍后重试', True)
            if response.status_code in (429, 499) or 'TCaptcha' in response.text:
                raise Problem('VERIFICATION_REQUIRED', '需要验证或请求受限，请在手机微信读书中完成验证后重试', False, 'verify', 3600)
            if response.status_code >= 400:
                raise Problem('UPSTREAM', '微信读书请求失败，请稍后重试', True, retry_after=300)
            try:
                data = response.json()
            except ValueError:
                raise Problem('UPSTREAM_FORMAT', '上游返回了非 JSON 内容，请稍后重试', True)
            if data.get('errcode'):
                raise Problem('VERIFICATION_REQUIRED', '微信读书拒绝请求，请检查手机端账号状态', False, 'verify')
            return data
        raise Problem('AUTH_REQUIRED', '请重新扫码登录', False, 'login')

    # 根据文章链接解析稳定公众号身份，不以显示名称作为主键。
    def resolve(self, url):
        url = canonical_url(url)
        biz = parse_qs(urlsplit(url).query).get('__biz', [''])[0]
        book = ''
        review = ''
        if biz:
            try:
                book = 'MP_WXS_' + str(int(base64.b64decode(biz).decode()))
            except Exception:
                raise Problem('INVALID_IDENTITY', '文章链接中的公众号身份无效')
        if not book:
            data = self.api('/mp/getreviewid', body={'urls': [url]})
            review = next((item.get('reviewId', '') for item in data.get('reviewIds', []) if item.get('url') == url), '')
            book = data.get('bookId') or next((item.get('bookId') for item in data.get('reviewIds', []) if item.get('bookId')), '')
            if not book:
                # 微信短链解析有时仅返回 MP_WXS_公众号数字ID_文章短码。
                review = next((item.get('reviewId', '') for item in data.get('reviewIds', []) if item.get('url') == url), '')
                identity = re.fullmatch(r'MP_WXS_(\d+)_[A-Za-z0-9_-]+', review)
                if identity:
                    book = 'MP_WXS_' + identity.group(1)
        if not re.fullmatch(r'MP_WXS_\d+', book or ''):
            raise Problem('IDENTITY_REQUIRED', '未能解析公众号身份，请使用另一篇文章链接')
        if not biz:
            biz = base64.b64encode(book[len('MP_WXS_'):].encode()).decode()
        info = self.api('/book/info', {'bookId': book})
        name = info.get('title') or '微信公众号'
        seed = dict(url=url, reviewId=review, title=name + ' · 链接文章', publishedAt=None)
        if review:
            # 链接文章可能早于近期列表，通过稳定 reviewId 补齐标题和发布时间。
            detail = self.api('/review/single', {'reviewId': review})
            metadata = detail.get('review', detail)
            mp_info = metadata.get('mpInfo') or {}
            seed['title'] = mp_info.get('title') or seed['title']
            published = metadata.get('createTime') or mp_info.get('time')
            seed['publishedAt'] = utc(published) if published else None
        return dict(platformId=biz, bookId=book, originalName=name, seedArticle=seed)

    # 每页按稳定 reviewId 采集，不使用标题去重。
    def page(self, account, offset, count):
        data = self.api('/mp/chapters', {'bookId': account['bookId'], 'offset': offset, 'count': count, 'pf': 'android'})
        rows = data.get('data') or data.get('chapters') or data.get('list') or []
        if not rows and offset == 0:
            fallback = self.api('/article/list', {'bookId': account['bookId'], 'synckey': 0})
            rows = (fallback.get('reviews') or fallback.get('data') or [])[:count]
            if not rows:
                cover = self.api('/mp/cover', {'bookId': account['bookId']})
                if cover.get('reviewId'):
                    rows = [dict(cover, mpInfo={'title': cover.get('title', ''), 'doc_url': cover.get('doc_url', '')})]
        if not isinstance(rows, list):
            raise Problem('UPSTREAM_FORMAT', '文章列表格式已变化，需更新采集程序')
        result = []
        for item in rows:
            info = item.get('mpInfo') or {}
            review = item.get('reviewId') or ''
            from backend.wechat_url import short_id_from_review_id
            short = short_id_from_review_id(review)
            url = ('https://mp.weixin.qq.com/s/' + short) if short else info.get('doc_url') or ''
            if not url and review:
                detail = self.api('/review/single', {'reviewId': review})
                detail_info = detail.get('review', detail)
                original = detail_info.get('mpInfo', {}).get('originalId', '')
                url = ('https://mp.weixin.qq.com/s/' + original) if original else detail_info.get('mpInfo', {}).get('doc_url', '')
            if not url:
                raise Problem('ARTICLE_URL_MISSING', '上游文章缺少原文链接，未将本轮记为成功', True)
            result.append(dict(url=url, title=info.get('title') or item.get('title'), reviewId=review,
                               publishedAt=utc(item.get('createTime') or info.get('time')) if item.get('createTime') or info.get('time') else None,
                               summary=info.get('digest', '')))
        return result, bool(data.get('hasMore', len(rows) >= count))

    # 获取正文和图片，失败的图片保留单独状态，页面不会直接加载远端资源。
    def download(self, article, store):
        from backend.downloader import fetch_wechat_article_html, try_extract_gallery_article, check_wechat_risk_control
        if shutil.disk_usage(store.root).free < 100 * 1024 * 1024:
            raise Problem('DISK_FULL', '可用空间不足 100 MB，已停止下载，请释放空间', False, 'free_disk')
        if article.get('retryImages') and article.get('contentVersion'):
            raw, error = store.content(dict(article, state='ready')), ''
        else:
            raw, _, error = fetch_wechat_article_html(article['url'], article.get('reviewId', ''))
        if not raw and any(marker in (error or '') for marker in ('频控', '验证', '受限', '环境异常', '429', '499')):
            raise Problem('VERIFICATION_REQUIRED', '正文需要验证或请求受限，请先在手机处理', False, 'verify')
        if not raw:
            raise Problem('DOWNLOAD_FAILED', '正文下载失败，请检查网络或手机验证状态', True)
        if any(text in raw for text in ('内容已被作者删除', '此内容因违规无法查看', '该内容暂时无法查看')):
            raise Problem('UNAVAILABLE', '文章已删除或不可用')
        risk, _ = check_wechat_risk_control(raw)
        if risk:
            raise Problem('VERIFICATION_REQUIRED', '文章需要验证，请在微信打开原文处理', False, 'verify')
        if article.get('retryImages'):
            content = raw
        else:
            page = BeautifulSoup(raw, 'html.parser')
            title = page.select_one('#activity-name, .rich_media_title') or page.find('meta', property='og:title')
            if title:
                article['title'] = (title.get('content') or title.get_text(strip=True))[:500] or article['title']
            body = page.select_one('#js_content, .rich_media_content, #js_article')
            content = body.decode_contents() if body else try_extract_gallery_article(raw)
            if not content:
                raise Problem('EMPTY_CONTENT', '页面缺少文章正文，未计入阅读成功', True)
        soup = BeautifulSoup(content, 'html.parser')
        if not soup.get_text(strip=True) and not soup.find('img'):
            raise Problem('EMPTY_CONTENT', '未能解析正文', True)
        for tag in soup(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'svg', 'math', 'link', 'meta', 'base']):
            tag.decompose()
        assets = []
        temporary = store.root / 'data/articles' / (article['id'] + '.tmp')
        if temporary.exists():
            shutil.rmtree(temporary)
        temporary.mkdir(mode=0o700)
        for tag in list(soup.find_all(True)):
            if tag.name not in {'p','br','div','span','section','article','h1','h2','h3','h4','h5','h6','strong','b','em','i','u','s','blockquote','ul','ol','li','pre','code','table','thead','tbody','tr','th','td','hr','a','img','figure','figcaption'}:
                tag.unwrap()
                continue
            for key in list(tag.attrs):
                if key.lower().startswith('on') or key not in ('src', 'href', 'data-src', 'alt', 'title', 'colspan', 'rowspan'):
                    del tag.attrs[key]
            if tag.name == 'a':
                href = tag.get('href', '')
                if not href.startswith(('https://', 'http://')):
                    tag.attrs.pop('href', None)
            if tag.name != 'img':
                tag.attrs.pop('src', None)
                tag.attrs.pop('data-src', None)
                continue
            url = tag.get('data-src') or tag.get('src', '')
            if not url:
                tag.decompose()
                continue
            if url.startswith('//'):
                url = 'https:' + url
            previous = next((a for a in article['assets'] if url == 'asset:' + a['id']), None)
            if previous:
                url = previous.get('sourceUrl', '')
            key = previous['id'] if previous else hashlib.sha256(url.encode()).hexdigest()[:24]
            asset = dict(id=key, file=key + '.img', state='failed', mime='application/octet-stream', sourceUrl=url)
            if previous and previous['state'] == 'ready':
                try:
                    shutil.copy2(store.asset_path(article['id'], key), temporary / asset['file'])
                    asset.update(state='ready', mime=previous['mime'])
                except Exception:
                    pass
            host = urlsplit(url).hostname or ''
            if asset['state'] != 'ready' and urlsplit(url).scheme == 'https' and (host == 'mmbiz.qpic.cn' or host.endswith('.qpic.cn') or host.endswith('.qlogo.cn')):
                try:
                    response = requests.get(url, timeout=20, allow_redirects=False, stream=True)
                    mime = response.headers.get('Content-Type', '').split(';')[0]
                    if response.status_code != 200 or mime not in ('image/jpeg', 'image/png', 'image/gif', 'image/webp'):
                        raise ValueError()
                    size = 0
                    with (temporary / asset['file']).open('wb') as output:
                        for chunk in response.iter_content(65536):
                            size += len(chunk)
                            if size > 20 * 1024 * 1024:
                                raise ValueError()
                            output.write(chunk)
                    asset.update(state='ready', mime=mime)
                except Exception:
                    (temporary / asset['file']).unlink(missing_ok=True)
            if not any(a['id'] == key for a in assets):
                assets.append(asset)
            tag.attrs = {'src': 'asset:' + key, 'alt': tag.get('alt', '文章图片')}
        article.pop('retryImages', None)
        return store.commit_content(article, str(soup), assets, temporary)
