import { readFile, mkdir, copyFile, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
/** 本次专用测试笔记库，禁止写入正式雅思库 */
const vault = process.env.WECHAT_READER_TEST_VAULT || '/Users/dingxinyi.2/Documents/practice/obsidian测试笔记库/新功能测试仓库';
/** 插件身份以构建清单为准 */
const manifest = JSON.parse(await readFile('manifest.json','utf8'));
/** 仅覆盖运行产物，保留既有设置和笔记 */
const target = join(vault,'.obsidian/plugins',manifest.id);
await mkdir(target,{recursive:true});
for (const name of ['main.js','manifest.json','styles.css','README.md']) {
  // 复制后验证哈希，避免把旧构建当作新部署。
  await copyFile(name,join(target,name));
  if (createHash('sha256').update(await readFile(name)).digest('hex') !== createHash('sha256').update(await readFile(join(target,name))).digest('hex')) throw new Error(`部署文件不一致：${name}`);
}
/** 只有内核产物变化时才替换，普通 UI 重载复用健康的共享实例 */
const binaries=['wechat-reader-companion','node','server.cjs','engine.json'];
/** 对所有关键内核文件核验，避免误用旧运行目录 */
let sameEngine=true;
for(const name of binaries){
  // 缺失或不同的任何文件均要求完整替换内核目录。
  const binary=join('wechat-reader-companion',name);
  try{if(createHash('sha256').update(await readFile(join('dist/engine',binary))).digest('hex')!==createHash('sha256').update(await readFile(join(target,'engine',binary))).digest('hex'))sameEngine=false;}catch{sameEngine=false;}
}
if(!sameEngine){
  // 内核升级前应正常停止旧实例，不与旧程序同时操作共享数据。
  await rm(join(target,'engine'),{recursive:true,force:true});
  await cp('dist/engine',join(target,'engine'),{recursive:true});
}
for(const name of binaries){
  // 每个关键运行产物均核验哈希。
  const binary=join('wechat-reader-companion',name);
if (createHash('sha256').update(await readFile(join('dist/engine',binary))).digest('hex') !== createHash('sha256').update(await readFile(join(target,'engine',binary))).digest('hex')) throw new Error('附属程序部署哈希不一致');
}
await cp('dist/wechat-reader/licenses',join(target,'licenses'),{recursive:true});
console.log(`已部署并核对产物：${target}`);
