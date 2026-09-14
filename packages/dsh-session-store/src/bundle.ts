/**
 * Portable session transfer bundles.
 *
 * A bundle is a directory holding a manifest and the session artifacts copied
 * byte-for-byte, with a SHA-256 per file. The digest is the point: a bundle
 * exists to move history between machines, and a silently truncated artifact
 * would surface much later as an unreadable session. Digest verification on
 * import is therefore required rather than optional.
 *
 * Artifacts are copied, never re-encoded, so a bundle round trip is
 * byte-identical and cannot lose data the format does not model.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { projectKey as deriveProjectKey } from '@codex-to-dsh/dsh-session-artifact';
import type { SessionStore } from './store.ts';

/** One artifact recorded in a bundle manifest. */
export interface BundleEntry {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly cwd: string | undefined;
  readonly formatVersion: number;
  /** Path inside the bundle, relative to its root. */
  readonly file: string;
  /** Lowercase hex SHA-256 of the copied artifact. */
  readonly sha256: string;
  readonly bytes: number;
}

/** A bundle manifest as written to disk. */
export interface BundleManifest {
  readonly format: 'codex-to-dsh/session-bundle';
  readonly version: 1;
  readonly createdAt: number;
  readonly origin: string;
  readonly entries: readonly BundleEntry[];
}

/** Outcome of importing a bundle. */
export interface ImportReport {
  readonly imported: readonly string[];
  readonly skipped: readonly { readonly sessionId: string; readonly reason: string }[];
  readonly failed: readonly { readonly sessionId: string; readonly reason: string }[];
}

async function sha256File(path: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Write selected sessions into a bundle directory.
 * @param store - the source store, already refreshed.
 * @param sessionIds - sessions to include.
 * @param outDir - bundle root; created when absent.
 * @returns the manifest that was written.
 */
export async function exportBundle(
  store: SessionStore,
  sessionIds: readonly string[],
  outDir: string,
): Promise<BundleManifest> {
  await mkdir(join(outDir, 'files'), { recursive: true });
  const entries: BundleEntry[] = [];

  let index = 0;
  for (const sessionId of sessionIds) {
    const record = store.get(sessionId);
    if (record === undefined) continue;
    index += 1;
    const relative = join('files', `${String(index).padStart(4, '0')}-${record.sessionId}`, basename(record.path));
    const target = join(outDir, relative);
    await mkdir(join(outDir, 'files', `${String(index).padStart(4, '0')}-${record.sessionId}`), { recursive: true });
    await copyFile(record.path, target);
    entries.push({
      sessionId: record.sessionId,
      projectKey: record.projectKey,
      cwd: record.cwd,
      formatVersion: record.formatVersion,
      file: relative,
      sha256: await sha256File(target),
      bytes: record.bytes,
    });
  }

  const manifest: BundleManifest = {
    format: 'codex-to-dsh/session-bundle',
    version: 1,
    createdAt: Date.now(),
    origin: store.root,
    entries,
  };
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/** Read a bundle manifest. */
export async function readBundleManifest(bundleDir: string): Promise<BundleManifest> {
  const parsed: unknown = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
  if (
    typeof parsed !== 'object'
    || parsed === null
    || (parsed as { format?: unknown }).format !== 'codex-to-dsh/session-bundle'
  ) {
    throw new Error(`"${bundleDir}" is not a codex-to-dsh session bundle`);
  }
  return parsed as BundleManifest;
}

/**
 * Verify every artifact in a bundle against its recorded digest.
 *
 * Run before import, and available separately so a bundle can be checked
 * without touching a store.
 * @param bundleDir - bundle root.
 * @returns per-file verification results.
 */
export async function verifyBundle(
  bundleDir: string,
): Promise<{ readonly ok: boolean; readonly results: readonly { readonly sessionId: string; readonly ok: boolean; readonly detail: string }[] }> {
  const manifest = await readBundleManifest(bundleDir);
  const results = [];

  for (const entry of manifest.entries) {
    const actual = await sha256File(join(bundleDir, entry.file)).catch(() => undefined);
    results.push({
      sessionId: entry.sessionId,
      ok: actual === entry.sha256,
      detail: actual === undefined
        ? 'artifact is missing'
        : actual === entry.sha256
          ? `sha256 ${actual.slice(0, 12)}…`
          : `digest mismatch: expected ${entry.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
    });
  }

  return { ok: results.every((result) => result.ok), results };
}

/**
 * Import a bundle into a store.
 *
 * Every artifact is placed at the path DSH will recompute from its own header
 * rather than at the path the bundle happens to use, so a bundle built on one
 * machine lands correctly on another. An existing session with the same id is
 * skipped rather than overwritten: bundles are additive.
 * @param store - the destination store.
 * @param bundleDir - bundle root.
 * @param options - `verify` defaults to true; `apply` defaults to false.
 * @returns the import report.
 */
export async function importBundle(
  store: SessionStore,
  bundleDir: string,
  options: { readonly verify?: boolean; readonly apply?: boolean } = {},
): Promise<ImportReport> {
  const apply = options.apply ?? false;
  if ((options.verify ?? true) && apply) {
    const verification = await verifyBundle(bundleDir);
    if (!verification.ok) {
      const detail = verification.results
        .filter((result) => !result.ok)
        .map((result) => `${result.sessionId}: ${result.detail}`)
        .join('; ');
      throw new Error(`refusing to import a bundle that failed verification — ${detail}`);
    }
  }

  const manifest = await readBundleManifest(bundleDir);
  await store.loadIndex();
  const imported: string[] = [];
  const skipped: { sessionId: string; reason: string }[] = [];
  const failed: { sessionId: string; reason: string }[] = [];

  for (const entry of manifest.entries) {
    if (store.get(entry.sessionId) !== undefined) {
      skipped.push({ sessionId: entry.sessionId, reason: 'already present in the destination store' });
      continue;
    }
    if (!apply) {
      imported.push(entry.sessionId);
      continue;
    }
    try {
      const key = entry.cwd === undefined ? entry.projectKey : deriveProjectKey(entry.cwd);
      const targetDir = join(store.root, key, entry.sessionId);
      await mkdir(targetDir, { recursive: true });
      await copyFile(join(bundleDir, entry.file), join(targetDir, basename(entry.file)));
      imported.push(entry.sessionId);
    } catch (error) {
      failed.push({
        sessionId: entry.sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (apply) {
    await store.refresh();
    await store.saveIndex();
  }
  return { imported, skipped, failed };
}

/** The final path segment. */
function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}
