import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ENGINE_PACKAGE } from './engine-package';
/** 安装指针仅能指向插件目录下由安装器创建的版本目录。 */
export async function managedEngineDirectory(directory: string): Promise<string | undefined> {
    try {
        const pointer = JSON.parse(await readFile(join(directory, 'wechat-engine.json'), 'utf8')) as { folder?: string; sha256?: string };
        if (pointer.sha256 === ENGINE_PACKAGE.sha256 && /^wechat-engine-[a-f0-9-]{36}$/.test(pointer.folder || '')) return join(directory, pointer.folder!);
    } catch { /* 未安装或损坏指针不允许跳出插件目录。 */ }
}
export async function engineExecutable(directory: string): Promise<string> {
    const managed = await managedEngineDirectory(directory);
    return managed ? join(managed, 'engine', 'wechat-reader-companion') : join(directory, 'engine', 'wechat-reader-companion', 'wechat-reader-companion');
}
