import { get } from 'node:https';
import { ENGINE_PACKAGE } from './engine-package';
/** 仅访问固定发行地址和 GitHub 发行附件的 HTTPS 重定向。 */
export async function downloadEngine(signal: AbortSignal, progress: (received: number) => void): Promise<Uint8Array> {
    const visit = (address: string, redirects: number): Promise<Uint8Array> => new Promise((resolve, reject) => {
        const url = new URL(address);
        if (signal.aborted) { reject(new Error('安装已取消')); return; }
        if (redirects > 5 || url.protocol !== 'https:' || url.username || url.password || url.port || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) {
            reject(new Error('下载地址或重定向不受信任')); return;
        }
        const request = get(url, { signal, headers: { 'User-Agent': 'WeChat-Reader-Engine-Installer', Accept: 'application/octet-stream' } }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
                response.resume();
                void visit(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) { response.resume(); reject(new Error(`下载失败（HTTP ${response.statusCode || 0}），请稍后重试`)); return; }
            if (Number(response.headers['content-length'] || 0) > ENGINE_PACKAGE.bytes) { response.destroy(); reject(new Error('下载文件超过预期大小')); return; }
            let size = 0;
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > ENGINE_PACKAGE.bytes) { response.destroy(new Error('下载文件超过预期大小')); return; }
                chunks.push(chunk); progress(size);
            });
            response.on('error', reject);
            response.on('end', () => size === ENGINE_PACKAGE.bytes ? resolve(Buffer.concat(chunks)) : reject(new Error('下载不完整，请重试')));
        });
        request.setTimeout(30000, () => request.destroy(new Error('下载超时，请检查网络后重试')));
        request.on('error', reject);
    });
    return visit(ENGINE_PACKAGE.url, 0);
}
