"""以真实封装程序验证启动、租约、多实例和系统浏览器兼容性。"""
import json
import subprocess
import tempfile
import time
from pathlib import Path
import requests


# 安装包必须在不依赖 .venv 的子进程中工作。
def main():
    root = Path(__file__).resolve().parents[1]
    executable = root / 'dist/engine/wechat-reader-companion/wechat-reader-companion'
    with tempfile.TemporaryDirectory(prefix='公众号独立安装 测试 ') as directory:
        process = subprocess.Popen([str(executable), '--root', directory], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        discovery = Path(directory) / 'runtime/instance.json'
        try:
            deadline = time.monotonic() + 40
            while not discovery.exists() and time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError('封装程序提前退出：' + process.stderr.read().decode()[-2000:])
                time.sleep(0.2)
            data = json.loads(discovery.read_text())
            base = f'http://127.0.0.1:{data["port"]}'
            headers = {'X-Reader-Key':data['key']}
            health = requests.get(base+'/v1/health',headers=headers,timeout=10).json()['data']
            assert health['programId'] == 'obsidian-wechat-reader-companion'
            assert requests.get(base+'/v1/health',timeout=10).status_code == 401
            assert discovery.stat().st_mode & 0o077 == 0
            first = requests.post(base+'/v1/clients',json={},headers=headers,timeout=10).json()['data']['id']
            second = requests.post(base+'/v1/clients',json={},headers=headers,timeout=10).json()['data']['id']
            requests.delete(base+'/v1/clients/'+first,headers=headers,timeout=10)
            assert requests.post(base+'/v1/clients/'+second+'/renew',json={},headers=headers,timeout=10).status_code == 200
            duplicate = subprocess.run([str(executable),'--root',directory],timeout=15,capture_output=True)
            assert duplicate.returncode == 0
            assert json.loads(discovery.read_text())['instanceId'] == data['instanceId']
            print(json.dumps(dict(packagedStartup=True,programIdentity=True,authentication=True,privateDiscovery=True,
                                  independentClientLeases=True,singleInstance=True,browserDetected=health['browserAvailable']),ensure_ascii=False))
        finally:
            process.terminate()
            try:
                process.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill();process.communicate()
                raise RuntimeError('程序未能安全停止')
        assert not discovery.exists()
        browser = subprocess.run([str(executable),'--root',directory,'--check-browser'],timeout=60,capture_output=True,text=True)
        if browser.returncode:
            raise RuntimeError('封装浏览器检查失败：'+browser.stderr[-2000:])
        print(browser.stdout.strip())


if __name__ == '__main__':
    main()
