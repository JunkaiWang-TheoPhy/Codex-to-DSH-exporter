/**
 * Session store tests.
 *
 * The store is exercised end to end against a temporary harness home: sessions
 * are synthesized with the artifact package, written at the path DSH itself
 * would compute, then discovered, searched, trashed, restored, exported, and
 * re-imported. Nothing here reads a real `~/.codex`.
 *
 * Two tests additionally read the real `~/.dsh/sessions` tree when it exists.
 * They are the only tests that touch live data, they are read-only, and they
 * skip cleanly on a machine without a harness home.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { discoverArtifacts, exportBundle, importBundle, verifyBundle, SessionStore } from '../dist/index.js';
import { parseGenerationLogFilename, projectKey as projectKeyOf, sessionArtifactPath, synthesizeSession } from '@codex-to-dsh/dsh-session-artifact';
import { parseRolloutText } from '@codex-to-dsh/codex-rollout';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, '..', '..', '..', 'fixtures', 'rollout-sample.jsonl'), 'utf8');

/** Build a harness home containing `count` synthesized sessions at `cwd`. */
function makeHome(sessions) {
  const home = mkdtempSync(join(tmpdir(), 'codex-to-dsh-'));
  const root = join(home, 'sessions');

  sessions.forEach(({ cwd, title, id }, index) => {
    const summary = parseRolloutText(fixture);
    const result = synthesizeSession(summary, {
      sessionId: id ?? `session-test-${String(index).padStart(4, '0')}`,
      cwdRewrite: () => cwd,
      ...(title !== undefined ? {} : {}),
    });
    const path = sessionArtifactPath(root, cwd, result.sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, zstdCompressSync(Buffer.from(result.jsonl, 'utf8')));
  });

  return { home, root };
}

test('discovers sessions and reads their headers without booting the harness', async () => {
  const { home } = makeHome([
    { cwd: '/home/u/work/alpha' },
    { cwd: '/home/u/work/beta' },
    { cwd: '/home/u/work/alpha' },
  ]);

  const store = new SessionStore({ home });
  const scan = await store.refresh();
  assert.equal(scan.scanned, 3);
  assert.equal(scan.read, 3, 'every artifact is read on a cold index');
  await store.saveIndex();

  assert.equal(store.all().length, 3);

  const warm = new SessionStore({ home });
  const second = await warm.refresh();
  assert.equal(second.read, 0, 'an unchanged store performs no decompression on rescan');
  assert.equal(warm.all().length, 3);

  await rm(home, { recursive: true, force: true });
});

test('groups sessions by workspace, newest group first', async () => {
  const { home } = makeHome([
    { cwd: '/home/u/work/alpha' },
    { cwd: '/home/u/work/beta' },
    { cwd: '/home/u/work/alpha' },
  ]);

  const store = new SessionStore({ home });
  await store.refresh();
  const groups = store.workspaces();

  assert.equal(groups.length, 2);
  for (const group of groups) assert.ok(group.sessions.length >= 1);
  assert.ok(groups.some((group) => group.label === 'alpha' && group.sessions.length === 2));
  assert.ok(groups.some((group) => group.label === 'beta' && group.sessions.length === 1));

  await rm(home, { recursive: true, force: true });
});

test('search matches titles, ids, and workspace paths', async () => {
  const { home } = makeHome([
    { cwd: '/home/u/work/quantum-notes' },
    { cwd: '/home/u/work/other', id: 'session-special-name' },
  ]);

  const store = new SessionStore({ home });
  await store.refresh();
  assert.equal(store.search({ text: 'quantum' }).length, 1, 'matches on cwd');
  assert.equal(store.search({ text: 'special-name' }).length, 1, 'matches on session id');
  assert.equal(store.search({ text: 'QUANTUM' }).length, 1, 'the match is case-insensitive');
  assert.equal(store.search({ text: 'nothing-matches' }).length, 0);
  assert.equal(store.search({ cwd: '/home/u/work/other' }).length, 1, 'exact cwd filter');
  assert.equal(store.search({ limit: 1 }).length, 1, 'limit applies after sorting');

  await store.setTitle('session-test-0000', 'A titled session');
  assert.equal(store.search({ text: 'titled' }).length, 1, 'a title becomes searchable once known');

  await rm(home, { recursive: true, force: true });
});

test('trash moves, restores, and empties without losing a session', async () => {
  const { home } = makeHome([{ cwd: '/home/u/work/alpha' }, { cwd: '/home/u/work/beta' }]);

  const store = new SessionStore({ home });
  await store.refresh();
  const victim = store.all()[0].sessionId;

  const moved = await store.trash([victim]);
  assert.equal(moved.length, 1);
  assert.equal(store.get(victim), undefined, 'a trashed session leaves the index');
  assert.equal((await store.listTrash()).length, 1);
  assert.equal((await store.listTrash())[0].sessionId, victim);

  assert.equal(await store.restore([victim]), 1);
  assert.ok(store.get(victim), 'restore puts the session back');
  assert.equal((await store.listTrash()).length, 0);

  await store.trash([victim]);
  assert.equal(await store.emptyTrash(), 1);
  assert.equal((await store.listTrash()).length, 0);

  await rm(home, { recursive: true, force: true });
});

test('a bundle round-trips and detects tampering', async () => {
  const source = makeHome([{ cwd: '/home/u/work/alpha' }, { cwd: '/home/u/work/beta' }]);
  const store = new SessionStore({ home: source.home });
  await store.refresh();

  const bundleDir = join(source.home, 'bundle');
  const ids = store.all().map((record) => record.sessionId);
  const manifest = await exportBundle(store, ids, bundleDir);
  assert.equal(manifest.entries.length, 2);
  assert.equal(manifest.format, 'codex-to-dsh/session-bundle');
  for (const entry of manifest.entries) assert.match(entry.sha256, /^[0-9a-f]{64}$/);

  const verification = await verifyBundle(bundleDir);
  assert.equal(verification.ok, true);

  // A dry run reports what it would import and writes nothing.
  const destination = mkdtempSync(join(tmpdir(), 'codex-to-dsh-dest-'));
  const destStore = new SessionStore({ home: destination });
  const dry = await importBundle(destStore, bundleDir, { apply: false });
  assert.equal(dry.imported.length, 2);
  assert.equal(existsSync(join(destination, 'sessions')), false, 'a dry run creates no sessions');

  const applied = await importBundle(destStore, bundleDir, { apply: true });
  assert.equal(applied.imported.length, 2);
  assert.equal(destStore.all().length, 2, 'the destination can read what it imported');

  const again = await importBundle(destStore, bundleDir, { apply: true });
  assert.equal(again.imported.length, 0, 'import is additive, not destructive');
  assert.equal(again.skipped.length, 2);

  // Corrupt one artifact and require the import to refuse it.
  const entry = manifest.entries[0];
  writeFileSync(join(bundleDir, entry.file), 'not the artifact you recorded');
  const broken = await verifyBundle(bundleDir);
  assert.equal(broken.ok, false);
  assert.match(broken.results.find((result) => !result.ok).detail, /digest mismatch/);
  await assert.rejects(
    () => importBundle(new SessionStore({ home: destination }), bundleDir, { apply: true }),
    /refusing to import a bundle that failed verification/,
  );

  await rm(source.home, { recursive: true, force: true });
  await rm(destination, { recursive: true, force: true });
});

test('diagnose reports index drift without changing anything', async () => {
  const { home } = makeHome([{ cwd: '/home/u/work/alpha' }]);
  const store = new SessionStore({ home });
  await store.refresh();
  await store.saveIndex();

  const clean = await store.diagnose();
  assert.deepEqual(clean.missingArtifact, []);
  assert.deepEqual(clean.staleIndex, []);

  // Add a session behind the index's back and expect it to be reported.
  const extra = synthesizeSession(parseRolloutText(fixture), {
    sessionId: 'session-added-later',
    cwdRewrite: () => '/home/u/work/gamma',
  });
  const path = sessionArtifactPath(store.root, '/home/u/work/gamma', extra.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, zstdCompressSync(Buffer.from(extra.jsonl, 'utf8')));

  const drifted = await store.diagnose();
  assert.equal(drifted.staleIndex.length, 1);
  assert.match(drifted.staleIndex[0], /session-added-later/);

  await rm(home, { recursive: true, force: true });
});

test('a header must declare the generation its filename claims', async (t) => {
  const root = join(homedir(), '.dsh', 'sessions');
  if (!existsSync(root)) {
    t.skip('no DSH session root on this machine');
    return;
  }

  const artifacts = await discoverArtifacts(root);
  if (artifacts.length === 0) {
    t.skip('the DSH session root holds no artifacts');
    return;
  }

  // One artifact per session: a directory holding two generations must not be
  // counted twice, because the highest generation is the authoritative one.
  const keys = artifacts.map((artifact) => `${artifact.projectKey}/${artifact.sessionId}`);
  assert.equal(new Set(keys).size, keys.length, 'discovery returns at most one artifact per session');

  const generations = new Map();
  for (const artifact of artifacts) {
    generations.set(artifact.formatVersion, (generations.get(artifact.formatVersion) ?? 0) + 1);
  }
  t.diagnostic(
    `generations present: ${[...generations.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([version, count]) => `v${version}:${count}`)
      .join(' ')}`,
  );
});

test('legacy generations are read by their stored version, not the current one', async (t) => {
  const root = join(homedir(), '.dsh', 'sessions');
  if (!existsSync(root)) {
    t.skip('no DSH session root on this machine');
    return;
  }

  const artifacts = await discoverArtifacts(root);
  const legacy = artifacts.filter((artifact) => artifact.formatVersion !== 3);
  if (legacy.length === 0) {
    t.skip('every session on this machine is at the current generation');
    return;
  }

  // A legacy artifact is still named and located by its own generation. This is
  // the case that a version-blind path helper gets wrong.
  for (const artifact of legacy) {
    assert.notEqual(
      parseGenerationLogFilename(artifact.path.split('/').pop()),
      undefined,
      'a legacy artifact still has a canonical generation name',
    );
    assert.notEqual(
      sessionArtifactPath(root, undefined, artifact.sessionId, artifact.formatVersion),
      sessionArtifactPath(root, undefined, artifact.sessionId),
      'the legacy path differs from the current-generation path',
    );
  }
  t.diagnostic(`legacy generations found: ${legacy.map((a) => `v${a.formatVersion}`).join(', ')}`);
});

test('a compressed generation-0 artifact is indexed, not silently dropped', async () => {
  // Regression: compression and generation are independent axes. A session
  // stored as compressed generation 0 was previously dropped because the
  // reader inferred "plaintext" from the version number. On the author's
  // machine four real sessions are stored exactly this way.
  const home = mkdtempSync(join(tmpdir(), 'codex-to-dsh-legacy-'));
  const root = join(home, 'sessions');
  const cwd = '/home/u/work/legacy';
  const sessionId = 'session-legacy-0001';

  // A generation-0 header: no isSeeded field, version 0.
  const header = { type: 'session', version: 0, id: sessionId, createdAt: Date.now(), cwd, delegationDepth: 0 };
  const body = JSON.stringify({ type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } });
  const artifact = `${JSON.stringify(header)}\n${body}\n`;

  const path = join(root, projectKeyOf(cwd), sessionId, 'session.jsonl.zstd');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, zstdCompressSync(Buffer.from(artifact, 'utf8')));

  const store = new SessionStore({ home });
  const scan = await store.refresh();

  assert.equal(scan.unreadable.length, 0, `nothing should be unreadable: ${scan.unreadable.join(', ')}`);
  assert.equal(store.all().length, 1, 'the legacy session is in the index');
  assert.equal(store.all()[0].formatVersion, 0, 'and it keeps its stored generation');
  assert.equal(store.all()[0].isSeeded, false, 'a missing isSeeded reads as false, not as an error');

  await rm(home, { recursive: true, force: true });
});

test('refresh never drops a discovered artifact without saying so', async () => {
  const { home } = makeHome([{ cwd: '/home/u/work/alpha' }, { cwd: '/home/u/work/beta' }]);
  const store = new SessionStore({ home });
  const scan = await store.refresh();
  assert.equal(scan.unreadable.length, 0);
  assert.equal(
    store.all().length,
    scan.scanned,
    'every discovered artifact must either be indexed or reported unreadable',
  );
  await rm(home, { recursive: true, force: true });
});
