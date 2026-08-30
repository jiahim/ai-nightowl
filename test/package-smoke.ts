import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'nightowl-package-'));
const consumer = join(temp, 'consumer');

try {
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n', 'utf-8');
  const environment = { ...process.env, npm_config_cache: join(temp, 'npm-cache') };
  const packed = await execFile('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', temp,
  ], { cwd: root, env: environment, maxBuffer: 10 * 1024 * 1024 });
  const metadata = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  const tarball = join(temp, metadata[0].filename);

  await execFile('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball,
  ], { cwd: consumer, env: environment, maxBuffer: 10 * 1024 * 1024 });

  const packageDir = join(consumer, 'node_modules', 'ai-nightowl');
  await Promise.all([
    access(join(packageDir, 'docs', 'blueprint.md')),
    access(join(packageDir, 'docs', 'PRD.md')),
    access(join(packageDir, 'docs', 'plugin-development.md')),
  ]);
  const exportsModule = await import(pathToFileURL(join(packageDir, 'dist', 'index.js')).href);
  assert.equal(typeof exportsModule.NightOwlLoop, 'function');

  const binDir = join(consumer, 'node_modules', '.bin');
  const cli = await execFile(join(binDir, 'ai-nightowl'), ['help'], { cwd: consumer });
  assert.match(cli.stdout, /ai-nightowl/);

  const mcp = await runWithInput(join(binDir, 'ai-nightowl-mcp'), [], JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
  }) + '\n', consumer);
  assert.equal(mcp.code, 0);
  assert.equal(JSON.parse(mcp.stdout.trim()).result.serverInfo.name, 'ai-nightowl');

  // 子进程监听在部分受限构建沙箱会被 EPERM 拒绝；用明确不安全的 host
  // 验证 serve bin 的主入口与 loopback 防线，真实监听由 integration test 覆盖。
  const serve = await runWithInput(join(binDir, 'ai-nightowl-serve'), [
    '--dir', join(temp, 'runtime'), '--host', '0.0.0.0', '--port', '0',
  ], '', consumer);
  assert.equal(serve.code, 1);
  assert.match(serve.stderr, /只允许 loopback/);

  console.log('packed exports、文档与三个 bin 均可从临时安装目录使用');
} finally {
  await rm(temp, { recursive: true, force: true });
}

async function runWithInput(
  command: string,
  args: string[],
  input: string,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf-8');
  child.stderr?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  child.stdin?.end(input);
  const [code] = await once(child, 'close') as [number | null];
  return { code, stdout, stderr };
}
