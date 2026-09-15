/**
 * Synthesis of a DSH session artifact from a normalized Codex rollout.
 *
 * This is the write side of the bridge, and it is deliberately asymmetric:
 * Codex has richer vocabulary than DSH in some places and poorer vocabulary in
 * others, so every decision below is a choice rather than a translation. The
 * table is the contract; changing a row is a fidelity change.
 *
 * | Codex record | Emitted as |
 * | ------------ | ---------- |
 * | `session_meta` | the session header (`base_instructions` is not carried) |
 * | `turn_context` | `request/context`, once, for model and provider |
 * | `response_item/message` (user) | `user/message` |
 * | `response_item/message` (assistant) | `assistant/message`, with `stream: []` |
 * | `response_item/message` (developer, system) | `system/message` |
 * | `function_call`, `custom_tool_call`, `tool_search_call` | `tool/call` |
 * | `function_call_output`, `custom_tool_call_output`, `tool_search_output`, `patch_apply_end` | `tool/result` |
 * | `web_search_call` | `tool/call`, identified by `id` |
 * | `event_msg/web_search_end` | `tool/result`, identified by `call_id` |
 * | `event_msg/task_started` | `turn/start` |
 * | `event_msg/task_complete` | `turn/end` |
 * | `event_msg/turn_aborted` | `turn/end` (aborted) |
 * | `event_msg/item_completed` | `step/end` |
 * | `response_item/reasoning`, `event_msg/agent_reasoning` | `codex/reasoning`, ignorable; the ciphertext is never carried |
 * | `event_msg/token_count` | `codex/token-count`, ignorable, off by default |
 * | `event_msg/context_compacted`, `compacted` | `codex/compaction`, ignorable |
 * | anything unrecognized | `codex/unknown`, ignorable, so a new Codex release is a visible gap rather than data loss |
 *
 * {@link SessionBuilder} owns sequence numbers and enforces the message
 * invariants (C1, C2, C4), so this module's job is ordering and pairing: it
 * tracks which tool calls have been announced, opens a turn lazily when a
 * rollout closes one it never opened, and records where it had to do so.
 *
 * @module
 */

import {
  SessionBuilder,
  type ContentBlock,
  type SessionRow,
  type Settlement,
} from './events.ts';
import type { RolloutEntry, RolloutSummary } from './rollout.ts';

/** Options controlling synthesis. */
export interface SynthesizeOptions {
  /** DSH session id. Defaults to a deterministic id derived from the rollout id. */
  readonly sessionId?: string;
  /** Provider name recorded in `request/context`. */
  readonly provider?: string;
  /** Model name recorded in `request/context` and on assistant messages. */
  readonly model?: string;
  /**
   * Rewrite the session's working directory. Codex rollouts are portable
   * across machines, so a recorded `cwd` frequently does not exist locally.
   * The rewrite is part of the address DSH recomputes, not a display detail.
   */
  readonly cwdRewrite?: (cwd: string) => string;
  /** Preserve reasoning text as `ignorable` events. Defaults to `true`. */
  readonly keepReasoning?: boolean;
  /** Preserve token accounting as `ignorable` events. Defaults to `false`. */
  readonly keepTelemetry?: boolean;
  /** Maximum characters of preserved text to carry per event. */
  readonly unknownPayloadLimit?: number;
}

/** One parsed record that was not carried into the artifact. */
export interface DroppedRecord {
  /** Codex record type as `<channel>/<payloadType|->`. */
  readonly type: string;
  /** 1-based line in the source rollout. */
  readonly line: number;
  readonly reason: string;
}

/** Result of a synthesis run, including the accounting a caller needs to judge it. */
export interface SynthesizeResult {
  readonly sessionId: string;
  readonly cwd: string | undefined;
  readonly rowCount: number;
  readonly jsonl: string;
  readonly rows: readonly SessionRow[];
  /** Events emitted per DSH type. */
  readonly emitted: Readonly<Record<string, number>>;
  /** Codex record types carried as `codex/*` ignorable events, sorted. */
  readonly preserved: readonly string[];
  /** Records the parse tier retained and synthesis did not carry, in file order. */
  readonly dropped: readonly DroppedRecord[];
  /** Tool outputs whose matching call was absent and had to be synthesized. */
  readonly orphanResults: readonly string[];
}

/** The longest session title carried, matching the converter's rule. */
const TITLE_MAX_LEN = 80;
const TITLE_ELLIPSIS = '…';

/** Identify a Codex record type as `<channel>/<payloadType|->`. */
function entryKey(entry: RolloutEntry): string {
  return `${entry.origin.channel}/${entry.origin.payloadType ?? '-'}`;
}

/** Time source for an entry, falling back to a synthetic monotonic clock. */
function entryTime(entry: RolloutEntry, fallback: number): number {
  const raw = entry.origin.timestamp;
  if (raw === undefined) return fallback;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Derive a stable DSH session id from the rollout identity. */
function deriveSessionId(summary: RolloutSummary): string {
  const id = summary.meta?.id;
  if (id !== undefined && id.length > 0) return `session-codex-${id}`;
  const created = summary.meta?.timestamp ?? 'unknown';
  return `session-codex-${created.replace(/[^0-9A-Za-z]/g, '')}`;
}

/** Collapse whitespace and truncate a session title. */
function normalizeTitle(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  if (collapsed.length === 0) return '';
  return collapsed.length <= TITLE_MAX_LEN
    ? collapsed
    : collapsed.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS;
}

/** Use the first user message as the session title. */
function firstUserText(summary: RolloutSummary): string | undefined {
  for (const entry of summary.entries) {
    if (entry.kind !== 'message' || entry.role !== 'user') continue;
    const title = normalizeTitle(entry.text);
    if (title.length > 0) return title;
  }
  return undefined;
}

/**
 * Convert a parsed rollout into a DSH session artifact.
 *
 * The builder owns sequence numbers and the message envelopes, so this
 * function supplies order and pairing. DSH pairs a `tool/result` with the
 * `tool/call` named by its `source.callId`, so a result whose call scrolled out
 * of the retained prefix gets a synthesized call and is reported in
 * {@link SynthesizeResult.orphanResults}. Turn boundaries get the same
 * treatment: a `task_complete` with no matching `task_started` opens a turn
 * lazily, so every `turn/end` has an opener.
 * @param summary - a parsed rollout.
 * @param options - synthesis options.
 * @returns the artifact text plus accounting.
 */
export function synthesizeSession(
  summary: RolloutSummary,
  options: SynthesizeOptions = {},
): SynthesizeResult {
  const sessionId = options.sessionId ?? deriveSessionId(summary);
  const rawCwd = summary.meta?.cwd;
  const cwd = rawCwd === undefined ? undefined : (options.cwdRewrite?.(rawCwd) ?? rawCwd);
  const provider = options.provider ?? summary.meta?.modelProvider ?? 'openai';

  const createdAt = Date.parse(summary.meta?.timestamp ?? '') || Date.now();
  const builder = new SessionBuilder({
    id: sessionId,
    createdAt,
    ...(cwd !== undefined ? { cwd } : {}),
  });

  const emitted: Record<string, number> = {};
  const preserved = new Set<string>();
  const dropped: DroppedRecord[] = [];
  const orphanResults: string[] = [];
  const announcedCalls = new Set<string>();
  const unknownLimit = options.unknownPayloadLimit ?? 2000;

  let turn = 0;
  let step = 1;
  let stepOpen = false;
  let turnOpen = false;
  let fallback = createdAt;
  let messageSeq = 0;
  let contextEmitted = false;
  let contextModel: string | undefined;

  const settle = (): Settlement => ({ turn, step });
  const record = (type: string): void => {
    emitted[type] = (emitted[type] ?? 0) + 1;
  };
  const nextId = (prefix: string): string => {
    messageSeq += 1;
    return `${prefix}-${messageSeq.toString().padStart(6, '0')}`;
  };
  const drop = (entry: RolloutEntry, reason: string): void => {
    dropped.push({ type: entryKey(entry), line: entry.origin.line, reason });
  };

  const closeStep = (time: number): void => {
    if (!stepOpen) return;
    builder.stepEnd(time, settle());
    record('step/end');
    stepOpen = false;
  };

  const openTurn = (time: number): void => {
    if (turnOpen) return;
    turn += 1;
    step = 1;
    builder.turnStart(time, turn);
    record('turn/start');
    builder.stepStart(time, settle());
    record('step/start');
    stepOpen = true;
    turnOpen = true;
  };

  const closeTurn = (time: number, kind: 'completed' | 'aborted' | 'failed'): void => {
    if (!turnOpen) return;
    closeStep(time);
    builder.turnEnd(time, turn, kind);
    record('turn/end');
    turnOpen = false;
  };

  for (const entry of summary.entries) {
    fallback += 1000;
    const time = entryTime(entry, fallback);

    switch (entry.kind) {
      case 'session-meta':
        // Identity lives in the header, which the builder already wrote.
        break;

      case 'turn-context': {
        if (contextModel === undefined && entry.context.model !== undefined) {
          contextModel = entry.context.model;
        }
        if (!contextEmitted && entry.context.model !== undefined) {
          builder.requestContext(time, provider, options.model ?? entry.context.model);
          record('request/context');
          contextEmitted = true;
        }
        break;
      }

      case 'boundary': {
        if (entry.phase === 'turn-start') {
          closeTurn(time, 'completed');
          openTurn(time);
        } else if (entry.phase === 'step-end') {
          if (stepOpen) {
            closeStep(time);
            step += 1;
            builder.stepStart(time, settle());
            record('step/start');
            stepOpen = true;
          }
        } else {
          openTurn(time);
          closeTurn(time, entry.phase === 'turn-aborted' ? 'aborted' : 'completed');
        }
        break;
      }

      case 'message': {
        if (entry.text.trim().length === 0) {
          drop(entry, 'message carries no text');
          break;
        }
        const blocks: ContentBlock[] = [{ type: 'text', text: entry.text }];
        if (entry.role === 'assistant') {
          builder.assistantMessage(time, settle(), nextId('codex-a'), blocks, {
            kind: 'model',
            provider,
            model: options.model ?? contextModel ?? 'unknown',
          });
          record('assistant/message');
        } else if (entry.role === 'user') {
          builder.userMessage(time, nextId('codex-u'), blocks);
          record('user/message');
        } else if (entry.role === 'developer' || entry.role === 'system') {
          builder.systemMessage(time, settle(), nextId('codex-s'), blocks);
          record('system/message');
        } else {
          // Codex does not attach a call id to a `tool` role message, and DSH
          // pairs tool results through one, so there is nothing to pair it with.
          drop(entry, 'message role "tool" carries no call id; tool output arrives as function_call_output');
        }
        break;
      }

      case 'tool-call': {
        if (entry.callId.length === 0) {
          drop(entry, 'tool call carries no call_id');
          break;
        }
        announcedCalls.add(entry.callId);
        builder.toolCall(time, settle(), entry.callId, entry.name, entry.arguments);
        record('tool/call');
        break;
      }

      case 'tool-output': {
        if (entry.callId.length === 0) {
          drop(entry, 'tool output carries no call_id');
          break;
        }
        if (!announcedCalls.has(entry.callId)) {
          orphanResults.push(entry.callId);
          builder.toolCall(time, settle(), entry.callId, 'unknown-tool', '{}');
          record('tool/call');
          announcedCalls.add(entry.callId);
        }
        builder.toolResult(time, settle(), nextId('codex-r'), entry.callId, entry.output);
        record('tool/result');
        break;
      }

      case 'reasoning': {
        if (options.keepReasoning === false) {
          drop(entry, 'reasoning is off (keepReasoning: false)');
          break;
        }
        if (entry.text.length === 0) {
          drop(entry, 'reasoning carries no readable text');
          break;
        }
        preserved.add(entryKey(entry));
        builder.ignorable(time, 'codex/reasoning', {
          text: entry.text.slice(0, unknownLimit),
          encrypted: entry.encrypted,
        });
        record('codex/reasoning');
        break;
      }

      case 'telemetry': {
        if (options.keepTelemetry !== true) {
          drop(entry, 'telemetry is off by default (keepTelemetry: true keeps it)');
          break;
        }
        preserved.add(entryKey(entry));
        builder.ignorable(time, 'codex/token-count', entry.metrics);
        record('codex/token-count');
        break;
      }

      case 'compaction': {
        preserved.add(entryKey(entry));
        builder.ignorable(time, 'codex/compaction', {
          ...(entry.replacementText !== undefined
            ? { replacement: entry.replacementText.slice(0, unknownLimit) }
            : {}),
        });
        record('codex/compaction');
        break;
      }

      case 'unknown': {
        const key = entryKey(entry);
        preserved.add(key);
        builder.ignorable(time, 'codex/unknown', {
          source: key,
          payload: (JSON.stringify(entry.payload) ?? 'null').slice(0, unknownLimit),
        });
        record('codex/unknown');
        break;
      }
    }
  }

  closeTurn(fallback + 1000, 'completed');

  const title = firstUserText(summary);
  if (title !== undefined) {
    builder.title(fallback + 1000, title);
    record('session/title');
  }

  const rows = builder.rows;
  return {
    sessionId,
    cwd,
    rowCount: rows.length + 1,
    jsonl: builder.toJsonl(),
    rows,
    emitted,
    preserved: [...preserved].sort(),
    dropped,
    orphanResults,
  };
}
