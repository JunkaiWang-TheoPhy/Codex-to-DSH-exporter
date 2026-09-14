#!/usr/bin/env node
/**
 * `codex-to-dsh` — inspect a Codex environment, manage DSH sessions, and
 * (design-only) convert Codex rollout history into DSH session artifacts.
 *
 * Writing is off by default on every command that could touch data. The
 * `import` subcommand has no `--apply` flag at all: session conversion is
 * implemented as a library and covered by tests, but this project's current
 * phase deliberately exposes no path from a real `~/.codex` tree into
 * `~/.dsh`. See `docs/design.md`.
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  buildRolloutIndex,
  parseRolloutFile,
  parseRolloutText,
  searchIndex,
  totalBytes,
} from '@codex-to-dsh/codex-rollout';
import {
  DEFAULT_MAPPING,
  sessionArtifactPath,
  synthesizeSession,
  verifyArtifact,
} from '@codex-to-dsh/dsh-session-artifact';
import { SessionStore, exportBundle, verifyBundle } from '@codex-to-dsh/dsh-session-store';

const USAGE = `codex-to-dsh — bridge a Codex environment and its history into the DeepSeek Harness

Usage
  codex-to-dsh <command> [options]

Commands
  env        Inventory a Codex home: configuration, skills, prompts, hooks, rules, plugins
  mapping    Print the Codex-to-DSH event mapping table
  list       List DSH sessions, grouped by workspace
  search     Search DSH sessions by title, id, or workspace
  export     Copy selected DSH sessions into a portable bundle
  bundle     Verify a session bundle without importing it
  trash      List, restore, or empty the session trash
  index      Build or search a searchable index over the Codex rollout history
  convert    Convert one Codex rollout and print the artifact, without writing it
  doctor     Report the state of both homes and any generation drift

Common options
  --codex-home <path>   Codex home (default: $CODEX_HOME or ~/.codex)
  --dsh-home <path>     Harness home (default: $DSH_HOME or ~/.dsh)
  --json                Emit machine-readable JSON
  --help                Show this help

Exit codes
  0  success
  1  usage error
  2  a check failed
`;

interface Args {
  readonly command: string | undefined;
  readonly positionals: string[];
  readonly flags: Map<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  let command: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2);
      if (name === undefined) continue;
      if (inline !== undefined) {
        flags.set(name, inline);
      } else {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(name, next);
          index += 1;
        } else {
          flags.set(name, true);
        }
      }
    } else if (command === undefined) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

const codexHome = (args: Args): string =>
  String(args.flags.get('codex-home') ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex'));
const dshHome = (args: Args): string =>
  String(args.flags.get('dsh-home') ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh'));

const bold = (text: string): string => `\u001b[1m${text}\u001b[0m`;
const dim = (text: string): string => `\u001b[2m${text}\u001b[0m`;

/** Render a byte count for a human reader. */
function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Render a relative age the way a session list does. */
function ago(epochMs: number): string {
  const seconds = Math.max(0, (Date.now() - epochMs) / 1000);
  if (seconds < 90) return 'just now';
  const units: readonly [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
    [2592000, 'month'],
    [31536000, 'year'],
  ];
  let chosen: [number, string] = units[0]!;
  for (const unit of units) if (seconds >= unit[0]) chosen = unit;
  const value = Math.floor(seconds / chosen[0]);
  return `${value} ${chosen[1]}${value === 1 ? '' : 's'} ago`;
}

async function countDir(path: string): Promise<number> {
  try {
    return (await readdir(path)).length;
  } catch {
    return 0;
  }
}

async function dirSize(path: string): Promise<number> {
  let total = 0;
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) total += await dirSize(child);
      else if (entry.isFile()) total += (await stat(child)).size;
    }
  } catch {
    // An unreadable subtree contributes nothing rather than failing the report.
  }
  return total;
}

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

/** Surfaces a Codex home presents, and which of them this project addresses. */
const ENV_SURFACES: readonly { readonly name: string; readonly path: string; readonly note: string }[] = [
  { name: 'instructions', path: 'AGENTS.md', note: 'user-global instructions; DSH reads ~/.dsh/AGENTS.md' },
  { name: 'config', path: 'config.toml', note: 'model, providers, MCP servers, project trust' },
  { name: 'hooks', path: 'hooks.json', note: 'DSH already bridges these via @deepseek-ai/dsh-hooks-codex' },
  { name: 'rules', path: 'rules', note: 'command allow-list; DSH uses permission presets' },
  { name: 'skills', path: 'skills', note: 'agent skills; DSH discovers ~/.agents/skills and ~/.dsh/skills' },
  { name: 'prompts', path: 'prompts', note: 'reusable prompt files' },
  { name: 'agents', path: 'agents', note: 'subagent definitions' },
  { name: 'plugins', path: 'plugins', note: 'installed plugin payloads' },
  { name: 'sessions', path: 'sessions', note: 'rollout history; the L2 conversion source' },
  { name: 'archived_sessions', path: 'archived_sessions', note: 'flat archived rollouts' },
];

async function commandEnv(args: Args): Promise<number> {
  const home = codexHome(args);
  if (!existsSync(home)) {
    process.stderr.write(`no Codex home at ${home}\n`);
    return 2;
  }

  const rows: { surface: string; path: string; present: boolean; size: number; entries: number; note: string }[] = [];
  for (const surface of ENV_SURFACES) {
    const path = join(home, surface.path);
    const present = existsSync(path);
    const info = present ? await stat(path) : undefined;
    const isDir = info?.isDirectory() ?? false;
    rows.push({
      surface: surface.name,
      path: surface.path,
      present,
      size: present ? (isDir ? await dirSize(path) : info!.size) : 0,
      entries: present && isDir ? await countDir(path) : 0,
      note: surface.note,
    });
  }

  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify({ codexHome: home, surfaces: rows }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${bold('Codex home')} ${home}\n\n`);
  process.stdout.write(`${dim('surface'.padEnd(20))}${dim('present'.padEnd(9))}${dim('size'.padEnd(11))}${dim('entries')}\n`);
  for (const row of rows) {
    process.stdout.write(
      `${row.surface.padEnd(20)}${(row.present ? 'yes' : '-').padEnd(9)}${(row.present ? human(row.size) : '-').padEnd(11)}${row.entries || ''}\n`,
    );
  }
  process.stdout.write(`\n${bold('What this project addresses')}\n`);
  for (const row of rows) {
    process.stdout.write(`  ${row.surface.padEnd(20)} ${dim(row.note)}\n`);
  }
  process.stdout.write(
    `\nL1 (environment) and L3 (history index) are implemented. L2 (rollout conversion)\n`
    + `is implemented as a library and covered by tests, but no command writes to a real home.\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// mapping
// ---------------------------------------------------------------------------

function commandMapping(args: Args): number {
  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify(DEFAULT_MAPPING, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${bold('Codex event')} -> ${bold('DSH treatment')}\n\n`);
  const rows = Object.entries(DEFAULT_MAPPING).sort(([a], [b]) => a.localeCompare(b));
  for (const [source, treatment] of rows) {
    const target = treatment.kind === 'drop' ? `drop (${treatment.reason})`
      : treatment.kind === 'preserve' ? `preserve as ${treatment.as}`
        : `translate to ${treatment.into}`;
    process.stdout.write(`  ${source.padEnd(38)} ${target}\n`);
  }
  process.stdout.write(
    `\nEvents DSH does not recognize are emitted with \`ignorable: true\`, which is what\n`
    + `lets the surface fold step over them. See docs/mapping.md for the structural\n`
    + `invariants the installed validator enforces.\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// list / search
// ---------------------------------------------------------------------------

async function loadStore(args: Args, json: boolean): Promise<SessionStore> {
  const store = new SessionStore({ home: dshHome(args) });
  const scan = await store.refresh();
  await store.saveIndex();
  if (!json && scan.read > 0) {
    process.stderr.write(dim(`indexed ${scan.scanned} sessions (${scan.read} read, ${scan.removed} removed)\n`));
  }
  return store;
}

function commandList(args: Args, store: SessionStore): number {
  const groups = store.workspaces();
  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify(groups.map((group) => ({
      cwd: group.cwd,
      label: group.label,
      latest: group.latest,
      sessions: group.sessions.map((session) => ({
        id: session.sessionId,
        createdAt: session.createdAt,
        bytes: session.bytes,
        formatVersion: session.formatVersion,
      })),
    })), null, 2)}\n`);
    return 0;
  }

  if (groups.length === 0) {
    process.stdout.write('no sessions\n');
    return 0;
  }

  const total = groups.reduce((sum, group) => sum + group.sessions.length, 0);
  process.stdout.write(`${bold(String(total))} sessions in ${bold(String(groups.length))} workspaces\n\n`);
  for (const group of groups) {
    process.stdout.write(`${group.label}  ${dim(`${group.sessions.length} session${group.sessions.length === 1 ? '' : 's'} · ${ago(group.latest)}`)}\n`);
    process.stdout.write(`${dim(`  ${group.cwd ?? '(no workspace)'}`)}\n`);
    for (const session of group.sessions.slice(0, 3)) {
      process.stdout.write(`    ${session.sessionId}  ${dim(`${ago(session.createdAt)} · ${human(session.bytes)}`)}\n`);
    }
    if (group.sessions.length > 3) {
      process.stdout.write(dim(`    ... ${group.sessions.length - 3} more\n`));
    }
  }
  return 0;
}

function commandSearch(args: Args, store: SessionStore): number {
  const text = args.positionals.join(' ');
  const results = store.search({ text, limit: 50 });

  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }
  if (results.length === 0) {
    process.stdout.write(`no sessions match "${text}"\n`);
    return 0;
  }
  process.stdout.write(`${bold(String(results.length))} match${results.length === 1 ? '' : 'es'} for "${text}"\n\n`);
  for (const session of results) {
    process.stdout.write(`${session.sessionId}\n  ${dim(`${session.cwd ?? '(no workspace)'} · ${ago(session.createdAt)} · ${human(session.bytes)}`)}\n`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// export / bundle / trash
// ---------------------------------------------------------------------------

async function commandExport(args: Args, store: SessionStore): Promise<number> {
  const outIndex = args.positionals.findIndex((value) => value === '--out');
  void outIndex;
  const out = String(args.flags.get('out') ?? join(store.root, '..', 'session-bundle'));
  const ids = args.positionals.filter((value) => value !== '--out');

  const selected = ids.length > 0 ? ids : store.all().map((session) => session.sessionId);
  if (selected.length === 0) {
    process.stderr.write('nothing to export\n');
    return 2;
  }

  const manifest = await exportBundle(store, selected, resolve(out));
  process.stdout.write(`exported ${manifest.entries.length} session(s) to ${resolve(out)}\n`);
  for (const entry of manifest.entries) {
    process.stdout.write(`  ${entry.sessionId}  ${dim(`${human(entry.bytes)}  sha256 ${entry.sha256.slice(0, 12)}…`)}\n`);
  }
  return 0;
}

async function commandBundle(args: Args): Promise<number> {
  const target = args.positionals[0];
  if (target === undefined) {
    process.stderr.write('bundle requires a bundle directory\n');
    return 1;
  }
  const report = await verifyBundle(resolve(target));
  for (const result of report.results) {
    process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} ${result.sessionId}  ${dim(result.detail)}\n`);
  }
  process.stdout.write(`\n${report.ok ? 'bundle verified' : 'bundle FAILED verification'}\n`);
  return report.ok ? 0 : 2;
}

async function commandTrash(args: Args, store: SessionStore): Promise<number> {
  const action = args.positionals[0] ?? 'list';

  if (action === 'list') {
    const entries = await store.listTrash();
    if (entries.length === 0) {
      process.stdout.write('the trash is empty\n');
      return 0;
    }
    process.stdout.write(`${bold(String(entries.length))} trashed session(s)\n\n`);
    for (const entry of entries) {
      process.stdout.write(`${entry.sessionId}\n  ${dim(`${entry.cwd ?? '(no workspace)'} · trashed ${ago(entry.trashedAt)}`)}\n`);
    }
    return 0;
  }

  if (action === 'restore') {
    const restored = await store.restore(args.positionals.slice(1));
    process.stdout.write(`restored ${restored} session(s)\n`);
    return 0;
  }

  if (action === 'empty') {
    const count = await store.listTrash().then((entries) => entries.length);
    process.stdout.write(`about to permanently delete ${count} trashed session(s).\n`);
    process.stdout.write('this is the only destructive operation in this tool and it is not reversible.\n');
    if (args.flags.get('yes') !== true) {
      process.stdout.write('re-run with --yes to proceed\n');
      return 2;
    }
    process.stdout.write(`deleted ${await store.emptyTrash()} session(s)\n`);
    return 0;
  }

  process.stderr.write(`unknown trash action "${action}"; use list, restore, or empty\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

/** Where the Codex history index lives. Always under the harness home, never in the Codex home. */
function indexPath(args: Args): string {
  return join(dshHome(args), 'codex-to-dsh', 'rollout-index.json');
}

async function loadRolloutIndex(args: Args): Promise<import('@codex-to-dsh/codex-rollout').RolloutIndex | undefined> {
  const path = indexPath(args);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function commandIndex(args: Args): Promise<number> {
  const action = args.positionals[0] ?? 'search';
  const home = codexHome(args);

  if (action === 'build') {
    if (!existsSync(home)) {
      process.stderr.write(`no Codex home at ${home}\n`);
      return 2;
    }
    const previous = await loadRolloutIndex(args);
    const started = Date.now();
    const { index, read, reused } = await buildRolloutIndex(home, { ...(previous !== undefined ? { previous } : {}) });

    const path = indexPath(args);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(index)}\n`, 'utf8');

    const summary = {
      codexHome: home,
      rollouts: index.entries.length,
      read,
      reused,
      totalBytes: totalBytes(index),
      indexedAt: path,
      elapsedMs: Date.now() - started,
    };
    if (args.flags.get('json') === true) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`${bold('Codex history index')} ${path}\n\n`);
    process.stdout.write(`  rollouts    ${summary.rollouts}\n`);
    process.stdout.write(`  read        ${read}${reused > 0 ? dim(`  (${reused} reused from the previous index)`) : ''}\n`);
    process.stdout.write(`  covered     ${human(summary.totalBytes)}\n`);
    process.stdout.write(`  elapsed     ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
    process.stdout.write(
      `\n${dim('The index stores identity, workspace, title and counts — not message bodies.')}\n`,
    );
    return 0;
  }

  const index = await loadRolloutIndex(args);
  if (index === undefined) {
    process.stderr.write(`no index at ${indexPath(args)}; run "codex-to-dsh index build" first\n`);
    return 2;
  }

  const query = action === 'search' ? args.positionals.slice(1).join(' ') : args.positionals.join(' ');
  const results = searchIndex(index, query, 30);

  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }
  if (results.length === 0) {
    process.stdout.write(`no rollouts match "${query}"\n`);
    return 0;
  }
  process.stdout.write(`${bold(String(results.length))} match${results.length === 1 ? '' : 'es'} (of ${index.entries.length} indexed)\n\n`);
  for (const entry of results) {
    process.stdout.write(`${entry.title ?? dim('(no user message)')}\n`);
    process.stdout.write(`${dim(`  ${entry.cwd ?? '(no workspace)'} · ${ago(entry.createdAt)} · ${human(entry.bytes)} · ${entry.id}`)}\n`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// convert (read-only by construction)
// ---------------------------------------------------------------------------

async function commandConvert(args: Args): Promise<number> {
  const target = args.positionals[0];
  if (target === undefined) {
    process.stderr.write('convert requires a rollout path\n');
    return 1;
  }
  const path = resolve(target);
  if (!existsSync(path)) {
    process.stderr.write(`no rollout at ${path}\n`);
    return 2;
  }

  const summary = await parseRolloutFile(path, {
    keepTelemetry: args.flags.get('telemetry') === true,
  });
  const result = synthesizeSession(summary);
  const report = verifyArtifact(result.jsonl, join(dshHome(args), 'sessions'));

  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify({
      sessionId: result.sessionId,
      cwd: result.cwd,
      rowCount: result.rowCount,
      emitted: result.emitted,
      preserved: result.preserved,
      dropped: result.dropped,
      orphanResults: result.orphanResults,
      verification: report,
      targetPath: sessionArtifactPath(join(dshHome(args), 'sessions'), result.cwd, result.sessionId),
    }, null, 2)}\n`);
    return report.ok ? 0 : 2;
  }

  process.stdout.write(`${bold('Source')} ${path}\n`);
  process.stdout.write(`  rollout id      ${summary.meta?.id ?? '(none)'}\n`);
  process.stdout.write(`  recorded cwd    ${summary.meta?.cwd ?? '(none)'}\n`);
  process.stdout.write(`  entries read    ${summary.entries.length}\n`);
  if (summary.errors.length > 0) {
    process.stdout.write(`  unreadable rows ${summary.errors.length}\n`);
  }
  process.stdout.write(`\n${bold('Would become')} ${result.sessionId}\n`);
  process.stdout.write(`  rows            ${result.rowCount}\n`);
  process.stdout.write(`  target path     ${dim(sessionArtifactPath(join(dshHome(args), 'sessions'), result.cwd, result.sessionId))}\n`);
  for (const [type, count] of Object.entries(result.emitted).sort(([a], [b]) => a.localeCompare(b))) {
    process.stdout.write(`  ${type.padEnd(24)} ${count}\n`);
  }
  if (result.orphanResults.length > 0) {
    process.stdout.write(`  ${dim(`orphan outputs paired with a synthesized call: ${result.orphanResults.length}`)}\n`);
  }
  process.stdout.write(`\n${bold('Verification')} ${report.ok ? 'passed' : 'FAILED'} (${report.checksRun.length} checks)\n`);
  for (const violation of report.violations) {
    process.stdout.write(`  ${violation.code}: ${violation.detail}\n`);
  }
  process.stdout.write(
    `\n${dim('This command never writes. Session conversion into a real harness home is')}\n`
    + `${dim('deliberately not exposed in this phase; see docs/design.md.')}\n`,
  );
  return report.ok ? 0 : 2;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function commandDoctor(args: Args, store: SessionStore): Promise<number> {
  const home = codexHome(args);
  const problems: string[] = [];

  const dsh = dshHome(args);
  const sessionsExist = existsSync(store.root);
  if (!sessionsExist) problems.push(`no DSH session root at ${store.root}`);

  const drift = sessionsExist ? await store.diagnose() : { missingArtifact: [], staleIndex: [] };
  if (drift.missingArtifact.length > 0) {
    problems.push(`${drift.missingArtifact.length} indexed session(s) have no artifact on disk`);
  }
  if (drift.staleIndex.length > 0) {
    problems.push(`${drift.staleIndex.length} artifact(s) are missing from the index`);
  }

  const generations = new Map<number, number>();
  for (const session of store.all()) {
    generations.set(session.formatVersion, (generations.get(session.formatVersion) ?? 0) + 1);
  }
  const legacy = [...generations.entries()].filter(([version]) => version !== 3);

  const report = {
    codexHome: home,
    codexHomeExists: existsSync(home),
    dshHome: dsh,
    sessionsRoot: store.root,
    sessions: store.all().length,
    generations: Object.fromEntries([...generations.entries()].sort((a, b) => a[0] - b[0])),
    drift,
    problems,
  };

  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return problems.length === 0 ? 0 : 2;
  }

  process.stdout.write(`${bold('Doctor')}\n\n`);
  process.stdout.write(`  Codex home      ${home}${report.codexHomeExists ? '' : dim('  (absent)')}\n`);
  process.stdout.write(`  Harness home    ${dsh}\n`);
  process.stdout.write(`  Sessions root   ${store.root}${sessionsExist ? '' : dim('  (absent)')}\n`);
  process.stdout.write(`  Sessions        ${report.sessions}\n`);
  if (generations.size > 0) {
    process.stdout.write(
      `  Generations     ${[...generations.entries()].sort((a, b) => a[0] - b[0]).map(([v, n]) => `v${v}:${n}`).join('  ')}\n`,
    );
  }
  if (legacy.length > 0) {
    process.stdout.write(
      `\n${dim(`  ${legacy.reduce((sum, [, n]) => sum + n, 0)} session(s) are below the current generation.`)}\n`
      + dim(`  DSH migrates these on read; any path comparison must use the stored generation,\n`)
      + dim(`  not the current one. This is the case a version-blind helper gets wrong.`),
    );
    process.stdout.write('\n');
  }

  if (problems.length === 0) {
    process.stdout.write(`\n${bold('No problems found.')}\n`);
    return 0;
  }
  process.stdout.write(`\n${bold('Problems')}\n`);
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  return 2;
}

// ---------------------------------------------------------------------------

/**
 * Run one command.
 * @param argv - arguments after the program name.
 * @returns the process exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.command === undefined || args.flags.get('help') === true || args.command === 'help') {
    process.stdout.write(USAGE);
    return args.command === undefined ? 1 : 0;
  }

  switch (args.command) {
    case 'env':
      return commandEnv(args);
    case 'mapping':
      return commandMapping(args);
    case 'list':
      return commandList(args, await loadStore(args, false));
    case 'search':
      return commandSearch(args, await loadStore(args, false));
    case 'export':
      return commandExport(args, await loadStore(args, false));
    case 'bundle':
      return commandBundle(args);
    case 'trash':
      return commandTrash(args, await loadStore(args, false));
    case 'index':
      return commandIndex(args);
    case 'convert':
      return commandConvert(args);
    case 'doctor':
      return commandDoctor(args, await loadStore(args, false));
    default:
      process.stderr.write(`unknown command "${args.command}"\n\n${USAGE}`);
      return 1;
  }
}

// Only run when invoked directly, so tests can import `main`.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}

export { parseArgs, human, ago };
