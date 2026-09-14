/**
 * Streaming rollout reading and duplicate suppression.
 *
 * Rollouts reach 206 MB on this machine, so reading is line-oriented and never
 * materializes the whole file as one string.
 *
 * @module
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { classifyRecord } from './classify.ts';
import type {
  CodexSessionMeta,
  MessageEntry,
  RolloutEntry,
  RolloutSummary,
} from './types.ts';

/** Normalization switches, all defaulting to the narrative tier. */
export interface NormalizeOptions {
  /**
   * Drop `event_msg` messages whose text repeats a nearby `response_item`
   * message. Defaults to `true`; disabling it roughly doubles message count.
   */
  readonly dedupeEventChannel?: boolean;
  /**
   * Keep `reasoning` entries. Their readable part is small, but
   * `encrypted_content` is not retained in any case.
   */
  readonly keepReasoning?: boolean;
  /** Keep `telemetry` entries such as `token_count`. 2.8% of bytes. */
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

/**
 * Drop the `event_msg` copies of messages that also appear on the response channel.
 *
 * Codex writes each user and agent message twice. Measured across the sample,
 * `event_msg/user_message` is 4.3% of bytes and `response_item/message` 5.6%;
 * keeping both duplicates the conversation in any downstream view.
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

/**
 * Normalize classified entries according to the tier switches.
 * @param entries - classified entries in file order.
 * @param options - resolved tier switches.
 * @returns the retained entries.
 */
function applyTier(entries: readonly RolloutEntry[], options: ResolvedOptions): RolloutEntry[] {
  const deduped = options.dedupeEventChannel
    ? dedupeEventChannel(entries, options.dedupeWindow)
    : [...entries];

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
 * Malformed rows are recorded in {@link RolloutSummary.errors} and skipped;
 * one corrupt line must not invalidate an otherwise readable session.
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

/**
 * Read only the head of a rollout file.
 *
 * An index needs the header and the opening user message, both of which sit in
 * the first few kilobytes. Fully parsing every rollout is not viable: this
 * machine's Codex home holds 5,533 rollouts totalling 38 GB with a 206 MB
 * maximum, and a full parse of the whole home did not finish in 60 seconds.
 *
 * The read stops at whichever bound is reached first, so the cost per file is
 * bounded regardless of the file's size.
 * @param path - rollout file path.
 * @param options - byte and line ceilings.
 * @returns the summary of whatever prefix was read, plus whether it was truncated.
 */
export async function parseRolloutHead(
  path: string,
  options: { readonly maxBytes?: number; readonly maxLines?: number; readonly normalize?: NormalizeOptions } = {},
): Promise<RolloutSummary & { readonly truncated: boolean }> {
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const maxLines = options.maxLines ?? 400;

  const chunks: string[] = [];
  let bytes = 0;
  let lines = 0;
  let truncated = false;

  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const text of reader) {
      bytes += Buffer.byteLength(text, 'utf8') + 1;
      chunks.push(text);
      lines += 1;
      if (bytes >= maxBytes || lines >= maxLines) {
        truncated = true;
        break;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  const summary = parseRolloutText(chunks.join('\n'), options.normalize);
  return { ...summary, truncated };
}

/**
 * Stream one rollout file into a summary.
 *
 * Peak memory is bounded by the entry list, not the file size, so the 206 MB
 * rollouts on this machine are safe.
 * @param path - rollout file path.
 * @param options - tier switches.
 * @returns the summary.
 */
export async function parseRolloutFile(
  path: string,
  options?: NormalizeOptions,
): Promise<RolloutSummary> {
  const entries: RolloutEntry[] = [];
  const errors: { line: number; message: string }[] = [];
  const stream = createReadStream(path, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  let line = 0;
  for await (const text of reader) {
    line += 1;
    if (text.trim().length === 0) continue;
    try {
      entries.push(classifyRecord(JSON.parse(text), line));
    } catch (error) {
      errors.push({ line, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const summary = summarize(entries, options);
  return { ...summary, errors };
}
