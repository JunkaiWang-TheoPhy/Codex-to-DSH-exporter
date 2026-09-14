/**
 * Codex rollout parsing.
 *
 * A Codex rollout is the append-only JSONL log that Codex writes for every
 * session, at `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<uuid>.jsonl`
 * or in the flat `~/.codex/archived_sessions/` directory.
 *
 * This package reads those files and normalizes them into a single entry union.
 * It deliberately knows nothing about DSH: it is the read side of the bridge,
 * and the same IR feeds the history index and the (design-only) session
 * converter.
 *
 * ```ts
 * import { parseRolloutFile } from '@codex-to-dsh/codex-rollout';
 *
 * const summary = await parseRolloutFile('/path/to/rollout-....jsonl');
 * console.log(summary.meta?.cwd, summary.counts.message);
 * ```
 *
 * @module
 */

export { classifyRecord, textFromContent } from './classify.ts';
export {
  buildRolloutIndex,
  listRollouts,
  searchIndex,
  totalBytes,
  type BuildProgress,
  type RolloutIndex,
  type RolloutIndexEntry,
} from './index-builder.ts';
export { dedupeEventChannel, parseRolloutFile, parseRolloutHead, parseRolloutText, summarize } from './read.ts';
export type { NormalizeOptions } from './read.ts';
export type {
  BoundaryEntry,
  CodexContentBlock,
  CodexRole,
  CodexSessionMeta,
  CodexTurnContext,
  CompactionEntry,
  EntryOrigin,
  MessageEntry,
  ReasoningEntry,
  RolloutEntry,
  RolloutSummary,
  SessionMetaEntry,
  TelemetryEntry,
  ToolCallEntry,
  ToolCallFlavor,
  ToolOutputEntry,
  TurnContextEntry,
  UnknownEntry,
} from './types.ts';
