/** 生成不含机器路径、会话标识或通知目标的心跳示例。 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const prompt =
  '【ai-nightowl 开发心跳示例】读取仓库内 docs/blueprint.md、docs/PRD.md 与 ' +
  'docs/progress.json；只推进一个依赖已满足的 pending 子任务；运行类型检查和相关测试；' +
  '如实更新 progress.json。不要发送外部通知，不要直接推送远端，不要把密钥、会话标识或机器路径写入仓库。';

function buildSpec(name: string, cron: string) {
  return {
    id: '',
    name,
    enabled: false,
    schedule: { type: 'cron', cron, timezone: 'Asia/Singapore' },
    task_type: 'agent',
    request: {
      input: [{ role: 'user', type: 'message', content: [{ type: 'text', text: prompt }] }],
    },
    dispatch: {
      type: 'channel',
      channel: 'console',
      target: { user_id: 'default', session_id: '' },
      mode: 'stream',
      silent: false,
      meta: {},
    },
    runtime: {
      share_session: false,
      max_concurrency: 1,
      timeout_seconds: 1800,
      misfire_grace_seconds: 600,
      tool_safety: true,
    },
    meta: { example: true },
  };
}

const docsDir = dirname(fileURLToPath(import.meta.url));
await Promise.all([
  writeFile(
    join(docsDir, 'cron-evening.json'),
    JSON.stringify(buildSpec('ai-nightowl-heartbeat-evening-example', '*/20 18-23 * * *'), null, 2) + '\n',
  ),
  writeFile(
    join(docsDir, 'cron-night.json'),
    JSON.stringify(buildSpec('ai-nightowl-heartbeat-night-example', '*/20 0-8 * * *'), null, 2) + '\n',
  ),
]);
