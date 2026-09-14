/**
 * A DSH plugin exposing Codex history and DSH sessions to the agent.
 *
 * The plugin registers three read-only tools. It never writes to either home:
 * the index it reads is built out of process by the `codex-to-dsh` CLI, which
 * keeps the plugin's failure modes small and means a broken index degrades to
 * a clear message rather than to a partial write.
 *
 * Registered at the host plane, so every agent and every agent preset sees the
 * tools. The visibility resolver seeds inheritance from the host-plane tool
 * entries, which is why a host-plane insert reaches preset-scoped agents.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defineTool, type Context, type OutputSpec } from './dsh-types.ts';

export const name = 'codex-history';

/** Declared so `ctx.tools` is readable; an undeclared access throws. */
export const inject = ['tools'] as const;

export interface Config {
  /** Codex home. Defaults to `$CODEX_HOME` or `~/.codex`. */
  readonly codexHome?: string;
  /** Harness home. Defaults to `$DSH_HOME` or `~/.dsh`. */
  readonly dshHome?: string;
  /** Default result cap for searches. */
  readonly maxResults?: number;
}

/** One entry of the rollout index written by the CLI. */
interface RolloutIndexEntry {
  readonly id: string;
  readonly path: string;
  readonly cwd?: string;
  readonly createdAt: number;
  readonly title?: string;
  readonly bytes: number;
  readonly layout: 'dated' | 'archived';
}

interface RolloutIndex {
  readonly version: 1;
  readonly codexHome: string;
  readonly builtAt: number;
  readonly entries: readonly RolloutIndexEntry[];
}

/** One entry of the harness session index. */
interface SessionIndexEntry {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly createdAt: number;
  readonly bytes: number;
  readonly formatVersion: number;
}

const RESULT_SEPARATOR = '\n\n';

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function ago(epochMs: number): string {
  const seconds = Math.max(0, (Date.now() - epochMs) / 1000);
  if (seconds < 90) return 'just now';
  const units: readonly [number, string][] = [
    [31536000, 'year'],
    [2592000, 'month'],
    [604800, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, label] of units) {
    if (seconds >= size) {
      const value = Math.floor(seconds / size);
      return `${value} ${label}${value === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

/**
 * Warn when the index was built against a different Codex home.
 *
 * The index records which home it describes. A stale index from another home
 * produces plausible-looking results pointing at rollout files that are not
 * there, which is worse than an empty result, so the mismatch is surfaced on
 * every call rather than silently tolerated.
 * @param index - a loaded index.
 * @param configuredHome - the home this plugin is configured to describe.
 * @returns a warning line, or an empty string when the two agree.
 */
function stalenessWarning(index: RolloutIndex, configuredHome: string): string {
  if (index.codexHome === configuredHome) return '';
  return `Warning: this index describes ${index.codexHome}, but the plugin is configured for `
    + `${configuredHome}. Re-run: codex-to-dsh index build --codex-home ${configuredHome}\n\n`;
}

/** Read and parse a JSON file, returning `undefined` on any failure. */
async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * Register the plugin's tools.
 * @param ctx - the cordis context; `ctx.tools` is available because of `inject`.
 * @param config - plugin configuration from the patch row.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const codexHome = config.codexHome ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
  const dshHome = config.dshHome ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
  const maxResults = config.maxResults ?? 20;

  const rolloutIndexPath = join(dshHome, 'codex-to-dsh', 'rollout-index.json');
  const sessionIndexPath = join(dshHome, 'codex-to-dsh', 'index.json');

  /** A tool that returns one block of text. */
  const textOutput = <Args,>(): OutputSpec<Args> => ({
    schema: { type: 'string' },
    render: (_args: Args, value: unknown) => [{ type: 'text', text: String(value) }],
  });

  ctx.tools.register(
    defineTool<{ query: string; limit?: number }>({
      name: 'codex_history_search',
      description:
        'Search local Codex session history by prompt text, workspace path, or session id. '
        + 'Use this to find what was worked on previously in Codex. Returns matching sessions '
        + 'newest first. Requires `codex-to-dsh index build` to have been run once.',
      parameters: {
        query: { type: 'string', required: true, description: 'Free text matched against the first prompt, workspace path, and session id.' },
        limit: { type: 'number', description: `Maximum results. Defaults to ${maxResults}.` },
      },
      output: textOutput<{ query: string; limit?: number }>(),
      presentCall: (args) => ({ card: 'generic', title: `codex_history_search ${args.query}`, kind: 'search' }),
      async execute(args: { query: string; limit?: number }, exec) {
        exec.signal.throwIfAborted();
        const index = await readJson<RolloutIndex>(rolloutIndexPath);
        if (index === undefined) {
          return `No Codex history index at ${rolloutIndexPath}.\nRun: codex-to-dsh index build`;
        }
        const stale = stalenessWarning(index, codexHome);

        const needle = args.query.trim().toLowerCase();
        const limit = args.limit ?? maxResults;
        const matches = index.entries
          .filter((entry) =>
            (entry.title ?? '').toLowerCase().includes(needle)
            || (entry.cwd ?? '').toLowerCase().includes(needle)
            || entry.id.toLowerCase().includes(needle))
          .slice(0, limit);

        if (matches.length === 0) {
          return `No Codex sessions match "${args.query}" (searched ${index.entries.length}).${stale}`;
        }

        return stale + matches
          .map((entry) =>
            `${entry.title ?? '(no recorded prompt)'}\n`
            + `  workspace: ${entry.cwd ?? '(none)'}\n`
            + `  when: ${ago(entry.createdAt)}   size: ${human(entry.bytes)}   layout: ${entry.layout}\n`
            + `  id: ${entry.id}`)
          .join(RESULT_SEPARATOR);
      },
    }),
  );

  ctx.tools.register(
    defineTool<{ id: string }>({
      name: 'codex_history_locate',
      description:
        'Resolve one Codex session id to its rollout file path on disk, so its raw JSONL can be '
        + 'read directly with the filesystem tools. Use after codex_history_search.',
      parameters: {
        id: { type: 'string', required: true, description: 'A Codex rollout id or an unambiguous prefix of one.' },
      },
      output: textOutput<{ id: string }>(),
      presentCall: (args) => ({ card: 'generic', title: `codex_history_locate ${args.id}`, kind: 'read' }),
      async execute(args: { id: string }, exec) {
        exec.signal.throwIfAborted();
        const index = await readJson<RolloutIndex>(rolloutIndexPath);
        if (index === undefined) {
          return `No Codex history index at ${rolloutIndexPath}.\nRun: codex-to-dsh index build`;
        }
        const stale = stalenessWarning(index, codexHome);

        const needle = args.id.trim().toLowerCase();
        const exact = index.entries.find((entry) => entry.id.toLowerCase() === needle);
        const matches = exact !== undefined
          ? [exact]
          : index.entries.filter((entry) => entry.id.toLowerCase().startsWith(needle));

        if (matches.length === 0) return `No Codex session matches id "${args.id}".${stale}`;
        if (matches.length > 1) {
          return stale + `"${args.id}" is ambiguous; ${matches.length} sessions start with it:\n`
            + matches.slice(0, 10).map((entry) => `  ${entry.id}  ${entry.title ?? ''}`).join('\n');
        }

        const entry = matches[0]!;
        return stale + `${entry.path}\n  workspace: ${entry.cwd ?? '(none)'}\n  when: ${ago(entry.createdAt)}`
          + `\n  size: ${human(entry.bytes)}\n  title: ${entry.title ?? '(none)'}`;
      },
    }),
  );

  ctx.tools.register(
    defineTool<{ workspace?: string; limit?: number }>({
      name: 'dsh_session_list',
      description:
        'List DeepSeek Harness sessions grouped by workspace, newest first. Use this to see what '
        + 'has been worked on in this harness.',
      parameters: {
        workspace: { type: 'string', description: 'Only sessions whose workspace path contains this text.' },
        limit: { type: 'number', description: 'Maximum workspaces to return. Defaults to 20.' },
      },
      output: textOutput<{ workspace?: string; limit?: number }>(),
      presentCall: () => ({ card: 'generic', title: 'dsh_session_list', kind: 'read' }),
      async execute(args: { workspace?: string; limit?: number }, exec) {
        exec.signal.throwIfAborted();
        const index = await readJson<{ sessions: Record<string, SessionIndexEntry> }>(sessionIndexPath);
        if (index === undefined) {
          return `No session index at ${sessionIndexPath}.\nRun: codex-to-dsh list`;
        }

        const records = Object.values(index.sessions)
          .filter((record) => args.workspace === undefined
            || (record.cwd ?? '').toLowerCase().includes(args.workspace.toLowerCase()))
          .sort((left, right) => right.createdAt - left.createdAt);

        if (records.length === 0) return 'No harness sessions match.';

        const groups = new Map<string, SessionIndexEntry[]>();
        for (const record of records) {
          const key = record.cwd ?? '(no workspace)';
          const bucket = groups.get(key);
          if (bucket === undefined) groups.set(key, [record]);
          else bucket.push(record);
        }

        const ordered = [...groups.entries()]
          .sort((left, right) => (right[1][0]?.createdAt ?? 0) - (left[1][0]?.createdAt ?? 0))
          .slice(0, args.limit ?? 20);

        return `${records.length} sessions in ${groups.size} workspaces\n\n`
          + ordered.map(([cwd, sessions]) =>
            `${cwd}  (${sessions.length} session${sessions.length === 1 ? '' : 's'}, newest ${ago(sessions[0]!.createdAt)})\n`
            + sessions.slice(0, 5).map((session) =>
              `  ${session.sessionId}  ${ago(session.createdAt)}  ${human(session.bytes)}  format v${session.formatVersion}`,
            ).join('\n')).join(RESULT_SEPARATOR);
      },
    }),
  );
}

/** Exported for the plugin manifest's `config` schema, which the host parses. */
export const configDefaults: Required<Config> = {
  codexHome: process.env['CODEX_HOME'] ?? join(homedir(), '.codex'),
  dshHome: process.env['DSH_HOME'] ?? join(homedir(), '.dsh'),
  maxResults: 20,
};
