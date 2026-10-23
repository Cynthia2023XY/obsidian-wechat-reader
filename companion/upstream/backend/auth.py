"""
登录认证模块
管理微信读书平台官方扫码登录、凭证验证和状态查询
完全基于微信读书 App 扫码协议 (wxab9b71ad2b90ff34) 与长效 Token 交换
"""

import os
import json
import time
import uuid
import random
import hashlib
import threading
import urllib.request
import urllib.parse
import ssl
from pathlib import Path
from flask import Blueprint, jsonify, request

from backend.config import (
    CONFIG_FILE, DATA_DIR, load_json, save_json,
    get_proxies_dict, get_settings
)
from backend.account_pool import (
    account_pool, borrow_weread_session, get_weread_session,
    generate_random_device_profile
)
from backend.weread_signer import gen_signature

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")

APP_HEADERS = {
    'User-Agent': 'WeRead/7.5.0 (Android; 33; arm64-v8a)',
    'Content-Type': 'application/json; charset=UTF-8',
}

# 登录状态管理
_login_state = {
    "status": "idle",       # idle / scanning / scanned / success / failed / expired
    "message": "",
    "progress": 0,
    "qrcode": "",           # 二维码图片 URL
    "uuid": "",
}
_login_lock = threading.Lock()
_poll_stop_event = threading.Event()


def _set_login_state(status: str, message: str = "", progress: int = 0, qrcode: str = "", uuid_val: str = ""):
    with _login_lock:
        _login_state["status"] = status
        _login_state["message"] = message
        _login_state["progress"] = progress
        if qrcode:
            _login_state["qrcode"] = qrcode
        if uuid_val:
            _login_state["uuid"] = uuid_val


def get_wx_ticket() -> dict:
    """获取微信读书 wxticket"""
    url = 'https://i.weread.qq.com/wxticket?nonceStr=weread'
    s = get_weread_session()
    resp = s.get(url, headers=APP_HEADERS, timeout=10)
    return resp.json()


def get_qr_data() -> dict:
    """获取微信读书扫码登录二维码数据 (uuid)"""
    ticket = get_wx_ticket()
    appid = 'wxab9b71ad2b90ff34'
    scope = 'snsapi_userinfo,snsapi_timeline,snsapi_friend,snsapi_favorites'
    params = urllib.parse.urlencode({
        'appid': appid,
        'noncestr': 'weread',
        'timestamp': ticket['timeStamp'],
        'scope': scope,
        'signature': ticket['signature']
    })
    url = f'https://open.weixin.qq.com/connect/sdk/qrconnect?{params}'
    s = get_weread_session()
    resp = s.get(url, headers=APP_HEADERS, timeout=10)
    return resp.json()


def calculate_anti_replay_signature(device_id: str, timestamp: int, rand_val: int) -> str:
    raw_str = f"{timestamp}{device_id}{rand_val}"
    return hashlib.sha256(raw_str.encode('utf-8')).hexdigest()


def exchange_weread_token(auth_code: str, device_profile: dict = None) -> dict:
    """使用扫码回调的 auth_code 换取微信读书长效 Token（绑定独立设备指纹）"""
    if not device_profile:
        device_profile = generate_random_device_profile()
    device_id = device_profile.get("deviceId") or hashlib.md5(uuid.uuid4().bytes).hexdigest()
    device_name = device_profile.get("deviceName", "Xiaomi 14")
    install_id = device_profile.get("installId", str(uuid.uuid4()))
    ua = device_profile.get("userAgent", APP_HEADERS['User-Agent'])

    ts = int(time.time() * 1000)
    rand_val = random.randint(0, 999)
    signature = calculate_anti_replay_signature(device_id, ts, rand_val)

    payload = {
        "code": auth_code,
        "deviceId": device_id,
        "trackId": "",
        "timestamp": ts,
        "random": rand_val,
        "signature": signature,
        "wxToken": 1,
        "appFirstInstall": 0,
        "virtualChannelId": "",
        "installId": install_id,
        "isFromQrcode": 1,
        "isAutoLogout": 0,
        "deviceName": "Android",
        "deviceType": 1
    }

    url = 'https://i.weread.qq.com/login'
    s = get_weread_session()
    headers = {**APP_HEADERS, "User-Agent": ua}
    resp = s.post(url, json=payload, headers=headers, timeout=12)
    res = resp.json()
    res['deviceId'] = device_id
    res['deviceName'] = device_name
    res['installId'] = install_id
    res['userAgent'] = ua
    return res


