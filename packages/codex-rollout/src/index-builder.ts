/**
 * A searchable index over a Codex home's rollout history.
 *
 * This is the cheap half of the bridge: it answers "what did I work on, and
 * where" without converting anything. Building it requires reading each
 * rollout once, so the result is cached against `(path, size, mtimeMs)` and a
 * rescan of an unchanged home does no work.
 *
 * The index stores only what a search needs — identity, workspace, timestamps,
 * a title, and per-kind counts. It deliberately does not store message bodies:
 * a body index over 38 GB of rollouts would be a different project, and the
 * title plus workspace is what makes history findable.
 *
 * @module
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { parseRolloutHead } from './read.ts';
import type { RolloutSummary } from './types.ts';

/** One indexed rollout. */
export interface RolloutIndexEntry {
  /** Rollout UUID from the file name and `session_meta`. */
  readonly id: string;
  /** Absolute path to the rollout file. */
  readonly path: string;
  readonly cwd: string | undefined;
  /** From `session_meta.timestamp`, falling back to the file's mtime. */
  readonly createdAt: number;
  /** The first user message, truncated. */
  readonly title: string | undefined;
  readonly bytes: number;
  readonly mtimeMs: number;
  /** `sessions/YYYY/MM/DD` layout or the flat `archived_sessions` layout. */
  readonly layout: 'dated' | 'archived';
  readonly counts: Readonly<Record<string, number>>;
  readonly originator: string | undefined;
  readonly cliVersion: string | undefined;
}

/** The cached index document. */
export interface RolloutIndex {
  readonly version: 1;
  readonly codexHome: string;
  readonly builtAt: number;
  readonly entries: readonly RolloutIndexEntry[];
}

/** Progress reporting for a build that may read thousands of files. */
export interface BuildProgress {
  (event: { readonly phase: 'scan' | 'read' | 'done'; readonly done: number; readonly total: number }): void;
}

/**
 * Enumerate every rollout file under a Codex home.
 *
 * Two layouts exist and both are common: the date-partitioned
 * `sessions/YYYY/MM/DD/rollout-*.jsonl` tree and the flat
 * `archived_sessions/rollout-*.jsonl` directory.
 * @param codexHome - the Codex home directory.
 * @returns rollout paths with the layout each was found in.
 */
export async function listRollouts(
  codexHome: string,
): Promise<{ path: string; layout: 'dated' | 'archived'; bytes: number; mtimeMs: number }[]> {
  const found: { path: string; layout: 'dated' | 'archived'; bytes: number; mtimeMs: number }[] = [];

  const collect = async (dir: string, layout: 'dated' | 'archived', depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        await collect(child, layout, depth + 1);
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        try {
          const info = await stat(child);
          found.push({ path: child, layout, bytes: info.size, mtimeMs: info.mtimeMs });
        } catch {
          // A file that vanished mid-scan is simply not in the index.
        }
      }
    }
  };

  await collect(join(codexHome, 'sessions'), 'dated', 0);
  await collect(join(codexHome, 'archived_sessions'), 'archived', 0);
  return found;
}

/**
 * Tag-delimited blocks Codex injects as `role: "user"` messages.
 *
 * The first user-role message in a rollout is frequently not something the
 * person typed: Codex prepends environment and plugin context. Measured on
 * this machine, taking the first user message verbatim produced titles like
 * `<recommended_plugins> Here is a list of plugins...` for dozens of sessions,
 * which makes the index useless for finding anything.
 */
const INJECTED_PREFIXES = [
  '<environment_context>',
  '<recommended_plugins>',
  '<user_instructions>',
  '<permissions',
  '<INSTRUCTIONS>',
  '<turn_context>',
  '<system',
] as const;

/**
 * Whether a user-role message is harness-injected context rather than a prompt.
 * @param text - the collapsed message text.
 * @returns true when the text opens with a known injected block.
 */
function isInjectedContext(text: string): boolean {
  const lowered = text.toLowerCase();
  return INJECTED_PREFIXES.some((prefix) => lowered.startsWith(prefix.toLowerCase()));
}

/**
 * The first user prompt, collapsed and truncated to a list-friendly title.
 *
 * Skips injected context blocks so the title reflects what the person asked.
 * @param summary - a parsed rollout head.
 * @returns the title, or `undefined` when no genuine prompt appears in the head.
 */
function titleOf(summary: RolloutSummary): string | undefined {
  for (const entry of summary.entries) {
    if (entry.kind !== 'message' || entry.role !== 'user') continue;
    const text = entry.text.trim().replace(/\s+/g, ' ');
    if (text.length === 0 || isInjectedContext(text)) continue;
    return text.length > 140 ? `${text.slice(0, 137)}...` : text;
  }
  return undefined;
}

/**
 * Build or refresh an index over a Codex home.
 *
 * When `previous` is supplied, rollouts whose identity is unchanged keep their
 * entry and are not re-read. That is what makes an incremental refresh
 * practical on a home holding tens of gigabytes of rollouts.
 * @param codexHome - the Codex home directory.
 * @param options - previous index and progress reporting.
 * @returns the index and what the build actually did.
 */
export async function buildRolloutIndex(
  codexHome: string,
  options: { readonly previous?: RolloutIndex; readonly onProgress?: BuildProgress } = {},
): Promise<{ index: RolloutIndex; read: number; reused: number }> {
  const files = await listRollouts(codexHome);
  options.onProgress?.({ phase: 'scan', done: files.length, total: files.length });

  const cached = new Map<string, RolloutIndexEntry>();
  for (const entry of options.previous?.entries ?? []) cached.set(entry.path, entry);

  const entries: RolloutIndexEntry[] = [];
  let read = 0;
  let reused = 0;

  for (const file of files) {
    const hit = cached.get(file.path);
    if (hit !== undefined && hit.bytes === file.bytes && hit.mtimeMs === file.mtimeMs) {
      entries.push(hit);
      reused += 1;
      continue;
    }

    // Bounded head read: enough for the header and the opening user message,
    // and independent of the rollout's size.
    const summary = await parseRolloutHead(file.path);
    const meta = summary.meta;
    entries.push({
      id: meta?.id ?? file.path.replace(/^.*rollout-/, '').replace(/\.jsonl$/, ''),
      path: file.path,
      cwd: meta?.cwd,
      createdAt: Date.parse(meta?.timestamp ?? '') || file.mtimeMs,
      title: titleOf(summary),
      bytes: file.bytes,
      mtimeMs: file.mtimeMs,
      layout: file.layout,
      counts: summary.counts as unknown as Record<string, number>,
      originator: meta?.originator,
      cliVersion: meta?.cliVersion,
    });
    read += 1;
    options.onProgress?.({ phase: 'read', done: read, total: files.length });
  }

  entries.sort((left, right) => right.createdAt - left.createdAt);
  options.onProgress?.({ phase: 'done', done: files.length, total: files.length });

  return {
    index: { version: 1, codexHome, builtAt: Date.now(), entries },
    read,
    reused,
  };
}

/**
 * Search an index by free text against title, workspace, and id.
 *
 * Matching is substring and case-insensitive rather than ranked: the index is
 * meant to answer "which sessions were about this", and a false negative from
 * an over-clever scorer is worse than a slightly long result list.
 * @param index - a built index.
 * @param query - free text.
 * @param limit - maximum results.
 * @returns matching entries, newest first.
 */
export function searchIndex(
  index: RolloutIndex,
  query: string,
  limit = 20,
): RolloutIndexEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return index.entries.slice(0, limit);

  return index.entries
    .filter((entry) =>
      (entry.title ?? '').toLowerCase().includes(needle)
      || (entry.cwd ?? '').toLowerCase().includes(needle)
      || entry.id.toLowerCase().includes(needle))
    .slice(0, limit);
}

/** Total bytes covered by an index. */
export function totalBytes(index: RolloutIndex): number {
  return index.entries.reduce((sum, entry) => sum + entry.bytes, 0);
}
