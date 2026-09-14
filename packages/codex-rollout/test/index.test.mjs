/**
 * Codex history index tests.
 *
 * The index is built from a bounded head of each rollout rather than the whole
 * file, so these tests pin two properties that a naive implementation gets
 * wrong: the bounded read must not be confused with the full parse, and the
 * title must be the person's prompt rather than the context Codex injects
 * ahead of it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRolloutIndex, listRollouts, parseRolloutHead, searchIndex, totalBytes } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, '..', '..', '..', 'fixtures', 'rollout-sample.jsonl'), 'utf8');

/** Build a Codex home with the date-partitioned layout. */
function makeCodexHome(rollouts) {
  const home = mkdtempSync(join(tmpdir(), 'codex-to-dsh-codex-'));
  rollouts.forEach(({ name, body, dir }) => {
    const target = join(home, dir ?? join('sessions', '2026', '01', '02'), name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  });
  return home;
}

const rolloutNamed = (id, cwd, firstUserText, extraLines = []) => [
  JSON.stringify({
    timestamp: '2026-01-02T03:04:05.000Z',
    type: 'session_meta',
    payload: { id, timestamp: '2026-01-02T03:04:05.000Z', cwd, originator: 'codex_cli_rs', cli_version: '0.0.0-test' },
  }),
  ...extraLines,
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: firstUserText }] } }),
].join('\n');

test('finds rollouts in both layouts', async () => {
  const home = makeCodexHome([
    { name: 'rollout-2026-01-02T03-04-05-aaa.jsonl', body: fixture },
    { name: 'rollout-2026-01-03T03-04-05-bbb.jsonl', body: fixture, dir: 'archived_sessions' },
  ]);

  const files = await listRollouts(home);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((file) => file.layout).sort(), ['archived', 'dated']);
  assert.ok(files.every((file) => file.bytes > 0));

  await rm(home, { recursive: true, force: true });
});

test('ignores files that are not rollouts', async () => {
  const home = makeCodexHome([
    { name: 'rollout-2026-01-02T03-04-05-aaa.jsonl', body: fixture },
    { name: 'session_index.jsonl', body: '{}\n' },
    { name: 'notes.txt', body: 'not a rollout' },
  ]);

  const files = await listRollouts(home);
  assert.equal(files.length, 1, 'only rollout-*.jsonl is indexed');

  await rm(home, { recursive: true, force: true });
});

test('the bounded head read stops early on a large rollout', async () => {
  const home = makeCodexHome([{ name: 'rollout-big.jsonl', body: fixture }]);
  const path = join(home, 'sessions', '2026', '01', '02', 'rollout-big.jsonl');
  // Append far more lines than the line ceiling.
  writeFileSync(path, `${fixture}\n${Array.from({ length: 5000 }, (_, i) =>
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { n: i } } })).join('\n')}\n`);

  const head = await parseRolloutHead(path, { maxLines: 50 });
  assert.equal(head.truncated, true, 'the read reports that it stopped early');
  assert.ok(head.entries.length <= 60, `bounded to ~50 lines, read ${head.entries.length}`);
  assert.ok(head.meta, 'the header is inside the prefix');

  await rm(home, { recursive: true, force: true });
});

test('the title is the prompt, not the context Codex injects ahead of it', async () => {
  const injected = [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context> <current_date>2026-01-02</current_date> </environment_context>' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins> Here is a list of plugins that are available but not installed.' }] } }),
  ];
  const home = makeCodexHome([
    { name: 'rollout-2026-01-02T03-04-05-aaa.jsonl', body: rolloutNamed('aaa', '/home/u/work/alpha', 'Explain the Fourier transform.', injected) },
  ]);

  const { index } = await buildRolloutIndex(home);
  assert.equal(index.entries.length, 1);
  assert.equal(
    index.entries[0].title,
    'Explain the Fourier transform.',
    'injected context must not become the title',
  );

  await rm(home, { recursive: true, force: true });
});

test('an index is incremental against unchanged rollouts', async () => {
  const home = makeCodexHome([
    { name: 'rollout-2026-01-02T03-04-05-aaa.jsonl', body: fixture },
    { name: 'rollout-2026-01-03T03-04-05-bbb.jsonl', body: fixture },
  ]);

  const cold = await buildRolloutIndex(home);
  assert.equal(cold.read, 2);
  assert.equal(cold.reused, 0);

  const warm = await buildRolloutIndex(home, { previous: cold.index });
  assert.equal(warm.read, 0, 'an unchanged home is not re-read');
  assert.equal(warm.reused, 2);
  assert.deepEqual(warm.index.entries.map((entry) => entry.id), cold.index.entries.map((entry) => entry.id));

  // Touching one file invalidates only that entry. Use the path the index
  // recorded rather than assuming which directory the fixture landed in.
  const touched = cold.index.entries.find((entry) => entry.path.endsWith('bbb.jsonl')).path;
  writeFileSync(touched, `${fixture}\n${'\n'}`);
  const partial = await buildRolloutIndex(home, { previous: cold.index });
  assert.equal(partial.read, 1);
  assert.equal(partial.reused, 1);

  await rm(home, { recursive: true, force: true });
});

test('search covers title, workspace, and id, newest first', async () => {
  const home = makeCodexHome([
    { name: 'rollout-a.jsonl', body: rolloutNamed('aaaa-1111', '/home/u/work/quantum', 'Explain gauge theory.') },
    { name: 'rollout-b.jsonl', body: rolloutNamed('bbbb-2222', '/home/u/work/other', 'Fix the parser.') },
  ]);

  const { index } = await buildRolloutIndex(home);
  assert.equal(searchIndex(index, 'gauge').length, 1, 'matches on title');
  assert.equal(searchIndex(index, 'quantum').length, 1, 'matches on workspace');
  assert.equal(searchIndex(index, 'bbbb').length, 1, 'matches on id');
  assert.equal(searchIndex(index, 'nothing').length, 0);
  assert.equal(searchIndex(index, '').length, 2, 'an empty query returns the newest entries');
  assert.equal(searchIndex(index, '', 1).length, 1, 'the limit is respected');
  assert.ok(totalBytes(index) > 0);

  await rm(home, { recursive: true, force: true });
});

test('a rollout with no readable prompt still gets an entry', async () => {
  const headerOnly = JSON.stringify({
    timestamp: '2026-01-02T03:04:05.000Z',
    type: 'session_meta',
    payload: { id: 'cccc-3333', timestamp: '2026-01-02T03:04:05.000Z', cwd: '/home/u/work/empty' },
  });
  const home = makeCodexHome([{ name: 'rollout-c.jsonl', body: `${headerOnly}\n` }]);

  const { index } = await buildRolloutIndex(home);
  assert.equal(index.entries.length, 1);
  assert.equal(index.entries[0].id, 'cccc-3333');
  assert.equal(index.entries[0].title, undefined, 'a missing prompt is not invented');

  await rm(home, { recursive: true, force: true });
});
