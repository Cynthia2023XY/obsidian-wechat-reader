"""构建 macOS arm64 免 Python 安装的附属程序及完整安装包。"""
import platform
import shutil
import subprocess
import sys
from pathlib import Path


# 构建必须在实际支持的平台执行，禁止生成误导的平台包。
def main():
    if sys.platform != 'darwin' or platform.machine() != 'arm64':
        raise SystemExit('本安装包仅在 macOS arm64 构建')
    root = Path(__file__).resolve().parents[2]
    subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
                    '--name', 'wechat-reader-companion', '--distpath', str(root / 'dist/engine'),
                    '--workpath', str(root / 'build/pyinstaller'), '--specpath', str(root / 'build'),
                    '--paths', str(root / 'companion'), '--paths', str(root / 'companion/upstream'),
                    '--collect-all', 'playwright', '--collect-data', 'certifi',
                    '--hidden-import', 'backports.tarfile', '--hidden-import', 'backend.auth', '--hidden-import', 'backend.account_pool',
                    '--hidden-import', 'backend.downloader', '--hidden-import', 'backend.content_filter',
                    '--hidden-import', 'backend.avatar_cache', '--hidden-import', 'backend.runtime',
                    str(root / 'companion/server.py')], check=True, cwd=root)
    package = root / 'dist/wechat-reader'
    package.mkdir(exist_ok=True)
    for name in ('main.js', 'manifest.json', 'styles.css', 'README.md'):
        shutil.copy2(root / name, package / name)
    shutil.copytree(root / 'dist/engine', package / 'engine', dirs_exist_ok=True)
    shutil.copytree(root / 'companion/upstream', package / 'licenses/upstream', ignore=shutil.ignore_patterns('*.py', '__pycache__'), dirs_exist_ok=True)
    shutil.make_archive(str(root / 'dist/wechat-reader-0.1.0-macos-arm64'), 'zip', root / 'dist', 'wechat-reader')
    print('安装包已生成：dist/wechat-reader-0.1.0-macos-arm64.zip')


if __name__ == '__main__':
    main()
