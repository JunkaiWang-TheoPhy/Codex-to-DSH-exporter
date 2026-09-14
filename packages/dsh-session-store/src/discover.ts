/**
 * Discovery of DSH session artifacts on disk.
 *
 * DSH keeps no central registry of sessions. It discovers them by scanning
 * `<root>/` for project directories and reading the generation-named artifact
 * inside each session directory, so the same layout is sufficient here. The
 * one operation that must be cheap is reading a header: a full artifact can be
 * megabytes, while the header is the first line.
 *
 * DSH writes that header as its own Zstandard frame precisely so it can be
 * decoded independently — its reader asserts "the first frame is not exactly
 * one header line" on a violation. {@link readHeader} uses the same property
 * through a streaming decoder that stops at the first newline.
 *
 * @module
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createZstdDecompress } from 'node:zlib';
import { join } from 'node:path';

import { SESSION_FORMAT_VERSION, parseGenerationLogFilename } from '@codex-to-dsh/dsh-session-artifact';
import type { SessionHeader } from '@codex-to-dsh/dsh-session-artifact';

/** One discovered artifact. */
export interface DiscoveredArtifact {
  readonly sessionId: string;
  /** The project key directory it was found under. */
  readonly projectKey: string;
  readonly path: string;
  readonly formatVersion: number;
  /**
   * Whether the artifact is Zstandard-framed.
   *
   * Compression is a separate axis from generation and must be read from the
   * filename suffix, never inferred from the version. Four sessions on the
   * author's machine are stored as compressed generation 0, and treating
   * "version 0" as "plaintext" silently drops them.
   */
  readonly compressed: boolean;
  readonly bytes: number;
  readonly mtimeMs: number;
}

/** A session with its header read. */
export interface SessionRecord extends DiscoveredArtifact {
  readonly createdAt: number;
  readonly cwd: string | undefined;
  readonly isSeeded: boolean;
  readonly parentSession: string | undefined;
  readonly agentPreset: string | undefined;
  /** From a `session/title` event or the projection cache, when known. */
  readonly title: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read only the first line of a session artifact.
 *
 * Decompression stops as soon as a newline is seen, so the cost is independent
 * of artifact size. This matters when scanning thousands of sessions.
 * @param path - artifact path.
 * @param compressed - whether the artifact is Zstandard-framed. Take this from
 *   {@link DiscoveredArtifact.compressed}; deriving it from the generation is
 *   wrong, because generation 0 can also be compressed.
 * @returns the header, or `undefined` when the file is unreadable or malformed.
 */
export async function readHeader(path: string, compressed = true): Promise<SessionHeader | undefined> {
  const first = await readFirstLine(path, compressed);
  if (first === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(first);
    if (!isRecord(parsed)) return undefined;
    if (typeof parsed['id'] !== 'string') return undefined;
    return parsed as unknown as SessionHeader;
  } catch {
    return undefined;
  }
}

/** Stream just enough of an artifact to obtain its first line. */
function readFirstLine(path: string, compressed: boolean): Promise<string | undefined> {
  return new Promise((resolve) => {
    const source = createReadStream(path);
    const stream = compressed ? source.pipe(createZstdDecompress()) : source;
    let buffer = '';
    let settled = false;

    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      source.destroy();
      stream.destroy();
      resolve(value);
    };

    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline >= 0) finish(buffer.slice(0, newline));
    });
    stream.on('end', () => finish(buffer.length > 0 ? buffer : undefined));
    stream.on('error', () => finish(undefined));
  });
}

/**
 * Enumerate every session artifact under a storage root.
 *
 * When a session directory holds several generations, the numerically highest
 * wins — this reproduces DSH's own selection, where the latest generation is
 * the authoritative one and older generations are history.
 * @param root - the sessions root, normally `$DSH_HOME/sessions`.
 * @returns artifacts in unspecified order.
 */
export async function discoverArtifacts(root: string): Promise<DiscoveredArtifact[]> {
  const found: DiscoveredArtifact[] = [];

  let projects: string[];
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return found;
  }

  for (const project of projects) {
    const projectPath = join(root, project);
    let sessions: string[];
    try {
      sessions = (await readdir(projectPath, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }

    for (const sessionId of sessions) {
      const dir = join(projectPath, sessionId);
      let entries: string[];
      try {
        entries = (await readdir(dir)).filter((name) => name !== 'session.lock');
      } catch {
        continue;
      }

      let best: { name: string; version: number; compressed: boolean } | undefined;
      for (const name of entries) {
        for (const compressed of [true, false] as const) {
          const version = parseGenerationLogFilename(name, compressed ? 'zstd' : 'none');
          if (version === undefined) continue;
          if (best === undefined || version > best.version) best = { name, version, compressed };
        }
      }
      if (best === undefined) continue;

      const path = join(dir, best.name);
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        found.push({
          sessionId,
          projectKey: project,
          path,
          formatVersion: best.version,
          compressed: best.compressed,
          bytes: info.size,
          mtimeMs: info.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  }

  return found;
}

/**
 * Whether an artifact is written in the generation this build understands.
 * @param artifact - a discovered artifact.
 * @returns true when the artifact is current.
 */
export function isCurrentGeneration(artifact: DiscoveredArtifact): boolean {
  return artifact.formatVersion === SESSION_FORMAT_VERSION;
}
