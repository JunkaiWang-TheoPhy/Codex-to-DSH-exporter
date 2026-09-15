# Fork plan: secondary development on `dsh-chat-import`

Decision: this project is a fork of an existing repository rather than a new
implementation. This document names the base, what is reused unchanged, what is
extended, and what that means for the licence.

## 1. The base

**`Nwflower/dsh-chat-import`** — MIT, `Copyright (c) 2026 Nwflower` and
`Copyright (c) 2026 Scarlett`.

| Property | Value |
|---|---|
| Licence | MIT |
| Version at fork time | 0.11.3, published 2026-09-13 |
| Cadence | 24 releases in 31 days |
| Tests | 73 `node:test` files, `--test-coverage-lines=75` gate |
| Runtime deps | one (`fzstd`) |
| Reach | 161 stars, 18,714 downloads/month |
| Source readers | 21 agents, including Codex |
| Write path | real DSH v3 sessions via `agents.create({ seed })` |

### Why this one

Four candidates were assessed and three were eliminated on licence grounds
before their engineering mattered:

| Project | Licence | Verdict |
|---|---|---|
| `dsh-chat-import` | MIT | **base** |
| `session-migrate` | MIT | 18 harnesses, but Python, and DSH is not among them |
| `session-harbor` | PolyForm Noncommercial | derivative work not permitted |
| `Codex_Relay` | none | no licence means all rights reserved |

`dsh-chat-import` also happens to have the property that makes forking
tractable: `lib/convert/core.mjs` has **zero imports**, and each source
converter imports only `./core.mjs`. The layer this project needs to extend is
cleanly separable from the plugin, the client UI, and the cordis wiring.

## 2. What is reused unchanged

Everything below is other people's work and stays that way.

- **21 source converters** — `lib/convert/{claude,chatgpt,cursor,gemini,opencode,kimi,qwen,grokbuild,hermes,…}.mjs`. Only the Codex one is touched.
- **DSH event synthesis** — `convert/core.mjs` `synthesizeSession()`, which already handles `surfaceOp`, message ids, `stream: []`, contiguous `seq`, `sourceEventSeqs` and tool-call pairing.
- **The structural validator** — `validateSessionEvents` and `verifySession`.
- **The lossless-JSON sanitiser** — `prepareHostEvents`.
- **The host integration** — `agents.create({ seed })` with the
  `sessionPersistence.append` fallback, including the ghost-session recovery.
- **The reverse direction** — DSH → Claude / Codex / Kimi export.
- **Bundles, handoff, budget trimming, the client panel, the `/import` commands.**
- **The test suite**, which is the reason to trust any of the above.

The honest framing: this repository contributes roughly one converter's worth of
change to a codebase of about 19,500 lines.

## 3. What is extended

Seven changes, each traceable to a measurement or a read of the source.

### G1 — Codex `reasoning` is discarded

`lib/convert/codex.mjs:167` reads:

> reasoning（内容加密，通常不可读）与其余事件忽略

and `encrypted_content` appears nowhere in the package. Measured on a uniform
random sample of 200 rollouts: `reasoning` is **7.59%** of corpus bytes, and the
readable `content` + `summary` are **0.15%**.

The comment is right that the ciphertext is unreadable and wrong to discard the
record. Claude's `thinking` already maps to a DSH reasoning block
(`core.mjs:40`); the Codex path should do the same for the readable part.

The ROADMAP marks "全保真（tool/result + thinking + sourceEventSeqs）" as ✅. That
holds for Claude and not for Codex, which makes this a fidelity fix rather than
a new capability.

### G2 — the whole `event_msg` channel is ignored

`codex.mjs:93` guards with `if (env !== 'response_item' || !payload) continue`, so
`context_compacted`, `token_count` and `turn_aborted` are never seen. Mesured
byte shares: `item_completed` 11.9%, `token_count` 2.8%.

Ignoring the channel does avoid the duplicate `user_message` problem — the
conversation is written on both channels. But it also discards the compaction and
turn-abort signals, which are the two that change how a session reads.

### G3 — Codex `compacted` is not handled

Compaction handling exists for Claude, opencode, Pi, Kimi and ZCode, and not for
Codex. `compacted` records are **13.2%** of corpus bytes.

**Correction.** An earlier revision of this document described the record as
carrying a `replacement_text` string. That field does not exist. It was invented
in this repository's own synthetic fixture and then treated as observed. Measured
over 102 real `compacted` records: `replacement_text` appears **zero** times;
`replacement_history` is an array of complete message records in **102 of 102**,
`message` is empty in **102 of 102**, and window metadata
(`window_number`, `window_id`, `compaction_response_id`,
`latest_token_usage_record`) is present in most.

So the semantics are a compaction *window* — earlier turns replaced by
`replacement_history` — not a summary string. That makes the Codex change larger
than the "add one branch" this document originally implied.

### G4 — `~/.codex/archived_sessions/` is not discovered

The default root is `~/.codex/sessions` only and the layout regex does not admit
the flat directory. On the machine this was measured against, that directory
holds 398 rollouts.

### G5 — current-generation DSH logs are not readable

**Verified by execution, and larger than first estimated.**

The pattern `/^session\.jsonl(?:\.zstd)?$/i` matches `session.jsonl.zstd` and
does not match `session.v3.jsonl.zstd`. It appears in four places:
`lib/dsh.mjs:10`, `lib/discovery.mjs:549`, `:1617`, and `:1714`.

Measured on the author's machine: **4 sessions at generation 0, 48 at
generation 3.** The plugin can see 4 of 52 DSH sessions — **7.7%**.

This is a defect in shipped behaviour rather than a missing feature, it has a
one-line reproduction, and it affects the majority of the store. It is the first
thing to open upstream.

### G6 — `ignorable` events are not preserved, but the path exists

Unknown Codex record types have nowhere to go through the host write path, and
this was expected to be the change that forced a rewrite.

**It should not be.** Three facts, read from the harness:

1. `ignorable?: true` is a first-class field on the event envelope
   (`dsh-session/lib/types/types.d.ts:478`). Its comment explains the design:
   required-by-default "means a forgotten marker over-refuses (an inconvenience)
   rather than silently resuming a gutted session".
2. `agents.create` takes `seed?: readonly SessionEvent[]`
   (`dsh-agent/lib/types/index.d.ts:81`), so a seeded event carrying the marker
   type-checks.
3. `prepareHostEvents` (`import-core.mjs:273`) only sanitises JSON. It backfills
   an empty `data` and strips unserialisable values; it does **not** strip
   envelope keys.

The obstacle is the type system, not the runtime. `SessionEventMap` is a closed
keyed map, so a custom event *name* has no key and cannot be written without a
cast — which is exactly what the persistence layer itself does. Upstream's
version 0.8.3 removed its own `session/imported` marker, and the type system is
the plausible reason.

The empirical test remains worth running before the fork commits, but it is a
twenty-line test against `create({ seed })`, not an architectural change. If it
passes, G6 lands in the same shape as the other six changes.

If it fails, the fallback — hand-encoding the artifact and deriving the storage
path — is what `packages/dsh-session-artifact` already implements and verifies.

### G7 — `cwd` is preserved or dropped, never remapped

`import-core.mjs:261` deletes a `cwd` that is not absolute on the current
platform, so a Windows rollout imported on macOS loses its workspace. There is no
rewrite option. For the archive-then-load workflow this matters, because the
archive may be built on one machine and loaded on another.

## 4. What this fork adds that upstream does not have

The export half. Upstream reads `~/.codex` directly and writes DSH in one step;
it has no intermediate artifact, which means it requires DSH installed and
running, and a failure partway leaves nothing to inspect.

The fork adds an `export` verb that writes the archive specified in
`docs/archive-format.md` — byte-exact rollouts, digests, a resumable ledger, a
credential scan — so the data can be captured before DSH is involved and loaded
later, possibly on a different machine.

That is additive rather than divergent: upstream's direct path keeps working.

## 5. Licence and attribution

MIT permits derivative work and relicensing, with the copyright notice and
permission notice preserved.

- `LICENSE` keeps the original MIT text with **both** copyright lines.
- A `NOTICE` file records the origin, the fork point (version 0.11.3, commit
  hash at fork), and the nature of the changes.
- The repository's own new work is AGPL-3.0-or-later, which MIT permits
  one-way. The combined repository therefore carries both, with the MIT
  obligations scoped to the files derived from upstream.
- Every file carried from upstream keeps a header naming its origin. A file
  that has been modified says so.

## 6. Upstreaming

`CONTRIBUTING.md` states:

> PRs are welcome for new import sources, **fidelity upgrades**, and the items on
> [the roadmap].

and prescribes fork → `feature/<name>` → PR, with a template, one logical change
per commit, and `npm test` plus `npm run check:linux` green before pushing.

So the seven changes are also seven candidate pull requests. The fork should keep
them as separable commits against upstream's structure, and G5 — a clear bug with
a reproducible symptom — should go upstream regardless of what happens to the
rest.

Forking and upstreaming are not in tension here: the fork is where the work
happens, and upstream is where most of it belongs, because 18,714 people a month
already run this code.

## 7. What changes in this repository

| Current | After |
|---|---|
| `packages/codex-rollout` | **Superseded** by upstream's `lib/convert/codex.mjs`, which is extended instead. Kept only until G1–G4 land, then deleted. |
| `packages/dsh-session-artifact` | **Kept** as the reference implementation of the target format and the thing that settles G6. |
| `packages/codex-archive` | **New**, the export half. |
| `docs/` | Becomes the design record for the seven changes and the archive format. |

The repository stops being a competing implementation and becomes the fork plus
the documentation of why each change was needed.
