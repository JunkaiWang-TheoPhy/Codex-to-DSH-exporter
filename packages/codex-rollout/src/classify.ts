/**
 * Classification of one physical rollout row into the normalized IR.
 *
 * Codex writes the same conversation on two channels: `response_item` carries
 * the model-facing content, `event_msg` carries UI and telemetry records and
 * repeats some messages. Both are normalized here; the duplicate suppression
 * happens in {@link module:dedupe}.
 *
 * Field names below were read from real rollouts, not inferred. Two are easy
 * to get wrong and are called out where they occur:
 *
 * - `web_search_call` identifies itself with `id`, not `call_id`, while its
 *   paired `web_search_end` uses `call_id`.
 * - `reasoning` carries `encrypted_content`, which is 85.5% of that record's
 *   bytes and is opaque outside OpenAI's own systems.
 *
 * @module
 */

import type {
  CodexContentBlock,
  CodexRole,
  CodexSessionMeta,
  CodexTurnContext,
  EntryOrigin,
  RolloutEntry,
  ToolCallFlavor,
} from './types.ts';

/** The five top-level `type` values Codex emits. */
const KNOWN_CHANNELS = new Set([
  'session_meta',
  'response_item',
  'event_msg',
  'turn_context',
  'compacted',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Join the text blocks of a Codex content array.
 *
 * Codex uses `input_text`, `output_text`, and `text` for plain text, plus
 * `input_image` / `output_image` for attachments. Images are surfaced as a
 * marker rather than silently dropped.
 * @param content - the raw `content` array, if the payload has one.
 * @returns the concatenated text, with image markers in place.
 */
export function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = str(block['type']);
    const text = str(block['text']);
    if (text !== undefined && (type === 'input_text' || type === 'output_text' || type === 'text')) {
      parts.push(text);
    } else if (type === 'input_image' || type === 'output_image') {
      parts.push(`[image${str(block['image_url']) ? `: ${str(block['image_url'])}` : ''}]`);
    }
  }
  return parts.join('\n');
}

/** Normalize the free-form role strings Codex writes. */
function role(value: unknown): CodexRole {
  switch (value) {
    case 'user':
    case 'assistant':
    case 'developer':
    case 'system':
    case 'tool':
      return value;
    default:
      return 'assistant';
  }
}

/** Collect the numeric leaves of a telemetry payload such as `token_count`. */
function numericLeaves(value: unknown, prefix = '', out: Record<string, number> = {}): Record<string, number> {
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      numericLeaves(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    out[prefix] = value;
  }
  return out;
}

function parseSessionMeta(payload: Record<string, unknown>): CodexSessionMeta {
  const base = isRecord(payload['base_instructions']) ? payload['base_instructions'] : undefined;
  return {
    id: str(payload['id']) ?? '',
    ...(str(payload['timestamp']) !== undefined ? { timestamp: str(payload['timestamp'])! } : {}),
    ...(str(payload['cwd']) !== undefined ? { cwd: str(payload['cwd'])! } : {}),
    ...(str(payload['originator']) !== undefined ? { originator: str(payload['originator'])! } : {}),
    ...(str(payload['cli_version']) !== undefined ? { cliVersion: str(payload['cli_version'])! } : {}),
    ...(str(payload['source']) !== undefined ? { source: str(payload['source'])! } : {}),
    ...(str(payload['model_provider']) !== undefined
      ? { modelProvider: str(payload['model_provider'])! }
      : {}),
    ...(base !== undefined && str(base['text']) !== undefined
      ? { baseInstructions: str(base['text'])! }
      : {}),
  };
}

function parseTurnContext(payload: Record<string, unknown>): CodexTurnContext {
  const sandbox = isRecord(payload['sandbox_policy']) ? payload['sandbox_policy'] : undefined;
  return {
    ...(str(payload['cwd']) !== undefined ? { cwd: str(payload['cwd'])! } : {}),
    ...(str(payload['model']) !== undefined ? { model: str(payload['model'])! } : {}),
    ...(str(payload['approval_policy']) !== undefined
      ? { approvalPolicy: str(payload['approval_policy'])! }
      : {}),
    ...(sandbox !== undefined && str(sandbox['mode']) !== undefined
      ? { sandboxPolicy: str(sandbox['mode'])! }
      : {}),
    ...(str(payload['summary']) !== undefined ? { summary: str(payload['summary'])! } : {}),
  };
}

function origin(
  line: number,
  timestamp: string | undefined,
  channel: EntryOrigin['channel'],
  payloadType: string | undefined,
): EntryOrigin {
  return {
    line,
    channel,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(payloadType !== undefined ? { payloadType } : {}),
  };
}

/**
 * Classify one `response_item` payload.
 * @param payload - the `payload` object.
 * @param from - origin fields already extracted.
 * @returns the normalized entry.
 */
function classifyResponseItem(payload: Record<string, unknown>, from: EntryOrigin): RolloutEntry {
  switch (payload['type']) {
    case 'message':
      return {
        kind: 'message',
        origin: from,
        role: role(payload['role']),
        text: textFromContent(payload['content']),
        fromEventChannel: false,
      };

    case 'function_call':
      return {
        kind: 'tool-call',
        origin: from,
        callId: str(payload['call_id']) ?? '',
        name: str(payload['name']) ?? 'unknown',
        flavor: 'function' satisfies ToolCallFlavor,
        arguments: str(payload['arguments']) ?? '',
      };

    case 'custom_tool_call':
      return {
        kind: 'tool-call',
        origin: from,
        callId: str(payload['call_id']) ?? '',
        name: str(payload['name']) ?? 'unknown',
        flavor: 'custom' satisfies ToolCallFlavor,
        arguments: str(payload['input']) ?? '',
      };

    case 'function_call_output':
    case 'custom_tool_call_output':
      return {
        kind: 'tool-output',
        origin: from,
        callId: str(payload['call_id']) ?? '',
        output: str(payload['output']) ?? '',
      };

    case 'tool_search_call':
      return {
        kind: 'tool-call',
        origin: from,
        callId: str(payload['call_id']) ?? '',
        name: 'tool_search',
        flavor: 'function' satisfies ToolCallFlavor,
        arguments: str(payload['arguments']) ?? '',
      };

    case 'tool_search_output':
      return {
        kind: 'tool-output',
        origin: from,
        callId: str(payload['call_id']) ?? '',
        output: JSON.stringify(payload['tools'] ?? null),
      };

    case 'web_search_call':
      // Note: this record uses `id`; the paired `web_search_end` uses `call_id`.
      return {
        kind: 'tool-call',
        origin: from,
        callId: str(payload['id']) ?? str(payload['call_id']) ?? '',
        name: 'web_search',
        flavor: 'web_search' satisfies ToolCallFlavor,
        arguments: JSON.stringify(payload['action'] ?? null),
      };

    case 'reasoning': {
      const readable = [textFromContent(payload['content']), str(payload['summary']) ?? '']
        .filter((part) => part.length > 0)
        .join('\n');
      return {
        kind: 'reasoning',
        origin: from,
        text: readable,
        encrypted: str(payload['encrypted_content']) !== undefined,
      };
    }

    case 'patch_apply_end':
      return {
        kind: 'tool-output',
        origin: from,
        callId: str(payload['call_id']) ?? '',
        output: [str(payload['stdout']) ?? '', str(payload['stderr']) ?? '']
          .filter((part) => part.length > 0)
          .join('\n'),
      };

    default:
      return { kind: 'unknown', origin: from, payload };
  }
}

/**
 * Classify one `event_msg` payload.
 *
 * `user_message` and `agent_message` duplicate content already present on the
 * `response_item` channel; they are marked rather than dropped so that the
 * dedupe stage can decide.
 * @param payload - the `payload` object.
 * @param from - origin fields already extracted.
 * @returns the normalized entry.
 */
function classifyEventMsg(payload: Record<string, unknown>, from: EntryOrigin): RolloutEntry {
  switch (payload['type']) {
    case 'user_message':
      return {
        kind: 'message',
        origin: from,
        role: 'user',
        text: str(payload['message']) ?? '',
        fromEventChannel: true,
      };

    case 'agent_message':
      return {
        kind: 'message',
        origin: from,
        role: 'assistant',
        text: str(payload['message']) ?? '',
        fromEventChannel: true,
      };

    case 'agent_reasoning':
      return {
        kind: 'reasoning',
        origin: from,
        text: str(payload['text']) ?? '',
        encrypted: false,
      };

    case 'token_count':
      return { kind: 'telemetry', origin: from, metrics: numericLeaves(payload) };

    case 'task_started':
      return { kind: 'boundary', origin: from, phase: 'turn-start' };

    case 'task_complete':
      return { kind: 'boundary', origin: from, phase: 'turn-end' };

    case 'turn_aborted':
      return { kind: 'boundary', origin: from, phase: 'turn-aborted' };

    case 'item_completed':
      return { kind: 'boundary', origin: from, phase: 'step-end' };

    case 'context_compacted':
      return { kind: 'compaction', origin: from };

    case 'web_search_end':
      return {
        kind: 'tool-output',
        origin: from,
        callId: str(payload['call_id']) ?? '',
        output: JSON.stringify(payload['results'] ?? payload['query'] ?? null),
      };

    default:
      return { kind: 'unknown', origin: from, payload };
  }
}

/**
 * Classify one raw rollout row.
 *
 * Unrecognized payload types become {@link UnknownEntry} rather than being
 * dropped, so an unrecognized Codex release shows up as a coverage gap instead
 * of silent data loss.
 * @param record - one parsed JSONL row.
 * @param line - 1-based line number, used for stable ordering and reporting.
 * @returns the normalized entry.
 */
export function classifyRecord(record: unknown, line: number): RolloutEntry {
  if (!isRecord(record)) {
    return { kind: 'unknown', origin: origin(line, undefined, 'response_item', undefined), payload: record };
  }

  const timestamp = str(record['timestamp']);
  const channel = str(record['type']) ?? 'unknown';
  const payload = isRecord(record['payload']) ? record['payload'] : undefined;
  const payloadType = payload !== undefined ? str(payload['type']) : undefined;
  const known = KNOWN_CHANNELS.has(channel) ? (channel as EntryOrigin['channel']) : undefined;
  const from = origin(line, timestamp, known ?? 'response_item', payloadType);

  if (channel === 'compacted') {
    return { kind: 'compaction', origin: from, ...(str(record['replacement_text']) !== undefined ? { replacementText: str(record['replacement_text'])! } : {}) };
  }
  if (payload === undefined) return { kind: 'unknown', origin: from, payload: record };
  if (channel === 'session_meta') {
    return { kind: 'session-meta', origin: from, meta: parseSessionMeta(payload) };
  }
  if (channel === 'turn_context') {
    return { kind: 'turn-context', origin: from, context: parseTurnContext(payload) };
  }
  if (channel === 'response_item') return classifyResponseItem(payload, from);
  if (channel === 'event_msg') return classifyEventMsg(payload, from);
  return { kind: 'unknown', origin: from, payload: record };
}

/** Content blocks are re-exported for consumers that need the raw shape. */
export type { CodexContentBlock };
