import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store, StoreReadError } from '../src/index.js';
import { blueprint } from './helpers.js';

test('Store 原子保存且不遗留临时文件', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  await store.save({
    schemaVersion: 2,
    blueprint: blueprint(),
    checkpoints: [],
    rollingSummaries: [],
    updatedAt: '',
    completion: { status: 'pending' },
  });
  const parsed = JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'));
  assert.equal(parsed.blueprint.id, 'test-blueprint');
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
});

test('损坏状态显式抛 StoreReadError，不伪装成空态', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-corrupt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'state.json'), '{broken', 'utf-8');
  await assert.rejects(() => new Store(dir).load(), StoreReadError);
});

test('旧状态迁移后会重新执行 acceptance/DoD，而不是沿用假完成', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacy = blueprint({ acceptance: ['需要重新验收'], definitionOfDone: '整体重新验收' });
  legacy.milestones[0].subtasks[0].status = 'done';
  legacy.milestones[0].status = 'done';
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    blueprint: legacy,
    checkpoints: [{ milestoneId: 'm1', summary: '旧状态声称已经完成', at: '2026-08-20T00:00:00.000Z' }],
    rollingSummaries: [],
    updatedAt: '2026-08-20T00:00:00.000Z',
  }), 'utf-8');

  const state = await new Store(dir).load();
  assert.equal(state?.schemaVersion, 2);
  assert.equal(state?.blueprint.milestones[0].status, 'pending');
  assert.equal(state?.completion.status, 'pending');
  assert.deepEqual(state?.checkpoints, []);
});
