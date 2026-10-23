import { readFile, mkdir, copyFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
/** 本次专用测试笔记库，禁止写入正式雅思库 */
const vault = '/Users/dingxinyi.2/Documents/practice/obsidian测试笔记库/新功能测试仓库';
/** 插件身份以构建清单为准 */
const manifest = JSON.parse(await readFile('manifest.json','utf8'));
/** 仅覆盖运行产物，保留既有设置和笔记 */
const target = join(vault,'.obsidian/plugins',manifest.id);
await mkdir(target,{recursive:true});
for (const name of ['main.js','manifest.json','styles.css']) {
  // 复制后验证哈希，避免把旧构建当作新部署。
  await copyFile(name,join(target,name));
  if (createHash('sha256').update(await readFile(name)).digest('hex') !== createHash('sha256').update(await readFile(join(target,name))).digest('hex')) throw new Error(`部署文件不一致：${name}`);
}
await cp('dist/engine',join(target,'engine'),{recursive:true});
/** 核验随包可执行程序内容 */
const binary = 'wechat-reader-companion/wechat-reader-companion';
if (createHash('sha256').update(await readFile(join('dist/engine',binary))).digest('hex') !== createHash('sha256').update(await readFile(join(target,'engine',binary))).digest('hex')) throw new Error('附属程序部署哈希不一致');
console.log(`已部署并核对产物：${target}`);
