/**
 * Archive types.
 *
 * The archive is specified in `docs/archive-format.md`. This module is the
 * TypeScript expression of that specification.
 *
 * @module
 */

/** Physical encodings the archive uses for stored bytes. */
export type ArchiveCompression = 'zstd' | 'none';

/** What a manifest entry describes. */
export type EntryKind = 'session' | 'environment-file' | 'skill' | 'prompt' | 'agent' | 'rule';

/** One record the archive carries. */
export interface ArchiveEntry {
  readonly kind: EntryKind;
  /** Stable identity: a rollout UUID, a skill name, a repo-relative source path. */
  readonly id: string;
  /** Path inside the archive. */
  readonly path: string;
  /** Path relative to the Codex home, preserving the origin layout. */
  readonly sourcePath: string;
  /** Size in bytes of the original, before compression. */
  readonly sourceBytes: number;
  /** Digest of the original bytes, before compression. */
  readonly sourceSha256: string;
  /** Size in bytes as stored. */
  readonly archiveBytes: number;
}

/** Something the export deliberately did not take. */
export interface Omission {
  readonly what: string;
  readonly why: string;
}

/** A credential-shaped value the scanner found and refused to write. */
export interface SecretFinding {
  /** Source path relative to the Codex home. */
  readonly sourcePath: string;
  /** 1-based line number. */
  readonly line: number;
  /** Which pattern matched. */
  readonly pattern: string;
  /** The matched text with its middle removed. Never the full value. */
  readonly redacted: string;
}

/** The archive's self-description. */
export interface ArchiveManifest {
  readonly format: 'codex-exporter/archive';
  readonly version: 1;
  readonly createdAt: number;
  readonly tool: { readonly name: string; readonly version: string };
  readonly source: {
    readonly codexHome: string;
    readonly cliVersion?: string;
    readonly originator?: string;
    /** Always null unless explicitly requested; machine identity is not exported by default. */
    readonly machine: string | null;
  };
  readonly counts: Readonly<Record<string, number>>;
  readonly totals: {
    readonly sourceBytes: number;
    readonly archiveBytes: number;
  };
  readonly entries: readonly ArchiveEntry[];
  readonly notCaptured: readonly Omission[];
  /** What the credential scanner found. Empty is the expected result and is still recorded. */
  readonly secrets: readonly SecretFinding[];
}

/** Resumable state, so a re-run copies only what changed. */
export interface ArchiveLedger {
  readonly version: 1;
  readonly updatedAt: number;
  readonly sessions: Readonly<Record<string, LedgerRecord>>;
}

/** One session's capture state. */
export interface LedgerRecord {
  readonly sourcePath: string;
  readonly sourceBytes: number;
  readonly mtimeMs: number;
  readonly sourceSha256: string;
  readonly capturedAt: number;
  /** The ledger advances only for `complete` entries. */
  readonly status: 'complete' | 'partial' | 'failed';
  /** Present when the status is not `complete`. */
  readonly reason?: string;
}

/** Options for an export run. */
export interface ExportOptions {
  /** The Codex home to read. Never written to. */
  readonly codexHome: string;
  /** Where to write the archive. */
  readonly outDir: string;
  /** Copy session rollouts. Defaults to true. */
  readonly includeSessions?: boolean;
  /** Copy plugin payloads. Defaults to false; the `plugins/` tree is 331 MB here and is inventory only. */
  readonly includePlugins?: boolean;
  /** Record the machine hostname. Defaults to false. */
  readonly includeMachine?: boolean;
  /** Previously written archive, for an incremental run. */
  readonly previous?: ArchiveManifest;
  /** Previously written ledger, for an incremental run. */
  readonly ledger?: ArchiveLedger;
  /** Progress reporting. */
  readonly onProgress?: (event: ExportProgress) => void;
  /** Cancellation. */
  readonly signal?: AbortSignal;
}

/** A progress event. */
export interface ExportProgress {
  readonly phase: 'scan' | 'copy' | 'ledger' | 'manifest' | 'done';
  readonly done: number;
  readonly total: number;
  readonly detail?: string;
}

/** The outcome of an export run. */
export interface ExportReport {
  readonly manifest: ArchiveManifest;
  readonly ledger: ArchiveLedger;
  readonly copied: number;
  readonly reused: number;
  readonly skipped: number;
  readonly secrets: readonly SecretFinding[];
  readonly elapsedMs: number;
}
