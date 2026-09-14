/**
 * Parser tests against the synthetic fixture.
 *
 * The fixture is hand-written to contain every record type observed in real
 * rollouts, including the two easy-to-miss cases: a `web_search_call` that
 * identifies itself with `id` while its paired `web_search_end` uses
 * `call_id`, and a `function_call_output` with no matching call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseRolloutText, dedupeEventChannel } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, '..', '..', '..', 'fixtures', 'rollout-sample.jsonl'), 'utf8');

test('reads the session header from session_meta', () => {
  const summary = parseRolloutText(fixture);
  assert.equal(summary.meta?.id, '019f0000-0000-7000-8000-000000000001');
  assert.equal(summary.meta?.cwd, '/home/example/work/demo-project');
  assert.equal(summary.meta?.modelProvider, 'openai');
  assert.equal(summary.errors.length, 0);
});

test('classifies every record in the fixture', () => {
  const { counts } = parseRolloutText(fixture);
  assert.equal(counts['session-meta'], 1);
  assert.equal(counts['turn-context'], 1);
  assert.equal(counts['tool-call'], 3, 'function_call + custom_tool_call + web_search_call');
  assert.equal(counts['tool-output'], 4, 'two function outputs, one custom output, one web search end');
  assert.equal(counts.reasoning, 2, 'response_item/reasoning + event_msg/agent_reasoning');
  assert.equal(counts.compaction, 1);
  assert.equal(counts.telemetry, 1);
  assert.equal(counts.unknown, 1, 'ghost_snapshot is not modelled');
  assert.equal(counts.boundary, 4, 'task_started + item_completed + two task_complete');
  assert.equal(counts.message, 7, 'five on the response channel, two duplicate on the event channel');
});

test('suppresses the duplicate event-channel messages', () => {
  const withDedupe = parseRolloutText(fixture);
  const withoutDedupe = parseRolloutText(fixture, { dedupeEventChannel: false });

  assert.equal(withDedupe.counts.message, 7, 'raw counts are unaffected by the tier');
  const messages = (summary) => summary.entries.filter((entry) => entry.kind === 'message');
  assert.equal(messages(withoutDedupe).length, 7);
  assert.equal(messages(withDedupe).length, 5, 'both duplicates removed');

  const texts = messages(withDedupe).map((entry) => entry.text);
  assert.equal(new Set(texts).size, texts.length, 'no message text survives twice');
});

test('telemetry is dropped by default and kept on request', () => {
  const kept = parseRolloutText(fixture, { keepTelemetry: true });
  const dropped = parseRolloutText(fixture);
  assert.equal(kept.entries.filter((e) => e.kind === 'telemetry').length, 1);
  assert.equal(dropped.entries.filter((e) => e.kind === 'telemetry').length, 0);
});

test('the web search pair is joined on the right identifiers', () => {
  const { entries } = parseRolloutText(fixture, { dedupeEventChannel: false });
  const call = entries.find((e) => e.kind === 'tool-call' && e.name === 'web_search');
  const end = entries.find((e) => e.kind === 'tool-output' && e.callId === 'ws_fixture_1');
  assert.ok(call, 'web_search_call is read from `id`');
  assert.equal(call.callId, 'ws_fixture_1');
  assert.ok(end, 'web_search_end is read from `call_id`, and the two agree');
});

test('reasoning keeps its readable text and flags the opaque part', () => {
  const { entries } = parseRolloutText(fixture);
  const reasoning = entries.filter((e) => e.kind === 'reasoning');
  const encrypted = reasoning.find((e) => e.encrypted);
  assert.ok(encrypted, 'the fixture carries encrypted_content');
  assert.equal(encrypted.text, 'The user wants an inventory plus a purpose summary.');
  assert.ok(
    !JSON.stringify(reasoning).includes('b3BhcXVl'),
    'encrypted_content never enters the normalized representation',
  );
});

test('a developer message stays a developer message', () => {
  const { entries } = parseRolloutText(fixture, { dedupeEventChannel: false });
  const developer = entries.find((e) => e.kind === 'message' && e.role === 'developer');
  assert.ok(developer);
  assert.match(developer.text, /sandbox_mode is workspace-write/);
});

test('dedupe leaves an unrecognized duplicate in place', () => {
  const entries = [
    { kind: 'message', origin: { line: 1, channel: 'event_msg' }, role: 'user', text: 'only here', fromEventChannel: true },
  ];
  assert.equal(dedupeEventChannel(entries, 24).length, 1);
});

test('malformed lines are reported, not fatal', () => {
  const input = [
    '{"timestamp":"2026-01-02T03:04:05.000Z","type":"session_meta","payload":{"id":"abc","cwd":"/tmp/x"}}',
    '{ this is not json }',
    '{"timestamp":"2026-01-02T03:04:06.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"still readable"}]}}',
  ].join('\n');

  const summary = parseRolloutText(input);
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].line, 2, 'line numbers are 1-based and point at the bad row');
  assert.equal(summary.meta?.id, 'abc', 'the header before the bad row still parses');
  assert.equal(
    summary.entries.filter((entry) => entry.kind === 'message').length,
    1,
    'rows after the bad row are still read',
  );
});
