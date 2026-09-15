/**
 * Codex rollout parsing: the read side of the bridge.
 *
 * A Codex rollout is the append-only JSONL log Codex writes for every session,
 * at `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<uuid>.jsonl` or in
 * the flat `~/.codex/archived_sessions/` directory. Its physical rows are
 * `{ timestamp, type, payload }`: the top-level `type` selects the channel and
 * `payload.type` carries the discriminator that matters.
 *
 * Codex writes the same conversation twice. `response_item` carries the
 * model-facing content; `event_msg` carries UI and lifecycle records and
 * repeats some messages. Both are normalized into one {@link RolloutEntry}
 * union so that no consumer branches on the channel, and
 * {@link dedupeEventChannel} removes the repeats.
 *
 * This module knows nothing about DSH: it is the read side of the bridge, and
 * `synthesize.ts` is the write side.
 *
 * Field names were read from real rollouts rather than inferred. Three are easy
 * to get wrong and are called out where they occur:
 *
 * - `web_search_call` identifies itself with `id`, while its paired
 *   `web_search_end` uses `call_id`.
 * - `reasoning` carries `encrypted_content` — an opaque blob that is 85.2% of
 *   that record's bytes — and its readable text sits in `summary`, which real
 *   rollouts write as `[{ type: 'summary_text', text }]` blocks.
 * - a `function_call_output` writes `output` either as plain text or as a JSON
 *   string of `{ output, metadata }`.
 *
 * @module
 */

import { codexCustomToolArguments } from './arguments.ts';

/** One text-bearing content block as Codex writes it. */
export interface CodexContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly image_url?: string;
}

/** Role values observed in `response_item/message` payloads. */
export type CodexRole = 'user' | 'assistant' | 'developer' | 'system' | 'tool';

/** Fields of `session_meta`, the first row of every rollout. */
export interface CodexSessionMeta {
  readonly id: string;
  readonly timestamp?: string;
  readonly cwd?: string;
  readonly originator?: string;
  readonly cliVersion?: string;
  readonly source?: string;
  readonly modelProvider?: string;
  /** Full base system prompt. Measured at several KB; never carried into DSH. */
  readonly baseInstructions?: string;
}

/** Fields of `turn_context`, emitted once per turn. */
export interface CodexTurnContext {
  readonly cwd?: string;
  readonly model?: string;
  readonly approvalPolicy?: string;
  readonly sandboxPolicy?: string;
  readonly summary?: string;
}

/** How a tool invocation was spelled in the rollout. */
export type ToolCallFlavor = 'function' | 'custom' | 'web_search';

/** Stable identity of one entry in the rollout. */
export interface EntryOrigin {
  /** 1-based line number in the source rollout. */
  readonly line: number;
  /** ISO-8601 timestamp as written by Codex. */
  readonly timestamp?: string;
  /**
   * The physical top-level type this entry was read from: one of Codex's five
   * modelled channels (`session_meta`, `turn_context`, `response_item`,
   * `event_msg`, `compacted`) or a newer name this build does not model. Kept
   * verbatim so an unmodelled channel is never mislabelled as a modelled one.
   */
  readonly channel: string;
  /** `payload.type`, or the top-level type when the payload carries none. */
  readonly payloadType?: string;
}

/** The first row of a rollout. */
export interface SessionMetaEntry {
  readonly kind: 'session-meta';
  readonly origin: EntryOrigin;
  readonly meta: CodexSessionMeta;
}

/** Per-turn context: working directory, model, and policy. */
export interface TurnContextEntry {
  readonly kind: 'turn-context';
  readonly origin: EntryOrigin;
  readonly context: CodexTurnContext;
}

/** A user, assistant, developer, or system message. */
export interface MessageEntry {
  readonly kind: 'message';
  readonly origin: EntryOrigin;
  readonly role: CodexRole;
  readonly text: string;
  /** True when this came from the `event_msg` duplicate channel. */
  readonly fromEventChannel: boolean;
}

/** A tool invocation, in any of the three flavors Codex spells. */
export interface ToolCallEntry {
  readonly kind: 'tool-call';
  readonly origin: EntryOrigin;
  readonly callId: string;
  readonly name: string;
  readonly flavor: ToolCallFlavor;
  /** Argument text, always valid JSON. */
  readonly arguments: string;
}

/** The output of a tool invocation. */
export interface ToolOutputEntry {
  readonly kind: 'tool-output';
  readonly origin: EntryOrigin;
  readonly callId: string;
  readonly output: string;
}

/** A model reasoning record. */
export interface ReasoningEntry {
  readonly kind: 'reasoning';
  readonly origin: EntryOrigin;
  readonly text: string;
  /** True when Codex stored an opaque ciphertext blob beside the text. */
  readonly encrypted: boolean;
}

/** A turn or step boundary derived from an `event_msg` lifecycle record. */
export interface BoundaryEntry {
  readonly kind: 'boundary';
  readonly origin: EntryOrigin;
  readonly phase: 'turn-start' | 'turn-end' | 'turn-aborted' | 'step-end';
}

/** A context compaction, which replays history rather than adding to it. */
export interface CompactionEntry {
  readonly kind: 'compaction';
  readonly origin: EntryOrigin;
  readonly replacementText?: string;
}

/** Token accounting and similar per-call telemetry. */
export interface TelemetryEntry {
  readonly kind: 'telemetry';
  readonly origin: EntryOrigin;
  readonly metrics: Readonly<Record<string, number>>;
}

/** A record this build does not model. Kept so coverage gaps stay visible. */
export interface UnknownEntry {
  readonly kind: 'unknown';
  readonly origin: EntryOrigin;
  readonly payload: unknown;
}

/** One normalized rollout record. */
export type RolloutEntry =
  | SessionMetaEntry
  | TurnContextEntry
  | MessageEntry
  | ToolCallEntry
  | ToolOutputEntry
  | ReasoningEntry
  | BoundaryEntry
  | CompactionEntry
  | TelemetryEntry
  | UnknownEntry;

/** What a parse produced, plus the accounting needed to judge coverage. */
export interface RolloutSummary {
  readonly meta: CodexSessionMeta | undefined;
  readonly entries: readonly RolloutEntry[];
  /** Count per `kind`, over every parsed row rather than the retained tier. */
  readonly counts: Readonly<Record<RolloutEntry['kind'], number>>;
  /** Count per `<channel>/<payloadType>`, including types mapped to `unknown`. */
  readonly seenTypes: Readonly<Record<string, number>>;
  /** Rows that failed to parse, by 1-based line number. */
  readonly errors: readonly { readonly line: number; readonly message: string }[];
}

/** Normalization switches, all defaulting to the narrative tier. */
export interface NormalizeOptions {
  /**
   * Drop `event_msg` messages whose text repeats a nearby `response_item`
   * message. Defaults to `true`; disabling it roughly doubles message count.
   */
  readonly dedupeEventChannel?: boolean;
  /**
   * Keep `reasoning` entries. Their readable part is small, and
   * `encrypted_content` is never retained in any case. Defaults to `true`.
   */
  readonly keepReasoning?: boolean;
  /** Keep `telemetry` entries such as `token_count`. Defaults to `false`. */
  readonly keepTelemetry?: boolean;
  /** Distance in entries within which a duplicate message is recognized. */
  readonly dedupeWindow?: number;
}

interface ResolvedOptions {
  readonly dedupeEventChannel: boolean;
  readonly keepReasoning: boolean;
  readonly keepTelemetry: boolean;
  readonly dedupeWindow: number;
}

function resolve(options: NormalizeOptions | undefined): ResolvedOptions {
  return {
    dedupeEventChannel: options?.dedupeEventChannel ?? true,
    keepReasoning: options?.keepReasoning ?? true,
    keepTelemetry: options?.keepTelemetry ?? false,
    dedupeWindow: options?.dedupeWindow ?? 24,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Join the text blocks of a Codex content array.
 *
 * Codex spells plain text `input_text`, `output_text`, or `text`, and
 * attachments `input_image` / `output_image`; an image becomes a marker rather
 * than disappearing silently.
 * @param content - the raw `content` array, if the payload has one.
 * @param skipHarnessInjections - drop text blocks that begin with `<`, which
 * are harness context (`<environment_context>`, `<user_instructions>`,
 * `<system-reminder>`) rather than something a person typed.
 * @returns the concatenated text.
 */
export function textFromContent(content: unknown, skipHarnessInjections = false): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = str(block['type']);
    const text = str(block['text']);
    if (text !== undefined && (type === 'input_text' || type === 'output_text' || type === 'text')) {
      if (skipHarnessInjections && text.startsWith('<')) continue;
      parts.push(text);
    } else if (type === 'input_image' || type === 'output_image') {
      const url = str(block['image_url']);
      parts.push(`[image${url !== undefined ? `: ${url}` : ''}]`);
    }
  }
  return parts.join('\n');
}

/**
 * The readable text of a `reasoning` record.
 *
 * `encrypted_content` is opaque outside OpenAI's own systems and is 85.2% of
 * the record's bytes, so it is never read. The readable text sits in `summary`
 * (real rollouts write `[{ type: 'summary_text', text }]` blocks; a plain
 * string is accepted too) and occasionally in `content`.
 * @param payload - the `response_item` payload.
 * @returns the readable text, empty when the record carries none.
 */
function reasoningText(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = textFromContent(payload['content']).trim();
  if (content.length > 0) parts.push(content);
  const summary = payload['summary'];
  if (typeof summary === 'string') {
    if (summary.trim().length > 0) parts.push(summary.trim());
  } else if (Array.isArray(summary)) {
    for (const block of summary) {
      if (!isRecord(block)) continue;
      const text = str(block['text']);
      if (text !== undefined && text.trim().length > 0) parts.push(text.trim());
    }
  }
  return parts.join('\n');
}

/**
 * The readable text of a tool output.
 *
 * `output` is either plain text or a JSON string of `{ output, metadata }`,
 * where the metadata carries exit codes and durations. The readable part is
 * unwrapped; anything else is kept as written.
 * @param value - the raw `output` field.
 * @returns the output text.
 */
function toolOutputText(value: unknown): string {
  if (typeof value === 'string') {
    if (value.trim().startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (isRecord(parsed) && typeof parsed['output'] === 'string') return parsed['output'];
      } catch {
        // Plain text that merely starts with a brace.
      }
    }
    return value;
  }
  if (isRecord(value) && typeof value['output'] === 'string') return value['output'];
  return value === undefined || value === null ? '' : JSON.stringify(value);
}

/** Argument text for a tool call: JSON as written, or JSON-encoded when absent. */
function jsonArguments(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? {});
}

/** Normalize an unknown role string. */
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
  const timestamp = str(payload['timestamp']);
  const cwd = str(payload['cwd']);
  const originator = str(payload['originator']);
  const cliVersion = str(payload['cli_version']);
  const source = str(payload['source']);
  const modelProvider = str(payload['model_provider']);
  return {
    id: str(payload['id']) ?? '',
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(originator !== undefined ? { originator } : {}),
    ...(cliVersion !== undefined ? { cliVersion } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(modelProvider !== undefined ? { modelProvider } : {}),
    ...(base !== undefined && str(base['text']) !== undefined ? { baseInstructions: str(base['text'])! } : {}),
  };
}

function parseTurnContext(payload: Record<string, unknown>): CodexTurnContext {
  const sandbox = isRecord(payload['sandbox_policy']) ? payload['sandbox_policy'] : undefined;
  const cwd = str(payload['cwd']);
  const model = str(payload['model']);
  const approvalPolicy = str(payload['approval_policy']);
  const sandboxPolicy = sandbox !== undefined ? str(sandbox['mode']) : undefined;
  const summary = str(payload['summary']);
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
    ...(sandboxPolicy !== undefined ? { sandboxPolicy } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

function origin(
  line: number,
  timestamp: string | undefined,
  channel: string,
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
    case 'message': {
      const entryRole = role(payload['role']);
      return {
        kind: 'message',
        origin: from,
        role: entryRole,
        // Harness injections arrive as user-role `input_text` blocks; they are
        // not human input and must not become prompts in a downstream view.
        text: textFromContent(payload['content'], entryRole === 'user'),
        fromEventChannel: false,
      };
    }

    case 'function_call':
      return {
        kind: 'tool-call',
        origin: from,
        callId: str(payload['call_id']) ?? '',
        name: str(payload['name']) ?? 'unknown',
        flavor: 'function' satisfies ToolCallFlavor,
        arguments: jsonArguments(payload['arguments']),
      };

    case 'custom_tool_call': {
      // `input` is free-form; see `arguments.ts` for why it is not passed through.
      const converted = codexCustomToolArguments(payload['input']);
      return {
        kind: 'tool-call',
        origin: from,
        callId: str(payload['call_id']) ?? '',
        name: str(payload['name']) ?? 'unknown',
        flavor: 'custom' satisfies ToolCallFlavor,
        arguments: converted.arguments,
      };
    }

    case 'function_call_output':
    case 'custom_tool_call_output':
      return {
        kind: 'tool-output',
        origin: from,
        callId: str(payload['call_id']) ?? '',
        output: toolOutputText(payload['output']),
      };

    case 'tool_search_call':
      return {
        kind: 'tool-call',
        origin: from,
        callId: str(payload['call_id']) ?? '',
        name: 'tool_search',
        flavor: 'function' satisfies ToolCallFlavor,
        arguments: jsonArguments(payload['arguments']),
      };

    case 'tool_search_output':
      return {
        kind: 'tool-output',
        origin: from,
        callId: str(payload['call_id']) ?? '',
        output: JSON.stringify(payload['tools'] ?? null),
      };

    case 'web_search_call':
      // This record names itself with `id`; the paired `web_search_end` uses
      // `call_id`. Reading the wrong one leaves the result silently unpaired.
      return {
        kind: 'tool-call',
        origin: from,
        callId: str(payload['id']) ?? str(payload['call_id']) ?? '',
        name: 'web_search',
        flavor: 'web_search' satisfies ToolCallFlavor,
        arguments: JSON.stringify(payload['action'] ?? null),
      };

    case 'reasoning':
      return {
        kind: 'reasoning',
        origin: from,
        text: reasoningText(payload),
        encrypted: str(payload['encrypted_content']) !== undefined,
      };

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
 * `user_message` and `agent_message` repeat content already present on the
 * `response_item` channel; they are marked rather than dropped so that
 * {@link dedupeEventChannel} can decide.
 * @param payload - the `payload` object.
 * @param from - origin fields already extracted.
 * @returns the normalized entry.
 */
function classifyEventMsg(payload: Record<string, unknown>, from: EntryOrigin): RolloutEntry {
  switch (payload['type']) {
    case 'user_message': {
      const text = str(payload['message']) ?? '';
      return {
        kind: 'message',
        origin: from,
        role: 'user',
        text: text.startsWith('<') ? '' : text,
        fromEventChannel: true,
      };
    }

    case 'agent_message':
      return {
        kind: 'message',
        origin: from,
        role: 'assistant',
        text: str(payload['message']) ?? '',
        fromEventChannel: true,
      };

    case 'agent_reasoning':
      return { kind: 'reasoning', origin: from, text: str(payload['text']) ?? '', encrypted: false };

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
 * dropped, so a new Codex release shows up as a coverage gap instead of silent
 * data loss.
 * @param record - one parsed JSONL row.
 * @param line - 1-based line number, used for ordering and reporting.
 * @returns the normalized entry.
 */
export function classifyRecord(record: unknown, line: number): RolloutEntry {
  if (!isRecord(record)) {
    return { kind: 'unknown', origin: origin(line, undefined, 'unknown', undefined), payload: record };
  }

  const timestamp = str(record['timestamp']);
  const channel = str(record['type']) ?? 'unknown';
  const payload = isRecord(record['payload']) ? record['payload'] : undefined;
  const payloadType = payload !== undefined ? str(payload['type']) : undefined;
  const from = origin(line, timestamp, channel, payloadType);

  if (channel === 'compacted') {
    const replacement = str(record['replacement_text']) ?? (payload !== undefined ? str(payload['replacement_text']) : undefined);
    return { kind: 'compaction', origin: from, ...(replacement !== undefined ? { replacementText: replacement } : {}) };
  }
  if (payload === undefined) return { kind: 'unknown', origin: from, payload: record };
  if (channel === 'session_meta') return { kind: 'session-meta', origin: from, meta: parseSessionMeta(payload) };
  if (channel === 'turn_context') return { kind: 'turn-context', origin: from, context: parseTurnContext(payload) };
  if (channel === 'response_item') return classifyResponseItem(payload, from);
  if (channel === 'event_msg') return classifyEventMsg(payload, from);
  return { kind: 'unknown', origin: from, payload: record };
}

/**
 * Drop the `event_msg` copies of messages that also appear on the response channel.
 *
 * Codex writes each user and agent message twice. On the synthetic fixture this
 * removes 2 of 7 messages; keeping both duplicates the conversation in any
 * downstream view.
 *
 * The match is by role and exact text within a bounded window, because the two
 * channels interleave rather than align.
 * @param entries - classified entries in file order.
 * @param window - how many neighbouring entries to search, in each direction.
 * @returns entries with duplicates removed, order preserved.
 */
export function dedupeEventChannel(entries: readonly RolloutEntry[], window: number): RolloutEntry[] {
  const canonical: number[] = [];
  entries.forEach((entry, index) => {
    if (entry.kind === 'message' && !entry.fromEventChannel) canonical.push(index);
  });

  const isDuplicate = (entry: MessageEntry, index: number): boolean => {
    if (entry.text.length === 0) return false;
    for (const candidate of canonical) {
      if (Math.abs(candidate - index) > window) continue;
      const other = entries[candidate];
      if (other?.kind !== 'message') continue;
      if (other.role === entry.role && other.text === entry.text) return true;
    }
    return false;
  };

  return entries.filter((entry, index) => {
    if (entry.kind !== 'message' || !entry.fromEventChannel) return true;
    return !isDuplicate(entry, index);
  });
}

/** Apply the tier switches to classified entries. */
function applyTier(entries: readonly RolloutEntry[], options: ResolvedOptions): RolloutEntry[] {
  const deduped = options.dedupeEventChannel ? dedupeEventChannel(entries, options.dedupeWindow) : [...entries];

  return deduped.filter((entry) => {
    if (entry.kind === 'reasoning' && !options.keepReasoning) return false;
    if (entry.kind === 'telemetry' && !options.keepTelemetry) return false;
    return true;
  });
}

function emptyCounts(): Record<RolloutEntry['kind'], number> {
  return {
    'session-meta': 0,
    'turn-context': 0,
    message: 0,
    'tool-call': 0,
    'tool-output': 0,
    reasoning: 0,
    boundary: 0,
    compaction: 0,
    telemetry: 0,
    unknown: 0,
  };
}

/**
 * Feed already-classified entries into a summary accumulator.
 * @param entries - entries in file order.
 * @param options - tier switches.
 * @returns the summary.
 */
export function summarize(entries: readonly RolloutEntry[], options?: NormalizeOptions): RolloutSummary {
  const resolved = resolve(options);
  const kept = applyTier(entries, resolved);

  const counts = emptyCounts();
  const seenTypes: Record<string, number> = {};
  let meta: CodexSessionMeta | undefined;

  for (const entry of entries) {
    counts[entry.kind] += 1;
    const key = `${entry.origin.channel}/${entry.origin.payloadType ?? '-'}`;
    seenTypes[key] = (seenTypes[key] ?? 0) + 1;
    if (entry.kind === 'session-meta' && meta === undefined) meta = entry.meta;
  }

  return { meta, entries: kept, counts, seenTypes, errors: [] };
}

/**
 * Parse rollout text that is already in memory.
 *
 * A malformed row is recorded in {@link RolloutSummary.errors} and skipped; one
 * corrupt line must not invalidate an otherwise readable session.
 * @param text - full rollout contents.
 * @param options - tier switches.
 * @returns the summary.
 */
export function parseRolloutText(text: string, options?: NormalizeOptions): RolloutSummary {
  const entries: RolloutEntry[] = [];
  const errors: { line: number; message: string }[] = [];
  const lines = text.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) continue;
    try {
      entries.push(classifyRecord(JSON.parse(line), index + 1));
    } catch (error) {
      errors.push({ line: index + 1, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const summary = summarize(entries, options);
  return { ...summary, errors };
}
