/**
 * Session listing, search, trash, and transfer.
 *
 * This is the feature surface a session manager needs, applied to DSH's own
 * storage rather than to Codex's. Reading a header costs a decompression per
 * file, so everything routes through a cached index keyed by artifact
 * identity: `(path, size, mtimeMs)`. A scan re-reads only artifacts whose
 * identity changed, which is what keeps a 5,000-session store usable.
 *
 * Trash is a move into a sibling directory plus a manifest entry, not a
 * deletion and not the operating system trash. That keeps restore exact and
 * keeps the operation reversible without depending on platform behaviour.
 *
 * @module
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { discoverArtifacts, readHeader } from './discover.ts';
import type { DiscoveredArtifact, SessionRecord } from './discover.ts';

/** The on-disk index, versioned so a format change invalidates cleanly. */
interface IndexFile {
  readonly version: 1;
  readonly sessions: Record<string, SessionRecord>;
}

/** Filters accepted by {@link SessionStore.search}. */
export interface SearchQuery {
  /** Case-insensitive substring matched against title, id, and cwd. */
  readonly text?: string;
  /** Exact working directory. */
  readonly cwd?: string;
  /** Only sessions created at or after this epoch-ms value. */
  readonly since?: number;
  /** Only sessions created at or before this epoch-ms value. */
  readonly until?: number;
  /** Cap on returned records, applied after sorting newest-first. */
  readonly limit?: number;
}

/** One workspace group, as a session list presents it. */
export interface WorkspaceGroup {
  readonly cwd: string | undefined;
  readonly label: string;
  readonly sessions: readonly SessionRecord[];
  /** Newest `createdAt` in the group. */
  readonly latest: number;
}

/** A trashed session, as recorded in the trash manifest. */
export interface TrashedSession {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly cwd: string | undefined;
  readonly title: string | undefined;
  readonly trashedAt: number;
  /** Path relative to the trash directory. */
  readonly storedAt: string;
}

export interface SessionStoreOptions {
  /** DSH home, i.e. the parent of `sessions/`. */
  readonly home: string;
  /** Override the sessions root. Defaults to `<home>/sessions`. */
  readonly sessionsRoot?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The last path segment, used as a workspace label. */
function labelFor(cwd: string | undefined): string {
  if (cwd === undefined || cwd.length === 0) return '(no workspace)';
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || cwd;
}

/**
 * A DSH session store rooted at one harness home.
 *
 * ```ts
 * const store = new SessionStore({ home: process.env.DSH_HOME ?? join(homedir(), '.dsh') });
 * await store.refresh();
 * for (const group of await store.workspaces()) console.log(group.label, group.sessions.length);
 * ```
 */
export class SessionStore {
  readonly #home: string;
  readonly #root: string;
  readonly #indexPath: string;
  readonly #trashDir: string;
  #index: IndexFile = { version: 1, sessions: {} };

  constructor(options: SessionStoreOptions) {
    this.#home = options.home;
    this.#root = options.sessionsRoot ?? join(options.home, 'sessions');
    this.#indexPath = join(options.home, 'codex-to-dsh', 'index.json');
    this.#trashDir = join(options.home, 'session-trash');
  }

  get root(): string {
    return this.#root;
  }

  get trashDir(): string {
    return this.#trashDir;
  }

  /** Load the cached index without touching the sessions tree. */
  async loadIndex(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#indexPath, 'utf8'));
      if (isRecord(parsed) && parsed['version'] === 1 && isRecord(parsed['sessions'])) {
        this.#index = parsed as unknown as IndexFile;
      }
    } catch {
      this.#index = { version: 1, sessions: {} };
    }
  }

  /** Persist the index. Creates the cache directory when absent. */
  async saveIndex(): Promise<void> {
    await mkdir(join(this.#home, 'codex-to-dsh'), { recursive: true });
    await writeFile(this.#indexPath, `${JSON.stringify(this.#index, null, 2)}\n`, 'utf8');
  }

  /**
   * Reconcile the index against the sessions tree.
   *
   * Artifacts whose `(path, size, mtimeMs)` identity is unchanged keep their
   * cached header, so a second scan of an unchanged store performs no
   * decompression at all.
   * @returns what the scan did, for reporting rather than silent work.
   */
  async refresh(): Promise<{ scanned: number; read: number; removed: number; unreadable: readonly string[] }> {
    await this.loadIndex();
    const artifacts = await discoverArtifacts(this.#root);
    const next: Record<string, SessionRecord> = {};
    const unreadable: string[] = [];
    let read = 0;

    for (const artifact of artifacts) {
      const key = `${artifact.projectKey}/${artifact.sessionId}`;
      const cached = this.#index.sessions[key];
      if (
        cached !== undefined
        && cached.path === artifact.path
        && cached.bytes === artifact.bytes
        && cached.mtimeMs === artifact.mtimeMs
      ) {
        next[key] = cached;
        continue;
      }
      const record = await this.#hydrate(artifact);
      if (record !== undefined) next[key] = record;
      else unreadable.push(artifact.path);
      read += 1;
    }

    const removed = Object.keys(this.#index.sessions).filter((key) => next[key] === undefined).length;
    this.#index = { version: 1, sessions: next };
    return { scanned: artifacts.length, read, removed, unreadable };
  }

  async #hydrate(artifact: DiscoveredArtifact): Promise<SessionRecord | undefined> {
    const header = await readHeader(artifact.path, artifact.compressed);
    if (header === undefined) return undefined;
    return {
      ...artifact,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : artifact.mtimeMs,
      cwd: header.cwd,
      isSeeded: header.isSeeded === true,
      parentSession: header.parentSession,
      agentPreset: header.agentPreset,
      title: undefined,
    };
  }

  /** Every indexed session, newest first. */
  all(): SessionRecord[] {
    return Object.values(this.#index.sessions).sort((left, right) => right.createdAt - left.createdAt);
  }

  /**
   * Filter sessions by text, workspace, and time.
   *
   * The text match covers title, id, and cwd, mirroring the behaviour a session
   * list needs: a user searching "Mira" expects both the project and the
   * conversation titled Mira to appear.
   * @param query - filters to apply.
   * @returns matching sessions, newest first.
   */
  search(query: SearchQuery = {}): SessionRecord[] {
    const needle = query.text?.trim().toLowerCase();
    let results = this.all();

    if (needle !== undefined && needle.length > 0) {
      results = results.filter((record) => {
        const haystack = [record.title ?? '', record.sessionId, record.cwd ?? '']
          .join('\n')
          .toLowerCase();
        return haystack.includes(needle);
      });
    }
    if (query.cwd !== undefined) results = results.filter((record) => record.cwd === query.cwd);
    if (query.since !== undefined) results = results.filter((record) => record.createdAt >= query.since!);
    if (query.until !== undefined) results = results.filter((record) => record.createdAt <= query.until!);
    if (query.limit !== undefined) results = results.slice(0, query.limit);
    return results;
  }

  /**
   * Group sessions by working directory, the way a session list presents them.
   * @returns groups ordered by their newest session.
   */
  workspaces(): WorkspaceGroup[] {
    const groups = new Map<string, SessionRecord[]>();
    for (const record of this.all()) {
      const key = record.cwd ?? '\u0000none';
      const bucket = groups.get(key);
      if (bucket === undefined) groups.set(key, [record]);
      else bucket.push(record);
    }

    return [...groups.entries()]
      .map(([key, sessions]) => {
        const cwd = key === '\u0000none' ? undefined : key;
        return {
          cwd,
          label: labelFor(cwd),
          sessions,
          latest: sessions[0]?.createdAt ?? 0,
        };
      })
      .sort((left, right) => right.latest - left.latest);
  }

  /** Look one session up by id. */
  get(sessionId: string): SessionRecord | undefined {
    return this.all().find((record) => record.sessionId === sessionId);
  }

  /** Attach a title to an indexed session, so search can match it. */
  async setTitle(sessionId: string, title: string): Promise<boolean> {
    for (const [key, record] of Object.entries(this.#index.sessions)) {
      if (record.sessionId !== sessionId) continue;
      this.#index.sessions[key] = { ...record, title };
      await this.saveIndex();
      return true;
    }
    return false;
  }

  /**
   * Move sessions into the trash.
   *
   * The whole session directory moves, so every generation travels together
   * and restore is exact.
   * @param sessionIds - sessions to trash.
   * @returns the manifest entries created.
   */
  async trash(sessionIds: readonly string[]): Promise<TrashedSession[]> {
    await mkdir(this.#trashDir, { recursive: true });
    const manifest = await this.readTrashManifest();
    const moved: TrashedSession[] = [];

    for (const sessionId of sessionIds) {
      const record = this.get(sessionId);
      if (record === undefined) continue;
      const sourceDir = join(this.root, record.projectKey, record.sessionId);
      if (!existsSync(sourceDir)) continue;
      const storedAt = `${record.projectKey}__${record.sessionId}`;
      const target = join(this.#trashDir, storedAt);
      await mkdir(this.#trashDir, { recursive: true });
      await rename(sourceDir, target);
      const entry: TrashedSession = {
        sessionId: record.sessionId,
        projectKey: record.projectKey,
        cwd: record.cwd,
        title: record.title,
        trashedAt: Date.now(),
        storedAt,
      };
      moved.push(entry);
      manifest.sessions = [...manifest.sessions.filter((item) => item.sessionId !== sessionId), entry];
    }

    await this.writeTrashManifest(manifest);
    await this.refresh();
    await this.saveIndex();
    return moved;
  }

  /** The current trash contents, newest first. */
  async listTrash(): Promise<TrashedSession[]> {
    const manifest = await this.readTrashManifest();
    return [...manifest.sessions].sort((left, right) => right.trashedAt - left.trashedAt);
  }

  /** Move sessions back out of the trash. */
  async restore(sessionIds: readonly string[]): Promise<number> {
    const manifest = await this.readTrashManifest();
    let restored = 0;

    for (const entry of manifest.sessions) {
      if (!sessionIds.includes(entry.sessionId)) continue;
      const source = join(this.#trashDir, entry.storedAt);
      if (!existsSync(source)) continue;
      const targetDir = join(this.root, entry.projectKey);
      await mkdir(targetDir, { recursive: true });
      await rename(source, join(targetDir, entry.sessionId));
      restored += 1;
    }

    manifest.sessions = manifest.sessions.filter((entry) => !sessionIds.includes(entry.sessionId));
    await this.writeTrashManifest(manifest);
    await this.refresh();
    await this.saveIndex();
    return restored;
  }

  /** Permanently delete trashed sessions. The only destructive operation here. */
  async emptyTrash(): Promise<number> {
    const manifest = await this.readTrashManifest();
    let removed = 0;
    for (const entry of manifest.sessions) {
      await rm(join(this.#trashDir, entry.storedAt), { recursive: true, force: true });
      removed += 1;
    }
    await this.writeTrashManifest({ version: 1, sessions: [] });
    return removed;
  }

  /**
   * Detect and report index inconsistencies without changing anything.
   *
   * The two conditions worth surfacing are a session directory whose artifact
   * is missing and an index entry whose file is gone. DSH itself has no repair
   * command; its projection cache is derived and self-healing, so a mismatch
   * shows up as a missing session rather than an error.
   * @returns the inconsistencies found.
   */
  async diagnose(): Promise<{ missingArtifact: string[]; staleIndex: string[] }> {
    const artifacts = await discoverArtifacts(this.#root);
    const onDisk = new Set(artifacts.map((artifact) => `${artifact.projectKey}/${artifact.sessionId}`));
    const indexed = new Set(Object.keys(this.#index.sessions));

    return {
      missingArtifact: [...indexed].filter((key) => !onDisk.has(key)),
      staleIndex: [...onDisk].filter((key) => !indexed.has(key)),
    };
  }

  /** Read the trash manifest, tolerating its absence. */
  async readTrashManifest(): Promise<{ version: 1; sessions: TrashedSession[] }> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.#trashDir, 'manifest.json'), 'utf8'));
      if (isRecord(parsed) && Array.isArray(parsed['sessions'])) {
        return { version: 1, sessions: parsed['sessions'] as TrashedSession[] };
      }
    } catch {
      // An absent or unreadable manifest means an empty trash.
    }
    return { version: 1, sessions: [] };
  }

  /** Write the trash manifest. */
  async writeTrashManifest(manifest: { version: 1; sessions: TrashedSession[] }): Promise<void> {
    await mkdir(this.#trashDir, { recursive: true });
    await writeFile(
      join(this.#trashDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
  }
}
