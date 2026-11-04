/** 固定下载版本与摘要随插件代码审核，不查询 latest 或远程安装脚本。 */
export const ENGINE_PACKAGE = {
    version: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    url: 'https://github.com/Cynthia2023XY/obsidian-wechat-reader/releases/download/1.0.0/wechat-reader-1.0.0-macos-arm64.zip',
    bytes: 47683311,
    sha256: '7173385775fe89f2f3a7db2e3a607c7ace0e95d7e13d3a7b1b4ff4ffd069e666',
} as const;
export function engineSupported(): boolean { return process.platform === ENGINE_PACKAGE.platform && process.arch === ENGINE_PACKAGE.arch; }
