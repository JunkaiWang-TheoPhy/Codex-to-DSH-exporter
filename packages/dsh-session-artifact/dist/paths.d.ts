/**
 * DSH session storage path derivation.
 *
 * DSH does not keep a central session index. It discovers sessions by scanning
 * `<root>/` for project directories and reading the generation-named artifact
 * inside each session directory. That makes the path a *correctness* concern
 * rather than a convention: on load, the persistence backend recomputes the
 * expected path from the artifact's own header and rejects the file when it
 * disagrees.
 *
 * ```text
 * corrupt session log "<path>": header id "<id>" and cwd identify "<expected>"
 * ```
 *
 * A second invariant compounds this: `findLog` searches every project
 * directory, and two sessions sharing an id in different projects is a hard
 * error. So project placement must be a pure function of the header, which is
 * what this module provides.
 *
 * The algorithms here are byte-for-byte reproductions of
 * `projectKey()` and `encodeSegment()` in `@deepseek-ai/dsh-session-persistence-jsonl`,
 * verified against three real project directories on disk.
 *
 * @module
 */
/** The Session format generation this build emits. */
export declare const SESSION_FORMAT_VERSION = 3;
/** Physical encodings the JSONL backend supports. */
export type Compression = 'zstd' | 'none';
/**
 * Encode one path segment with the shared `~XXXX` escape.
 *
 * `.` and `..` are escaped rather than admitted, so an encoded segment is
 * never a traversal.
 * @param raw - the segment to encode.
 * @returns a filesystem-safe segment.
 */
export declare function encodeSegment(raw: string): string;
/**
 * Build the human-navigable project directory name for a working directory.
 *
 * Separators collapse into a single `-`, everything outside `[A-Za-z0-9._-]`
 * becomes `~XXXX`, and the result is wrapped in `--` and truncated to 251
 * characters. The transformation is intentionally lossy: two long paths
 * sharing a 251-character prefix collide, and separators are not recoverable.
 *
 * That lossiness is why {@link sessionDir} must be the only way a caller
 * builds a path. Deriving it independently is how a reader ends up rejecting
 * its own files.
 * @param cwd - the session's project directory.
 * @returns a single filesystem-safe project directory name.
 */
export declare function projectKey(cwd: string): string;
/**
 * The generation-addressed artifact basename.
 *
 * Version 0 keeps the original `session.jsonl`; every later generation inserts
 * a lowercase numeric component. Compression is a separate suffix.
 * @param version - Session format generation.
 * @param compression - physical encoding.
 * @returns the artifact basename.
 */
export declare function generationLogFilename(version: number, compression?: Compression): string;
/**
 * Read the generation named by one artifact basename.
 * @param filename - one basename from a session directory.
 * @param compression - physical encoding to accept.
 * @returns the generation, or `undefined` when the name is not canonical.
 */
export declare function parseGenerationLogFilename(filename: string, compression?: Compression): number | undefined;
/** A project's directory below the storage root. */
export declare function projectDir(root: string, cwd: string | undefined): string;
/** The directory owned by one session. */
export declare function sessionDir(root: string, cwd: string | undefined, id: string): string;
/**
 * The exact path DSH will recompute from an artifact's own header.
 *
 * Writing anywhere else produces a file the persistence backend refuses to
 * load, so every write in this repository routes through this function.
 * @param root - the storage root, normally `$DSH_HOME/sessions`.
 * @param cwd - the header's `cwd`; `undefined` selects `_no-cwd`.
 * @param id - the header's `id`.
 * @param version - Session format generation.
 * @param compression - physical encoding.
 * @returns the absolute artifact path.
 */
export declare function sessionArtifactPath(root: string, cwd: string | undefined, id: string, version?: number, compression?: Compression): string;
//# sourceMappingURL=paths.d.ts.map