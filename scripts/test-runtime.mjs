import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
/** 集成测试只加载临时编译产物，不启动真实用户采集实例 */
const directory = await mkdtemp(join(tmpdir(), 'wechat-ts-test-'));
try {
    await build({ stdin: { contents: "export * from './runtime-ts/core';export * from './runtime-ts/auth';export * from './runtime-ts/collector';export * from './runtime-ts/jobs';export * from './runtime-ts/server';export * from './runtime-ts/signature';", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(directory, 'runtime.cjs'), bundle: true, platform: 'node', target: 'node26', format: 'cjs', external: ['playwright-core'] });
    execFileSync(process.execPath, ['--test', 'tests/runtime-integration.test.cjs'], { stdio: 'inherit', env: { ...process.env, TEST_RUNTIME_BUNDLE: join(directory, 'runtime.cjs') } });
}
finally {
    await rm(directory, { recursive: true, force: true });
}
