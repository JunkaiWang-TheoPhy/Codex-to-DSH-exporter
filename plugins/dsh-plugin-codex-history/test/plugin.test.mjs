/**
 * Plugin tests.
 *
 * The plugin is exercised through a capturing stand-in for `ctx.tools`, so
 * these tests check what the tools actually return rather than only that the
 * module compiles. The harness itself is not loaded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, inject, name } from '../dist/index.js';

/** Build a context that records registrations and exposes them by tool name. */
function captureContext() {
  const tools = new Map();
  return {
    tools,
    ctx: {
      tools: {
        register(definition) {
          tools.set(definition.name, definition);
          return () => tools.delete(definition.name);
        },
      },
    },
  };
}

/** Write a minimal harness home containing an index the plugin can read. */
function makeHome({ rollouts = [], sessions = [], codexHome = '/home/u/.codex' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'codex-history-plugin-'));
  mkdirSync(join(home, 'codex-to-dsh'), { recursive: true });

  if (rollouts.length > 0) {
    writeFileSync(join(home, 'codex-to-dsh', 'rollout-index.json'), JSON.stringify({
      version: 1,
      codexHome,
      builtAt: Date.now(),
      entries: rollouts,
    }));
  }
  if (sessions.length > 0) {
    writeFileSync(join(home, 'codex-to-dsh', 'index.json'), JSON.stringify({
      version: 1,
      sessions: Object.fromEntries(sessions.map((session) => [
        `${session.projectKey}/${session.sessionId}`,
        { ...session, title: undefined, parentSession: undefined, agentPreset: undefined },
      ])),
    }));
  }
  return home;
}

const signal = AbortSignal.timeout(5000);

test('declares the tools service and a plugin name', () => {
  assert.equal(name, 'codex-history');
  assert.deepEqual([...inject], ['tools']);
});

test('registers three read-only tools with valid presentations', () => {
  const { ctx, tools } = captureContext();
  apply(ctx, { dshHome: '/tmp/unused' });

  assert.deepEqual([...tools.keys()].sort(), [
    'codex_history_locate',
    'codex_history_search',
    'dsh_session_list',
  ]);

  for (const [toolName, definition] of tools) {
    assert.ok(definition.description.length > 20, `${toolName} has a usable description`);
    assert.ok(definition.output?.schema, `${toolName} declares an output schema`);
    assert.equal(typeof definition.output.render, 'function', `${toolName} declares a renderer`);
    const presentation = definition.presentCall?.({}) ?? { kind: 'other' };
    assert.ok(
      ['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'other'].includes(presentation.kind),
      `${toolName} uses a valid call kind`,
    );
  }
});

test('search renders matches and reports the searched total', async () => {
  const home = makeHome({
    rollouts: [
      { id: 'aaaa-1111', path: '/c/a.jsonl', cwd: '/home/u/work/quantum', createdAt: Date.now() - 86_400_000, title: 'Explain gauge theory.', bytes: 2048, layout: 'dated' },
      { id: 'bbbb-2222', path: '/c/b.jsonl', cwd: '/home/u/work/other', createdAt: Date.now(), title: 'Fix the parser.', bytes: 4096, layout: 'archived' },
    ],
  });
  const { ctx, tools } = captureContext();
  apply(ctx, { dshHome: home, codexHome: '/home/u/.codex' });

  const search = tools.get('codex_history_search');
  const hit = await search.execute({ query: 'gauge' }, { signal });
  assert.match(hit, /Explain gauge theory\./);
  assert.match(hit, /quantum/);
  assert.match(hit, /aaaa-1111/);
  assert.ok(!hit.includes('Fix the parser'), 'non-matching sessions are excluded');

  const miss = await search.execute({ query: 'nothing-matches' }, { signal });
  assert.match(miss, /No Codex sessions match/);
  assert.match(miss, /searched 2/, 'the miss reports how many were searched');

  await rm(home, { recursive: true, force: true });
});

test('a missing index produces a runnable instruction, not a crash', async () => {
  const home = makeHome();
  const { ctx, tools } = captureContext();
  apply(ctx, { dshHome: home });

  const result = await tools.get('codex_history_search').execute({ query: 'anything' }, { signal });
  assert.match(result, /No Codex history index/);
  assert.match(result, /codex-to-dsh index build/, 'the message says how to fix it');

  await rm(home, { recursive: true, force: true });
});

test('locate resolves a unique id and refuses an ambiguous prefix', async () => {
  const home = makeHome({
    rollouts: [
      { id: 'aaaa-1111', path: '/c/a.jsonl', cwd: '/w/a', createdAt: Date.now(), title: 'A', bytes: 10, layout: 'dated' },
      { id: 'aaaa-2222', path: '/c/b.jsonl', cwd: '/w/b', createdAt: Date.now(), title: 'B', bytes: 10, layout: 'dated' },
    ],
  });
  const { ctx, tools } = captureContext();
  apply(ctx, { dshHome: home });
  const locate = tools.get('codex_history_locate');

  const exact = await locate.execute({ id: 'aaaa-1111' }, { signal });
  assert.match(exact, /\/c\/a\.jsonl/, 'an exact id resolves to the rollout path');

  const ambiguous = await locate.execute({ id: 'aaaa' }, { signal });
  assert.match(ambiguous, /ambiguous/);
  assert.match(ambiguous, /aaaa-1111/);
  assert.match(ambiguous, /aaaa-2222/);

  const unknown = await locate.execute({ id: 'zzzz' }, { signal });
  assert.match(unknown, /No Codex session matches/);

  await rm(home, { recursive: true, force: true });
});

test('session listing groups by workspace and filters', async () => {
  const now = Date.now();
  const home = makeHome({
    sessions: [
      { sessionId: 'session-1', projectKey: '--w-a--', cwd: '/w/alpha', createdAt: now, bytes: 1024, formatVersion: 3 },
      { sessionId: 'session-2', projectKey: '--w-a--', cwd: '/w/alpha', createdAt: now - 1000, bytes: 2048, formatVersion: 3 },
      { sessionId: 'session-3', projectKey: '--w-b--', cwd: '/w/beta', createdAt: now - 2000, bytes: 512, formatVersion: 0 },
    ],
  });
  const { ctx, tools } = captureContext();
  apply(ctx, { dshHome: home });
  const list = tools.get('dsh_session_list');

  const all = await list.execute({}, { signal });
  assert.match(all, /3 sessions in 2 workspaces/);
  assert.match(all, /\/w\/alpha/);
  assert.match(all, /format v0/, 'a stored generation other than the current one is reported as such');

  const filtered = await list.execute({ workspace: 'beta' }, { signal });
  assert.match(filtered, /1 sessions? in 1 workspaces/);
  assert.ok(!filtered.includes('/w/alpha'));

  await rm(home, { recursive: true, force: true });
});

test('an aborted call refuses to run', async () => {
  const home = makeHome();
  const { ctx, tools } = captureContext();
  apply(ctx, { dshHome: home });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => tools.get('codex_history_search').execute({ query: 'x' }, { signal: controller.signal }),
    /abort/i,
  );

  await rm(home, { recursive: true, force: true });
});

test('a stale index from another Codex home is reported rather than trusted', async () => {
  // An index built against a different home yields plausible results pointing
  // at rollout files that do not exist, which is worse than an empty result.
  // The index describes one home; the plugin is configured for another.
  const home = makeHome({
    codexHome: '/home/u/.codex.archive',
    rollouts: [
      { id: 'aaaa-1111', path: '/elsewhere/a.jsonl', cwd: '/w/a', createdAt: Date.now(), title: 'From another home', bytes: 10, layout: 'dated' },
    ],
  });
  const { ctx, tools } = captureContext();
  apply(ctx, { dshHome: home, codexHome: '/home/u/.codex' });

  const result = await tools.get('codex_history_search').execute({ query: 'another' }, { signal });
  assert.match(result, /Warning: this index describes \/home\/u\/\.codex\.archive/, 'the mismatch is named');
  assert.match(result, /configured for \/home\/u\/\.codex/);
  assert.match(result, /codex-to-dsh index build --codex-home/, 'the message says how to fix it');
  assert.match(result, /From another home/, 'and the results are still returned');

  // With the configuration matching the index, no warning appears.
  const matching = captureContext();
  apply(matching.ctx, { dshHome: home, codexHome: '/home/u/.codex.archive' });
  const quiet = await matching.tools.get('codex_history_search').execute({ query: 'another' }, { signal });
  assert.ok(!quiet.includes('Warning'), 'a matching configuration is silent');
  assert.match(quiet, /From another home/, 'and still returns results');

  await rm(home, { recursive: true, force: true });
});
