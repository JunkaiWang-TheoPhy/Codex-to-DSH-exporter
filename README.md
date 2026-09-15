<div align="center">

**English** | [中文](README.zh.md)

# codex-to-dsh-exporter

<img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue" alt="License: AGPL-3.0-or-later">
<img src="https://img.shields.io/badge/node-%3E%3D22.15.0-brightgreen" alt="Node.js: >=22.15.0">
<img src="https://img.shields.io/badge/runtime%20deps-0%20third--party-brightgreen" alt="Third-party runtime dependencies: 0">
<img src="https://img.shields.io/badge/tests-49%20passing-brightgreen" alt="Tests: 49 passing">

<img src="assets/banner.png" width="1000" alt="Four Codex rollout logs on the left, a funnel, and one structured session record on the right">

</div>

## Introduction

A working environment accumulates in one program's container: the instructions, the skills, the hooks, the command allow-list, and the log of everything that was ever tried. On the machine this project was built against, the Codex home holds 5,138 date-partitioned rollouts and 398 archived ones, 37.97 GB in total, next to 91 skills, a `config.toml` carrying 25 MCP servers and hundreds of project-trust entries, and a 49 KB `AGENTS.md`. Rebuilding that configuration elsewhere is a day's work. The history is written in the vendor's own format, so it goes away with access to the program.

The DeepSeek Harness (DSH) keeps comparable material in an open format, under a directory the user owns, and two of its properties decide the shape of this project. The session codec is MIT-licensed and publicly exported, so a third party can emit a loadable artifact without forking the harness. Storage identity is a pure function of the artifact's header: DSH discovers sessions by scanning `<root>/<projectKey(cwd)>/<encodeSegment(id)>/session.v3.jsonl.zstd` and recomputes that path on load, which leaves no registry to update and no index to invalidate. The obstacle sits in the migration chain: its catalog is generated at build time, `dsh-session-format` rejects any edge that is not adjacent, and a Codex rollout has no integer predecessor in the `v0→v1→v2→v3` lineage. Import can only take the synthesis route, emitting a current-generation artifact and then validating it with the harness's own validators.

This repository is that work, in four layers. L1 inventories a Codex home surface by surface and states what each one corresponds to on the harness side. L3 builds a searchable index over the rollout history and hands it to an agent through a harness plugin with three read-only tools. L4 manages harness sessions — list, search, trash, restore, bundle, diagnose — by reading the session tree directly, without booting the harness. L2, the rollout-to-session converter, is implemented as a library with tests and a read-only `convert` preview; no command here writes a converted session into a real harness home.

The numbers in this README come from running those tools. A cold index build reads 5,536 rollouts covering 37.97 GB in 20.8 seconds, because each file is opened only as far as a 512 KB / 400-line head; a full parse of the same home did not finish in 60 seconds. Converting the synthetic fixture turns 25 rollout rows into 30 artifact rows and passes all nine structural checks, including the storage path DSH will recompute from the header.

Several things are deliberately absent. There is no batch import and no code path that writes into a real `~/.dsh`, because a 38 GB one-way write with quiet failure modes deserves measurement on a hundred sessions first. The index stores titles, workspaces, and counts, never message bodies. Whether DSH can continue a conversation from a synthesized artifact has not been tested and is not claimed. No harness version is pinned, and the session format is a release candidate.

The next step is to open the L2 gate: convert a hundred real rollouts, load them in the harness, and read them back before committing to the full set. Until then, `pnpm install && pnpm run test` exercises the conversion library against the fixture and against whatever real sessions the machine already has.

## What this is

Three layers run today; the fourth stops at the library boundary.

**L1 — environment inventory.** `codex-to-dsh env` walks ten surfaces of a Codex home (`AGENTS.md`, `config.toml`, `hooks.json`, `rules/`, `skills/`, `prompts/`, `agents/`, `plugins/`, `sessions/`, `archived_sessions/`), reports presence, size, and entry counts for each, and prints what it corresponds to on the harness side: `hooks.json` is already bridged by `@deepseek-ai/dsh-hooks-codex`, skills come from `~/.agents/skills` and `~/.dsh/skills`, configuration lives in `~/.dsh/settings.yaml`. It reports and stops there. Every one of those targets is a file the user already maintains, and a tool that overwrites `~/.dsh/AGENTS.md` would be worse than no tool.

**L3 — history index and plugin.** `codex-to-dsh index build` reads the head of every rollout under a Codex home and writes identity, workspace, timestamp, title, and per-kind counts to `<dsh-home>/codex-to-dsh/rollout-index.json`. The companion plugin registers `codex_history_search`, `codex_history_locate`, and `dsh_session_list` as agent tools at the host plane, so every agent and every preset sees them. The plugin is read-only and never writes to either home; the index build writes only its own file under the harness home, and never touches the Codex home or a session artifact.

**L4 — session management.** `dsh-session-store` finds sessions by scanning a harness home, groups them by workspace, searches titles, ids, and paths, moves them into a sibling trash directory with a manifest, exports and verifies SHA-256 bundles, and reports index drift without changing anything.

**L2 — rollout to session conversion.** `synthesizeSession` maps a parsed rollout onto DSH v3 events, `verifyArtifact` re-parses the result and runs nine checks, and `codex-to-dsh convert <rollout>` prints the accounting and the checks. The tests cover the mapping, the ordering repairs, and the path derivation. What does not exist is a command that walks a real `~/.codex` and writes into a real `~/.dsh`.

## Architecture

| Path | What it is |
|---|---|
| `packages/codex-rollout` | Streaming parser for Codex rollout JSONL, covering both the date-partitioned `sessions/YYYY/MM/DD/` tree and the flat `archived_sessions/` directory. Normalizes each row into one entry union, deduplicates the two write channels, and builds the searchable history index. It knows nothing about DSH. |
| `packages/dsh-session-artifact` | Every fact about the harness's storage format: `projectKey`, `encodeSegment`, the artifact path, the v3 event builder, `synthesizeSession`, and `verifyArtifact`. No other package computes a session path. |
| `packages/dsh-session-store` | Reads and manages a harness home with `node:fs` and `node:zlib`, without booting the harness: discovery, workspace grouping, search, trash with a manifest, bundles, drift diagnosis. |
| `apps/cli` | The `codex-to-dsh` command: `env`, `mapping`, `list`, `search`, `index`, `export`, `bundle`, `trash`, `convert`, `doctor`. |
| `plugins/dsh-plugin-codex-history` | A DSH plugin registering three read-only agent tools at the host plane. Loaded through `cordis.patch.yml`, which inserts one row into the booted profile's entry tree with `maxResults: 20`. |
| `docs/` | `mapping.md` — the Codex-to-DSH event contract, the storage-identity constraint, invariants C1–C5 with their real rejection messages, and what is lost. `design.md` — scope, engineering contracts, prior art, limits. `capability-parity.md` — capability matrix against `cockpit-tools`, with gaps marked. |
| `fixtures/` | `rollout-sample.jsonl`, a 25-row synthetic rollout used by the parser, artifact, and plugin tests. |

## The structural invariants

TypeScript's types express none of these. Each was found by running the installed `Session` validator against a synthesized artifact and reading the rejection.

| # | Invariant | Rejection when it fails |
|---|---|---|
| **C1** | Message-bearing events carry a `surfaceOp` marker | `format v3 assistant/message at seq 3 requires a surfaceOp marker` |
| **C2** | Message envelopes carry a non-empty string `id` | `seed assistant/message at index 3 lacks an identified message` |
| **C3** | `assistant/message` carries `turn`, `step`, and a `stream` array | `seed assistant/message at index 3 has invalid settlement fields` |
| **C4** | `seq` is contiguous from 0 | `released v2 row 8 has seq gap (expected 8, got 900)` |
| **C5** | Unrecognized event types carry `ignorable: true` | raised in the surface fold, which steps over the event only when the flag is present |

Four types are surface-eligible and require the marker: `user/message`, `assistant/message`, `tool/result`, `system/message`. `turn/start`, `turn/end`, `step/start`, `step/end`, `tool/call`, and `request/context` are not, and must not carry one.

`stream: []` passes every validator, and the content travels in `message.content` regardless. A rollout records settled content and holds no stream data, so this removes the largest implementation cost a naive reading of the format implies.

`SessionBuilder` owns the `seq` counter and the message constructors always emit a surface marker and a message id, so a caller cannot violate C1, C2, or C4. C3 and C5 are enforced where the events are emitted.

Storage identity is the adjacent constraint. On load DSH recomputes the expected path from the artifact's header and throws `corrupt session log "<path>": header id "<id>" and cwd identify "<expected path>"` when the two disagree. `cwd` is part of the address, so `cwdRewrite` changes where a session lands, and two projects holding the same session id is a fatal error.

## Measured behaviour

| Measurement | Value | Basis |
|---|---|---|
| Codex history indexed | 5,536 rollouts, 37.97 GB (5,138 dated, 398 archived) | Cold `index build` over a real Codex home, 2026-09-15 |
| Cold index build | 20.8 s | The same run: `elapsedMs` 20803, 20.88 s wall clock |
| Rescan of an unchanged home | 0.30 s, with `read: 0` and `reused: 5536` | `index build` against the index from that run; entries are cached on `(path, size, mtimeMs)` |
| Full parse of the same home | Did not finish in 60 s: 1,767 of 5,536 rollouts, 14.49 GB | `parseRolloutFile` over every rollout, stopped at 60 s |
| Largest single rollout | 1.26 GB: 7 ms for the bounded head read against 3.8 s for a full parse | `parseRolloutHead` and `parseRolloutFile` on that file |
| Reasoning size and encrypted share | reasoning is 7.0% of corpus bytes; `encrypted_content` is 84.1% of a reasoning record, readable `content` and `summary` 2.5% | `docs/mapping.md` §6–§7 over a uniform random sample of 200 rollouts (207,428 rows, 1.16 GB). An earlier figure of 46.7% came from sampling the first 60 files in directory order and is withdrawn |
| Session generations in the harness home | 4 at generation 0 and 39 at generation 3 as documented; `v0:4 v3:40` across 44 sessions when re-run | `docs/design.md` §5.5 and `docs/mapping.md` §2.2; `pnpm run test` and `codex-to-dsh doctor` on 2026-09-15 |
| `projectKey` checked against real session directories | 43 as documented; 44 when re-run | `docs/mapping.md` §2.1; test diagnostic on 2026-09-15 |
| Test suite | 49 tests pass | `pnpm run test`: codex-rollout 16, dsh-session-artifact 15, dsh-session-store 10, plugin 8 |
| Fixture conversion | 25 rollout rows become 30 artifact rows; 9 structural checks pass; 1 orphan tool output gets a synthesized call | `codex-to-dsh convert fixtures/rollout-sample.jsonl` |

Every figure above was taken on one macOS machine with Node 22.22.1 on 2026-09-15. Read them as this machine's evidence about this data set; the generation counts move as the machine is used.

## Install

Node.js `>=22.15.0` and pnpm are required.

```bash
pnpm install
pnpm run build
pnpm run test
```

`pnpm install` resolves the six workspace projects and nothing else: the three packages and the plugin declare no third-party runtime dependency, and the only external packages in the lockfile are the root dev dependencies `typescript`, `@types/node`, and its `undici-types` dependency.

## Usage

```bash
pnpm run cli <command> [options]
```

The same entry point is declared as the `codex-to-dsh` bin in `apps/cli/package.json`, so `node --experimental-strip-types apps/cli/src/main.ts <command>` works from a checkout. Pass arguments directly, as above; inserting a literal `--` after the script name makes the CLI's own argument reader consume the first word as a flag value.

| Command | What it does |
|---|---|
| `env` | Inventory a Codex home: instructions, config, hooks, rules, skills, prompts, agents, plugins, sessions, archived sessions |
| `mapping` | Print the Codex-to-DSH event mapping table (`DEFAULT_MAPPING`) |
| `list` | List harness sessions, grouped by workspace |
| `search` | Search harness sessions by title, id, or workspace |
| `index build` | Build or refresh the searchable index over the Codex rollout history |
| `index search` | Query that index by title, workspace, or rollout id |
| `export` | Copy selected sessions into a portable bundle, with a SHA-256 per artifact |
| `bundle` | Verify a session bundle without importing it |
| `trash` | `trash list`, `trash restore <id>`, or `trash empty --yes` |
| `convert` | Convert one Codex rollout, print the artifact accounting and the nine checks, write nothing |
| `doctor` | Report both homes, the session generation distribution, and index drift |

Common options: `--codex-home <path>` (default `$CODEX_HOME` or `~/.codex`), `--dsh-home <path>` (default `$DSH_HOME` or `~/.dsh`), `--json`. Exit codes: `0` success, `1` usage error, `2` a check failed.

```bash
# inventory the Codex side, machine-readable
pnpm run cli env --json

# index the rollout history, then query it
pnpm run cli index build
pnpm run cli index search "keyboard"

# dry-run one conversion and read the nine checks
pnpm run cli convert fixtures/rollout-sample.jsonl

# harness sessions
pnpm run cli list
pnpm run cli trash list
pnpm run cli doctor
```

To give an agent the same history, install the plugin into a profile and build the index it reads:

```bash
dsh plugin --profile <profile> add <path-to-repo>/plugins/dsh-plugin-codex-history
pnpm run cli index build
pnpm run cli list
```

The plugin resolves its inputs as `<dsh-home>/codex-to-dsh/rollout-index.json` (written by `index build`) and `<dsh-home>/codex-to-dsh/index.json` (written by `list`). When either file is missing, the tool returns the command that creates it instead of failing, and when the index describes a different Codex home the tool says so in its result.

## Design decisions and their reasons

**The upstream `cockpit-tools` code could not be reused.** It declares `CC-BY-NC-SA-4.0` in `Cargo.toml` and in its README, and it has no LICENSE file at the repository root. NonCommercial plus ShareAlike is incompatible with AGPL-3.0 in both directions: the non-commercial term would make a combined work non-free, and ShareAlike would demand relicensing the result. Nothing in this repository is derived from it. It serves as a design reference for editing `config.toml` without destroying unknown keys, and for the two rollout layouts and the `session_index.jsonl` / SQLite reconciliation problem. See `docs/design.md` §6 and `docs/capability-parity.md`.

**`cc-switch` (MIT) was used as a specification source.** Reuse would have been lawful, but its session modules are Rust inside a Tauri application, coupled to that application's own state and to an eighteen-step SQLite schema ladder, which makes porting more expensive than reimplementing against DSH's storage format. Its rollout filename grammar, its subagent filtering rule, and its idempotent migration ledger discipline informed the implementation here.

**The plugin declares its own copy of the harness API surface.** `plugins/dsh-plugin-codex-history/src/dsh-types.ts` holds the slice the plugin uses, and the package declares no harness dependency, so the repository builds and tests without a harness checkout beside it. The public registry is also incomplete for this purpose: `@deepseek-ai/dsh-session-persistence-jsonl@0.0.1-rc.1` depends on `@deepseek-ai/dsh-type-meta@^0.0.1-rc.1`, which returns 404, so a peer dependency on the harness packages fails the install.

**A rollout is synthesized into a current-generation artifact.** DSH generates its migration catalog at build time and rejects any non-adjacent edge, so a foreign format cannot be registered as a predecessor generation. `dsh-session-artifact` imports `releasedV3SessionFormatCodec`, `assertReleasedV3Header`, and `restoreReleasedV3Artifact` and builds the artifact directly.

**No caller assembles a session path.** Every write goes through `sessionArtifactPath()`, because DSH recomputes the expected path from the artifact's header on load and rejects the file when the two disagree. The derivation is lossy by design — separators are not recoverable, and the key is truncated to 251 characters — so a plausible-looking path built anywhere else produces a session the reader refuses.

**The history index reads a bounded head.** `parseRolloutHead` stops at 512 KB or 400 lines, whichever comes first, which makes the cost per rollout independent of its size, and the index keeps identity, workspace, title, and counts while leaving message bodies out. Both choices follow from the same measurement: a full parse of the home did not finish in 60 seconds, and a body index over 37.97 GB is a different project with a different cost profile.

## Repository hygiene

Everything under `fixtures/` is synthetic. `fixtures/rollout-sample.jsonl` is a 25-row rollout whose `base_instructions` field reads `Synthetic fixture. Not a real session.`, and its workspace path is `/home/example/work/demo-project`. No real session data, credentials, or personal paths are committed: `.gitignore` excludes `_recon/`, `*.local.json`, `*.local.yml`, `scratch/`, and `tmp/`, and the CLI keeps its index under the harness home, outside the repository. Three tests read the real `~/.dsh/sessions` tree, they never write to it, and they skip when no harness home exists.

## License

AGPL-3.0-or-later. The full text is in [LICENSE](LICENSE).
