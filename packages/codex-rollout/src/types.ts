/**
 * Normalized intermediate representation of a Codex rollout.
 *
 * A Codex rollout is a JSONL file whose physical rows are
 * `{ timestamp, type, payload }`. The `type` field takes only five values,
 * while `payload.type` carries the semantically meaningful discriminator.
 * Measured on 300 files / 122,018 rows:
 *
 * | top-level type  | rows   |
 * | --------------- | ------ |
 * | `response_item` | 69,202 |
 * | `event_msg`     | 44,607 |
 * | `turn_context`  |  7,921 |
 * | `session_meta`  |    244 |
 * | `compacted`     |     44 |
 *
 * This module normalizes both channels into one `RolloutEntry` union so that
 * downstream consumers never branch on the physical channel.
 *
 * @module
 */

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
  /** Full base system prompt. Measured at several KB; dropped by default. */
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
  /** The physical channel this entry was read from. */
  readonly channel: 'response_item' | 'event_msg' | 'turn_context' | 'session_meta' | 'compacted';
  /** `payload.type`, or the top-level type when the payload carries none. */
  readonly payloadType?: string;
}

export interface SessionMetaEntry {
  readonly kind: 'session-meta';
  readonly origin: EntryOrigin;
  readonly meta: CodexSessionMeta;
}

export interface TurnContextEntry {
  readonly kind: 'turn-context';
  readonly origin: EntryOrigin;
  readonly context: CodexTurnContext;
}

export interface MessageEntry {
  readonly kind: 'message';
  readonly origin: EntryOrigin;
  readonly role: CodexRole;
  readonly text: string;
  /** True when this came from the `event_msg` duplicate channel. */
  readonly fromEventChannel: boolean;
}

export interface ToolCallEntry {
  readonly kind: 'tool-call';
  readonly origin: EntryOrigin;
  readonly callId: string;
  readonly name: string;
  readonly flavor: ToolCallFlavor;
  /** Raw argument string exactly as Codex wrote it. */
  readonly arguments: string;
}

export interface ToolOutputEntry {
  readonly kind: 'tool-output';
  readonly origin: EntryOrigin;
  readonly callId: string;
  readonly output: string;
}

export interface ReasoningEntry {
  readonly kind: 'reasoning';
  readonly origin: EntryOrigin;
  readonly text: string;
  /** Codex stores encrypted reasoning as an opaque blob, not text. */
  readonly encrypted: boolean;
}

/** A turn or step boundary, derived from `event_msg` lifecycle records. */
export interface BoundaryEntry {
  readonly kind: 'boundary';
  readonly origin: EntryOrigin;
  readonly phase: 'turn-start' | 'turn-end' | 'turn-aborted' | 'step-end';
}

export interface CompactionEntry {
  readonly kind: 'compaction';
  readonly origin: EntryOrigin;
  readonly replacementText?: string;
}

/** Token accounting and similar per-call telemetry. Dropped in the narrative tier. */
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
  /** Count per `kind`, for coverage reporting. */
  readonly counts: Readonly<Record<RolloutEntry['kind'], number>>;
  /** Count per `<channel>/<payloadType>`, including types mapped to `unknown`. */
  readonly seenTypes: Readonly<Record<string, number>>;
  /** Rollout files that failed to parse and were skipped. */
  readonly errors: readonly { readonly line: number; readonly message: string }[];
}
