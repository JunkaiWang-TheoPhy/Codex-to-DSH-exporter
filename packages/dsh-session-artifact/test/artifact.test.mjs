/**
 * Path derivation and artifact synthesis tests.
 *
 * The path tests matter more than they look. DSH recomputes the expected
 * artifact path from a session's own header and rejects the file when the two
 * disagree, so a path helper that is merely *plausible* produces files the
 * harness refuses to load. The `projectKey` cases below pin the escaping
 * rules; the final test checks the same function against whatever real
 * project directories exist on this machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  encodeSegment,
  generationLogFilename,
  parseGenerationLogFilename,
  projectKey,
  sessionArtifactPath,
  synthesizeSession,
  verifyArtifact,
} from '../dist/index.js';
import { parseRolloutText } from '@codex-to-dsh/codex-rollout';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, '..', '..', '..', 'fixtures', 'rollout-sample.jsonl'), 'utf8');

test('projectKey replaces separators and escapes everything else', () => {
  // Separators collapse; unsafe code units take the ~XXXX escape.
  assert.equal(projectKey('/a/b/c'), '--a-b-c--');
  assert.equal(projectKey('/a//b'), '--a-b--', 'a separator run collapses to one dash');
  // Only *leading* separators are stripped, so a trailing separator does leave
  // a trailing dash. This is DSH's behaviour and is reproduced deliberately.
  assert.equal(projectKey('/a/b/'), '--a-b---', 'a trailing separator leaves a trailing dash');
  assert.equal(projectKey('C:\\Users\\x'), '--C-Users-x--', 'drive separators are separators');
  assert.equal(projectKey('/a b'), '--a~0020b--', 'a space is escaped, not kept');
  assert.equal(projectKey('/a\u00e9b'), '--a~00E9b--', 'escapes are uppercase hex, four digits');
  assert.equal(projectKey('/a~b'), '--a~007Eb--', 'a literal tilde is escaped too');
  assert.equal(projectKey('/a.b_c-d'), '--a.b_c-d--', 'dot, underscore and dash survive');
  assert.equal(projectKey('/'), '--root--', 'an all-separator path falls back to "root"');
});

test('projectKey truncates rather than overflowing a path component', () => {
  const key = projectKey(`/${'x'.repeat(400)}`);
  assert.equal(key.length, 255, 'two dashes plus 251 characters plus two dashes');
  assert.ok(key.startsWith('--xxx'));
  assert.ok(key.endsWith('--'));
});

test('encodeSegment never emits a traversal or an empty name', () => {
  assert.equal(encodeSegment('session-abc'), 'session-abc');
  assert.equal(encodeSegment('.'), '~002E');
  assert.equal(encodeSegment('..'), '~002E~002E');
  assert.equal(encodeSegment('a/b'), 'a~002Fb');
  assert.equal(encodeSegment('a b'), 'a~0020b');
  assert.throws(() => encodeSegment(''), /empty path segment/);
});

test('generation filenames round-trip and reject non-canonical names', () => {
  assert.equal(generationLogFilename(0), 'session.jsonl.zstd');
  assert.equal(generationLogFilename(3), 'session.v3.jsonl.zstd');
  assert.equal(generationLogFilename(3, 'none'), 'session.v3.jsonl');

  assert.equal(parseGenerationLogFilename('session.jsonl.zstd'), 0);
  assert.equal(parseGenerationLogFilename('session.v3.jsonl.zstd'), 3);
  assert.equal(parseGenerationLogFilename('session.v03.jsonl.zstd'), undefined, 'leading zeros are not canonical');
  assert.equal(parseGenerationLogFilename('session.V3.jsonl.zstd'), undefined, 'uppercase is not canonical');
  assert.equal(parseGenerationLogFilename('session.v3.jsonl'), undefined, 'the compression suffix must match');
  assert.equal(parseGenerationLogFilename('rollout-2026-01-02.jsonl'), undefined);
});

test('the artifact path is a pure function of the header', () => {
  const path = sessionArtifactPath('/home/u/.dsh/sessions', '/home/u/work/demo', 'session-1');
  assert.equal(path, '/home/u/.dsh/sessions/--home-u-work-demo--/session-1/session.v3.jsonl.zstd');
  assert.equal(
    sessionArtifactPath('/home/u/.dsh/sessions', undefined, 'session-1'),
    '/home/u/.dsh/sessions/_no-cwd/session-1/session.v3.jsonl.zstd',
  );
});

test('a synthesized artifact satisfies every structural invariant', () => {
  const summary = parseRolloutText(fixture);
  const result = synthesizeSession(summary, { provider: 'openai', model: 'gpt-5' });
  const report = verifyArtifact(result.jsonl, '/home/u/.dsh/sessions');

  assert.equal(report.ok, true, JSON.stringify(report.violations, null, 2));
  assert.equal(report.violations.length, 0);
  assert.ok(report.checksRun.length >= 9);
});

test('synthesis marks message-bearing events and keeps sequence contiguous', () => {
  const result = synthesizeSession(parseRolloutText(fixture));
  const rows = result.jsonl.trim().split('\n').slice(1).map((line) => JSON.parse(line));

  rows.forEach((row, index) => assert.equal(row.seq, index, `row ${index} is contiguous`));

  const surfaceEligible = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message']);
  for (const row of rows) {
    if (surfaceEligible.has(row.type)) assert.equal(row.surfaceOp, 'append', `${row.type} carries a marker`);
  }
  assert.ok(rows.some((row) => row.type === 'turn/start'));
  assert.ok(rows.some((row) => row.type === 'turn/end'));
  assert.ok(rows.some((row) => row.type === 'session/title'));
});

test('an unmatched tool output is paired with a synthesized call', () => {
  const result = synthesizeSession(parseRolloutText(fixture));
  assert.deepEqual(result.orphanResults, ['call_orphan_9'], 'the fixture carries exactly one orphan');

  const rows = result.rows;
  const announced = new Set(rows.filter((r) => r.type === 'tool/call').map((r) => r.data.callId));
  const answered = rows
    .filter((r) => r.type === 'tool/result')
    .map((r) => r.data.message.source.callId);
  for (const callId of answered) {
    assert.ok(announced.has(callId), `result for ${callId} has a preceding call`);
  }
});

test('unknown Codex types are preserved as ignorable events', () => {
  const result = synthesizeSession(parseRolloutText(fixture));
  const unknown = result.rows.filter((row) => row.type === 'codex/unknown');
  assert.equal(unknown.length, 1, 'ghost_snapshot is carried, not silently dropped');
  for (const row of unknown) assert.equal(row.ignorable, true);
  assert.ok(result.preserved.some((type) => type.includes('ghost_snapshot')));
});

test('reasoning is preserved without its ciphertext', () => {
  const result = synthesizeSession(parseRolloutText(fixture));
  const reasoning = result.rows.filter((row) => row.type === 'codex/reasoning');
  assert.ok(reasoning.length >= 1);
  assert.ok(
    !result.jsonl.includes('b3BhcXVl'),
    'the encrypted blob from the fixture is absent from the artifact',
  );
});

test('cwdRewrite changes the header and therefore the storage path', () => {
  const summary = parseRolloutText(fixture);
  const result = synthesizeSession(summary, {
    cwdRewrite: (cwd) => cwd.replace('/home/example/work', '/Users/local/Projects'),
  });
  assert.equal(result.cwd, '/Users/local/Projects/demo-project');

  const header = JSON.parse(result.jsonl.split('\n')[0]);
  assert.equal(header.cwd, '/Users/local/Projects/demo-project');
  assert.equal(
    sessionArtifactPath('/root', header.cwd, header.id),
    '/root/--Users-local-Projects-demo-project--/session-codex-019f0000-0000-7000-8000-000000000001/session.v3.jsonl.zstd',
  );
});

test('verification rejects a tampered artifact', () => {
  const result = synthesizeSession(parseRolloutText(fixture));
  const lines = result.jsonl.trim().split('\n');

  const withGap = [...lines];
  const row = JSON.parse(withGap[3]);
  withGap[3] = JSON.stringify({ ...row, seq: row.seq + 5 });
  const gapReport = verifyArtifact(`${withGap.join('\n')}\n`);
  assert.equal(gapReport.ok, false);
  assert.ok(gapReport.violations.some((violation) => violation.code === 'C4-seq-contiguous'));

  const withoutMarker = [...lines];
  const markerIndex = withoutMarker.findIndex((line) => JSON.parse(line).type === 'assistant/message');
  assert.ok(markerIndex > 0, 'the fixture produces an assistant message');
  const stripped = JSON.parse(withoutMarker[markerIndex]);
  delete stripped.surfaceOp;
  withoutMarker[markerIndex] = JSON.stringify(stripped);
  const markerReport = verifyArtifact(`${withoutMarker.join('\n')}\n`);
  assert.equal(markerReport.ok, false);
  assert.ok(markerReport.violations.some((violation) => violation.code === 'C1-surface-marker'));
});

test('projectKey agrees with the real project directories on this machine', async (t) => {
  const root = join(homedir(), '.dsh', 'sessions');
  if (!existsSync(root)) {
    t.skip('no DSH session root on this machine');
    return;
  }

  const projects = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (projects.length === 0) {
    t.skip('the DSH session root holds no project directories');
    return;
  }

  let checked = 0;
  for (const project of projects) {
    const dir = join(root, project);
    for (const session of readdirSync(dir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const artifact = readdirSync(join(dir, session.name))
        .filter((name) => parseGenerationLogFilename(name) !== undefined)
        .sort()
        .pop();
      if (artifact === undefined) continue;

      // Live check: re-derive the storage path from the artifact's own header
      // and require it to be exactly where the file actually is.
      const header = readSessionHeader(join(dir, session.name, artifact));
      if (header === undefined) continue;

      assert.equal(
        projectKey(header.cwd),
        project,
        'projectKey(header.cwd) must name the directory the artifact was found in',
      );
      // The comparison must use the *stored* generation, not the current one:
      // a directory can still hold a generation-0 artifact.
      const storedVersion = parseGenerationLogFilename(artifact);
      assert.equal(
        sessionArtifactPath(root, header.cwd, header.id, storedVersion),
        join(dir, session.name, artifact),
        'the derived artifact path must be the artifact path',
      );
      assert.equal(
        header.version,
        storedVersion,
        'a header must declare the generation its filename claims',
      );
      checked += 1;
    }
  }

  assert.ok(checked > 0, `verified ${checked} real sessions against their derived paths`);
  t.diagnostic(`verified ${checked} real DSH sessions against derived paths`);
});

/** Read a session header by decompressing only as far as the first newline. */
function readSessionHeader(path) {
  const { zstdDecompressSync } = require('node:zlib');
  try {
    const text = zstdDecompressSync(readFileSync(path)).toString('utf8');
    return JSON.parse(text.slice(0, text.indexOf('\n')));
  } catch {
    return undefined;
  }
}

test('every turn and step is both opened and closed', () => {
  const result = synthesizeSession(parseRolloutText(fixture));
  const count = (type) => result.rows.filter((row) => row.type === type).length;

  assert.equal(count('turn/start'), count('turn/end'), 'turns are balanced');
  assert.equal(count('step/start'), count('step/end'), 'steps are balanced');
  assert.ok(count('turn/start') >= 1, 'the fixture produces at least one turn');

  // Ordering: a turn opens before it closes, and a step stays inside its turn.
  let openTurns = 0;
  let openSteps = 0;
  for (const row of result.rows) {
    if (row.type === 'turn/start') openTurns += 1;
    if (row.type === 'turn/end') openTurns -= 1;
    if (row.type === 'step/start') openSteps += 1;
    if (row.type === 'step/end') openSteps -= 1;
    assert.ok(openTurns >= 0, 'a turn never closes before it opens');
    assert.ok(openSteps >= 0, 'a step never closes before it opens');
  }
  assert.equal(openTurns, 0);
  assert.equal(openSteps, 0);
});

test('a rollout that closes a turn it never opened still balances', () => {
  const orphanClose = [
    '{"timestamp":"2026-01-02T03:04:05.000Z","type":"session_meta","payload":{"id":"orphan","cwd":"/tmp/x"}}',
    '{"timestamp":"2026-01-02T03:04:06.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}',
  ].join('\n');

  const result = synthesizeSession(parseRolloutText(orphanClose));
  const count = (type) => result.rows.filter((row) => row.type === type).length;
  assert.equal(count('turn/start'), 1, 'the missing opener is synthesized');
  assert.equal(count('turn/end'), 1);
  assert.equal(verifyArtifact(result.jsonl).ok, true);
});
