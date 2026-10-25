import { build } from 'esbuild';
import { mkdir, copyFile, cp, chmod, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
/** 固定随包 Node 版本，避免依赖宿主 Electron 的 SQLite ABI */
const directory = 'dist/engine/wechat-reader-companion';
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
if (process.platform !== 'darwin' || process.arch !== 'arm64' || Number(process.versions.node.split('.')[0]) < 26)
    throw new Error('当前封装要求 macOS arm64 与 Node 26+');
/** 构建输入清单用于收集实际打入运行产物的开源许可证 */
const runtimeBuild = await build({ metafile: true, entryPoints: ['runtime-ts/server.ts'], outfile: join(directory, 'server.cjs'), bundle: true, platform: 'node', target: 'node26', format: 'cjs', external: ['playwright-core'] });
await copyFile(process.execPath, join(directory, 'node'));
await chmod(join(directory, 'node'), 0o755);
await cp('node_modules/playwright-core', join(directory, 'node_modules/playwright-core'), { recursive: true });
/** 包装脚本只按安装目录启动固定 Node 和 TS 编译产物 */
const launcher = '#!/bin/sh\nSCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$SCRIPT_DIR/node" "$SCRIPT_DIR/server.cjs" "$@"\n';
await writeFile(join(directory, 'wechat-reader-companion'), launcher, { mode: 0o755 });
await chmod(join(directory, 'wechat-reader-companion'), 0o755);
/** 附属程序版本可与插件市场版本独立验证 */
const metadata = { engineVersion: 'ts-1', runtimeLanguage: 'typescript', nodeVersion: process.version, platform: process.platform, arch: process.arch };
await writeFile(join(directory, 'engine.json'), JSON.stringify(metadata, null, 2));
/** 完整安装包包含当前构建，保留一期插件 ID */
const packageDirectory = 'dist/wechat-reader';
await rm(packageDirectory, { recursive: true, force: true });
await mkdir(packageDirectory, { recursive: true });
for (const name of ['main.js', 'manifest.json', 'styles.css', 'README.md', 'LICENSE'])
    await copyFile(name, join(packageDirectory, name));
await cp('dist/engine', join(packageDirectory, 'engine'), { recursive: true });
await mkdir(join(packageDirectory, 'licenses'), { recursive: true });
await copyFile('companion/upstream/LICENSE', join(packageDirectory, 'licenses/wechat-mp-tools-MIT.txt'));
await copyFile(join(dirname(dirname(process.execPath)), 'LICENSE'), join(packageDirectory, 'licenses/Node-LICENSE.txt'));
/** 运行包同时附带前端及独立内核所使用依赖的许可证 */
const packages = new Set(['dompurify', 'turndown', ...Object.keys(runtimeBuild.metafile.inputs).map(path => path.match(/node_modules\/([^/]+)/)?.[1]).filter(Boolean)]);
for (const name of packages) {
    // npm 包的不同许可证文件名统一复制到许可证目录。
    for (const candidate of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']) {
        try {
            await copyFile(join('node_modules', name, candidate), join(packageDirectory, 'licenses', `${name}-${candidate}`));
        }
        catch { /* 未提供该文件名时尝试下一候选。 */ }
    }
}
/** 运行源码中不包含 Python，也无需安装 Python */
const version = JSON.parse(await readFile('manifest.json', 'utf8')).version;
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', packageDirectory, `dist/wechat-reader-${version}-macos-arm64.zip`]);
console.log(`TS 完整安装包已生成：${metadata.nodeVersion} / ${metadata.arch}`);
