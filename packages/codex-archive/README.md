# `@codex-to-dsh/codex-archive`

Read a Codex home read-only and write a portable, verifiable, self-describing
archive. This is stage 1 of the pipeline in
[`docs/pipeline-design.md`](../../docs/pipeline-design.md); the format itself is
specified in [`docs/archive-format.md`](../../docs/archive-format.md), and this
file is about using the package rather than about the format.

Zero build. Plain ESM under `src/`, no `dist/`, no compile step. The whole
dependency set is `node:fs`, `node:crypto`, `node:zlib` and `node:test`.

## Use it

```bash
node bin/codex-archive.mjs export --codex-home ~/.codex --out ./my-archive --limit 50
node bin/codex-archive.mjs verify ./my-archive
```

`export` writes the archive and prints what it took. `verify` walks the manifest
and exits non-zero on any failure. Run `verify` before trusting an archive — that
sentence is on the CLI's own last line for a reason.

`--limit` produces a valid **partial** archive, not a corrupt one: the manifest
records what was taken and the ledger stays consistent. It is the only practical
way to check an export end to end before committing 38 GB to it.

```js
import { runExport, verifyArchive } from '@codex-to-dsh/codex-archive'

const report = await runExport({ codexHome: '~/.codex', outDir: './my-archive' })
const check = await verifyArchive('./my-archive')
```

Re-running with the same `outDir` resumes from the `ledger.json` already there;
`previous` and `ledger` do not have to be passed. Forgetting them would otherwise
mean a silent full re-copy.

## What it guarantees

**The Codex home is never written to.** Every operation is `readdir`, `stat`, and
`read`. `test/export.test.mjs` asserts the source tree — file set, sizes, mtimes,
and content digests — is unchanged after an export.

**Session rollouts are copied byte-for-byte.** They are not credential-scanned.
`sourceSha256` is the digest of the original bytes, and redacting a rollout would
break exactly the property the digest exists for. Credentials are refused on the
environment surface (`config.toml`, `AGENTS.md`, `hooks.json`, rules, skills,
prompts, agents), and `auth.json` is not copied at all. What was and was not taken
is recorded in the manifest's `notCaptured` and `secrets`, not only in comments.

**Two digests, because one is not enough.** `sourceSha256` covers the original
bytes; `storedSha256` covers the bytes on disk. The second is not redundant —
Node's zstd decoder accepts trailing bytes, so appending a byte to a frame still
decompresses to identical plaintext, and a verifier comparing only the first
digest reports success on a file that is no longer what was written.

## What verification does not claim

That the archive is a faithful copy of everything Codex holds. It proves the
archive matches the manifest, and the manifest says what was and was not taken.
Those are different claims, and the second is the honest one.

## Tests

```bash
npm test
```

43 tests. Each failure case corresponds to a defect that was reproduced first: a
byte appended to a compressed frame, a truncated artifact, a missing source file
that leaves only `normalized.jsonl`, a ledger disagreeing with the manifest, an
empty `notCaptured`, a tampered environment file, a tampered or deleted derived
layer.

Two things the suite deliberately does not do. It does not use real corpus
samples as fixtures — field shapes were verified against 5,538 real rollouts, but
the samples themselves are not in the repository. And it does not treat a green
suite as evidence of correctness beyond the covered behaviour: passing tests
establish the covered behaviour only.

## Reference

| Export | |
|---|---|
| `runExport(options)` | Run an export. Returns `{ manifest, ledger, copied, reused, skipped, secrets, elapsedMs }`. |
| `detectCompression()` | Probe for built-in zstd; returns `'zstd'` or `'none'`. |
| `discardPartial(outDir, id)` | Remove an incomplete session directory. |

| Verify | |
|---|---|
| `verifyArchive(outDir)` | Returns `{ ok, checks, results, problems }`; never throws on a bad archive. |

| Classify | |
|---|---|
| `classifyRecord(record, line)` | One parsed JSONL line to one IR entry. |
| `classifyRollout(path)` | Stream a rollout to IR entries. |
| `summarizeRollout(path)` | Stream a rollout to a `meta.json`-shaped summary. |
| `textOf(content)` | Readable text from a string, a block array, or `null`. |
| `ENTRY_KINDS` | The known `kind` values. `unknown` is still reachable, by design. |

| Scan | |
|---|---|
| `scanSessions(home)` | Enumerate rollouts under both real roots. |
| `scanEnvironment(home)` | Enumerate the environment surface. |
| `rolloutIdFromFilename(name)` | `rollout-<ISO>-<uuid>.jsonl` to `<uuid>`. |
| `defaultOmissions(options)` | The `notCaptured` declarations. |

| Credentials and hashing | |
|---|---|
| `scanAndRedact(text, sourcePath)` | Find credential-shaped values and return the redacted text. |
| `isScannable(name)` | Whether a file is worth scanning; binaries are skipped. |
| `copyThroughDigest(src, dest, options)` | Copy while computing both digests. |
| `hashFile(path)`, `hashValue(value)` | Streaming and in-memory SHA-256. |
| `writeAtomic(path, content)` | Write via a temporary file and rename. |
