# The export archive format

This document specifies the artifact `codex-to-dsh-exporter` produces. It is the
product; the CLI is how you make one.

## 1. Why the archive is not DSH-shaped

The obvious design is to emit DSH session artifacts directly, and it is the
wrong one for an exporter. Three reasons, in order of weight.

**Durability.** The stated purpose of exporting is to get your history out while
you still have access to the program that holds it. DSH's session format is at
release candidate — two builds on the author's machine (`0.1.0-rc.7` and
`0.1.5-rc.1`) were measured to validate the same artifact differently. An
archive whose format tracks a release candidate has moved the lock-in rather
than removed it. A neutral archive is readable in ten years; a
`session.v3.jsonl.zstd` file is readable until the format moves.

**Authority.** The Codex rollout is the primary source. A converted artifact is
a lossy projection of it, and once you have only the projection you cannot
recover what the projection dropped. The archive keeps the source.

**Tier decisions belong downstream.** Measured on a uniform random sample of
200 rollouts: telemetry is 14.8% of corpus bytes, `compacted` records
13.2%, and reasoning 7.0% of which 84.1% is ciphertext opaque outside OpenAI's
systems. Whether to carry those is a judgement the importer should make, per
destination and per user. Baking a tier into the export forecloses it.

So the archive encodes **Codex**, not DSH. A DSH importer is a separate program
that reads this format and decides what it can carry.

## 2. Directory layout

The canonical form is a directory, not a single file: it streams, it resumes,
and you can inspect it with `ls` before trusting it.

```
<name>.codex-export/
├── manifest.json              the archive's self-description and integrity record
├── ledger.json                resumable state; which source artifacts are already captured
├── environment/
│   ├── AGENTS.md              byte-exact copy
│   ├── config.toml            byte-exact copy
│   ├── hooks.json             byte-exact copy
│   ├── rules/
│   ├── skills/<name>/…        byte-exact copy of each skill directory
│   ├── prompts/<name>.md
│   ├── agents/<name>.toml
│   ├── plugins/_inventory.json   what was installed; payloads NOT copied unless asked
│   └── _sources.json          where each file came from, relative to the Codex home
└── sessions/
    └── <rollout-uuid>/
        ├── source.jsonl.zst   byte-exact copy of the rollout, zstd-compressed
        ├── source.sha256      digest of the ORIGINAL bytes, before compression
        ├── normalized.jsonl   derived IR: one classified entry per line
        └── meta.json          id, cwd, createdAt, title, cliVersion, originator, counts
```

### Why both `source.jsonl.zst` and `normalized.jsonl`

These are not redundant, and the distinction is the format's central design
choice.

`source.jsonl.zst` is **authoritative**. It is the bytes Codex wrote, and
`source.sha256` is their digest before compression, so a third party can prove
the archive matches what was on disk. Nothing downstream may treat this file as
optional.

`normalized.jsonl` is **derived and regenerable**. It is the classified entry
union this project's parser produces — `message`, `tool-call`, `tool-output`,
`reasoning`, `boundary`, `telemetry`, `compaction`, `unknown`. Its value is that
an importer does not have to reimplement Codex's rollout grammar, which changed
across the versions represented in a real corpus. Its role is convenience.

The rule that keeps this honest: **`normalized.jsonl` may always be deleted and
rebuilt from `source.jsonl.zst`, and an archive with only the normalized form is
invalid.** A verifier must reject an archive missing a source file, even when
its normalized companion is present.

### What this buys, with one measured example

`response_item/reasoning` carries an `encrypted_content` field that is opaque
outside OpenAI's systems. Measured on a uniform random sample of 200 rollouts it
is **6.46% of the corpus** — 2.46 GB of 38 GB, or about 0.57 GB compressed.

The destination cannot use it, and an importer should drop it: there is no point
adding 0.57 GB of unreadable bytes to a store the harness has to scan.

The archive keeps it anyway, and this costs no design work. Because
`source.jsonl.zst` is a byte-exact copy of the rollout, the field is retained by
default; omitting it would require deliberate filtering. An archive that
silently dropped part of a record would stop being evidence of what was on disk,
which is the property the whole format exists for.

That is the general rule this example illustrates: **the archive's default is to
keep, and every omission is a decision someone has to make explicitly and record
in `notCaptured`.**

## 3. `manifest.json`

```json
{
  "format": "codex-exporter/archive",
  "version": 1,
  "createdAt": 1789000000000,
  "tool": { "name": "codex-to-dsh-exporter", "version": "0.1.0" },
  "source": {
    "codexHome": "/Users/example/.codex",
    "cliVersion": "0.147.0",
    "originator": "codex_cli_rs",
    "machine": null
  },
  "counts": { "sessions": 5533, "skills": 91, "prompts": 20, "agents": 21 },
  "totals": { "sourceBytes": 40773407718, "archiveBytes": 0 },
  "entries": [
    {
      "kind": "session",
      "id": "019f0000-0000-7000-8000-000000000001",
      "path": "sessions/019f0000-.../source.jsonl.zst",
      "sourcePath": "sessions/2026/08/14/rollout-2026-08-14T23-42-57-019f0000-....jsonl",
      "sourceBytes": 74729,
      "sourceSha256": "…64 hex…",
      "archiveBytes": 18344,
      "storedSha256": "…64 hex…"
    }
  ],
  "notCaptured": [
    { "what": "auth.json", "why": "credentials are never exported, by construction" },
    { "what": "state_5.sqlite", "why": "thread index and titles; recoverable from rollouts" }
  ]
}
```

Four fields carry weight beyond bookkeeping:

- **`sourcePath`** preserves the origin layout. The date-partitioned
  `sessions/YYYY/MM/DD/` tree and the flat `archived_sessions/` directory are
  both real, and knowing which one a rollout came from is information an
  importer may group by.
- **`sourceSha256`** is the digest of the original bytes. This is what makes the
  archive evidentiary rather than a copy of unknown provenance.
- **`storedSha256`** is the digest of the bytes as stored — the compressed stream,
  for a session artifact. Required, not optional; §6.1 explains the measured
  failure that forces a second digest.
- **`machine` is `null` by default.** A hostname or user path is machine-specific
  and belongs in the archive only on explicit request; `docs/` in this repository
  follows the same rule.
- **`notCaptured`** is mandatory and must be non-empty. An export that silently
  omits `auth.json` and the SQLite state is worse than one that says so.

Two fields are additions beyond this document's original layout, both recorded
rather than assumed:

- **`compression`** — the physical encoding of the **session** artifacts
  (`zstd` | `none`). Environment files are always plain UTF-8 and carry no
  suffix. A verifier must decide per entry from the stored path; applying this
  flag to environment files would decompress plain text. A degraded run on a
  Node build without built-in zstd records `none` here instead of substituting a
  different format silently.
- **`limit`-bounded runs** — an export may be asked to take at most *n*
  rollouts. The result is a valid **partial** archive, not a corrupt one: the
  manifest states what was taken, and the ledger stays consistent. This is the
  only practical way to check an export end to end before committing 38 GB to
  it.

## 4. `ledger.json` — resumability

The motivating scenario is time-bounded: extract the history before access ends,
possibly across several sittings, while new sessions keep being written.

```json
{
  "version": 1,
  "updatedAt": 1789000000000,
  "sessions": {
    "019f0000-0000-7000-8000-000000000001": {
      "sourcePath": "sessions/2026/08/14/rollout-….jsonl",
      "sourceBytes": 74729,
      "mtimeMs": 1789000000000,
      "sourceSha256": "…",
      "capturedAt": 1789000000000,
      "status": "complete"
    }
  }
}
```

A re-run reads the ledger, compares `(sourceBytes, mtimeMs)` for every rollout it
finds, copies only what changed, and appends. Status values are
`complete` | `partial` | `failed`; **the ledger advances only for `complete`
entries**, and a `.partial` file is never left where a verifier would accept it.

This mirrors the discipline in `cc-switch`'s `codex_history_migration.rs` — a
completion marker written only on success, and a per-run record — which is the
one design in that project this repository adopts.

## 5. Read-only guarantee

The exporter never writes to the Codex home. No file under `~/.codex` is created,
modified, moved, or deleted; the only operations are `readdir`, `stat`, and
`read`.

This is not incidental. Three of the four Codex-subscription plugins surveyed
read `~/.codex/auth.json`, and two copy the refresh token into a second
location. An exporter that acquired a reputation for touching the Codex home
would be the wrong tool for the situation it exists for. The guarantee is worth
a test: the suite asserts the source tree is byte-identical after an export.

## 6. Verification

`verify` walks the manifest and, for every entry, recomputes two digests of the
stored artifact and compares each against what the manifest recorded. It reports
per-entry verdicts and exits non-zero on any failure.

### 6.1 Why two digests

This section exists because one digest was tried first and was measured to be
insufficient.

`sourceSha256` is taken after decompression, so it answers *does the archive hold
the original bytes*. `storedSha256` is taken over the bytes on disk, so it answers
*is the archive the file that was written*. Recomputing the first is what a
compression-aware verifier does naturally, and it leaves a hole: Node's zstd
decoder **accepts trailing bytes**. Appending one byte to a frame still
decompresses to byte-identical plaintext, so a verifier that only compares the
decompressed digest reports success on a file that has been appended to. The
suite's tamper case is exactly that append, and it fails if the stored-digest
check is removed.

The stored digest cannot be derived from the source by re-compressing. zstd output
depends on chunk boundaries: the same plaintext compressed in one write and in
64 KiB writes produces frames of different lengths (measured, 31,758 vs 30,699
bytes for a ~1.1 MB input). It has to be recorded when the bytes are written, which
is why `storedSha256` is a required manifest field rather than an optional extra.

### 6.2 The derived layer

`normalized.jsonl` is not evidence, and it is still checked. The manifest records
`normalizedSha256` for each session, and verification recomputes it, so a derived
layer that has been edited or deleted is reported rather than silently consumed by
an importer.

It is rebuilt on every run, including when the source artifact is reused. The
classifier is code and the rollout is data, so `(bytes, mtime)` — the pair that
decides source reuse — cannot tell whether the IR is current. Before this was
fixed, changing the classifier left an archive holding IR produced by the previous
version, with nothing about the archive looking wrong.

Three further checks:

1. **Completeness.** Every session directory contains a source file. A directory
   with only `normalized.jsonl` fails.
2. **Ledger agreement.** No entry is marked `complete` in the ledger whose
   manifest digest disagrees.
3. **Declared omissions.** `notCaptured` is present and non-empty.

What verification deliberately does **not** claim: that the archive is a
faithful copy of everything Codex holds. It proves the archive matches the
manifest, and the manifest says what was and was not taken. Those are different
claims and the second is the honest one.

## 7. What the importer must know

Not part of the archive format, but the reason the format is shaped this way.
Two facts about DSH's write paths were established by reading its source and
should be in an importer's design notes:

**Writing through the public API cannot set `ignorable`.** The read path refuses
an event type outside the harness's known vocabulary unless `event.ignorable ===
true`. The write path cannot supply that flag: `Session.append` threads only
`sourceEventSeqs` and `surfaceOp`. Two independent plugin authors hit this from
opposite sides — one wrote the envelope by hand to work around it, the other
called `append` normally and ships sessions the current build refuses to load.

**Writing the artifact directly can.** A hand-encoded artifact sets the flag and
passes both validation layers; that is measured in this repository's own tests.
The trade is that hand-encoding means reproducing the storage path, which the
API would otherwise derive.

An importer must therefore choose which of the two it is, and the choice
determines whether unknown-but-preserved events survive. This is exactly the
kind of decision the archive should not make on the user's behalf, which is why
the archive keeps everything and encodes none of it.
