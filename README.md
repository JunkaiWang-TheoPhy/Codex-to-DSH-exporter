<div align="center">

🇬🇧 **English** | 🇨🇳 [中文](README.zh.md)

# Codex-to-DSH-exporter

[![License](https://img.shields.io/badge/license-MIT-2EA44F?style=flat)](LICENSE)
[![Base](https://img.shields.io/badge/base-dsh--chat--import%20v0.11.3-4D6BFE?style=flat)](https://github.com/Nwflower/dsh-chat-import)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-43853D?style=flat)](package.json)
[![Test baseline](https://img.shields.io/badge/inherited%20tests-688%20%2F%20715-B08900?style=flat)](#status)
[![Export tests](https://img.shields.io/badge/codex--archive%20tests-43%20%2F%2043-2EA44F?style=flat)](#status)

<img src="assets/banner.png" alt="An archive drawer of filed cards with one card drawn out and stamped, feeding into a sealed archive block" width="1000">

</div>

## Introduction

A Codex working environment lives inside one program's directory: sessions, skills, agent definitions, MCP servers, the command allow-list. Getting it into the DeepSeek Harness usually means either trusting a one-shot import you cannot inspect, or rebuilding it by hand.

This repository is secondary development on [`dsh-chat-import`](https://github.com/Nwflower/dsh-chat-import), which already reads 21 coding agents and writes real DSH sessions through the harness's own API. That codebase is kept unchanged.

The work runs on two tracks, and this document says which is which.

**Offered upstream, not in this tree.** Seven fidelity fixes on the Codex path are being submitted as separate pull requests, so that the 18,000 people a month already running this code receive them. Two are merged (#44 session-generation discovery, #45 the `archived_sessions` root) and seven are open (#46–#53, plus #54). **None of them is in this repository's code yet.**

**Built here.** The export half — reading a Codex home read-only and writing a portable, verifiable archive before DSH is involved — is implemented in `packages/codex-archive`. The format is specified in [docs/archive-format.md](docs/archive-format.md), the staging for the importer in [docs/pipeline-design.md](docs/pipeline-design.md), and the package has its own suite (`npm test` in that directory: 43 tests, all passing) plus a smoke run against a real 5,538-rollout Codex home.

That smoke run, in full: 50 sessions and 778 environment files copied, **365 MB of rollouts to 109 MB** with zstd, 8.0 s; `verify` passed all 5 checks; a second run reused 827 of 828 entries and copied only the session Codex was still writing to. The classifier reached **0 unknowns across 72,369 records**.

## The seven fixes

Each is traceable to a measurement or a read of the harness source. Each is a separate pull request against upstream. The reasoning behind each is in [docs/fork-plan.md](docs/fork-plan.md).

| | Change | Why it was needed |
|---|---|---|
| **G1** | Codex `reasoning` records are kept | The readable part is 0.15% of the corpus and was discarded together with the ciphertext |
| **G2** | The Codex `event_msg` channel is read | It was skipped wholesale, losing compaction and turn-abort signals |
| **G3** | Codex compaction records are handled | Implemented for five other sources and missing for Codex |
| **G4** | `~/.codex/archived_sessions/` is discovered | 398 rollouts on the test machine were unreachable |
| **G5** | Current-generation DSH logs are readable | The pattern matched `session.jsonl.zstd` and not `session.v3.jsonl.zstd`, hiding **48 of 52** sessions |
| **G6** | Unknown record types survive as `ignorable` events | DSH documents this as its compatibility mechanism; the Codex path did not use it |
| **G7** | A recorded working directory can be remapped | A cross-machine archive lands ungrouped, by design |

G5 is a defect in shipped behaviour with a one-line reproduction, and it affects most of any user's session store.

## What is inherited

The following is upstream's work, unchanged.

**Import from 21 agents** — Claude Code, Codex, ChatGPT, Cursor, Gemini, Antigravity CLI, Reasonix, opencode, MiMo Code, ZCode, Grok Build, OpenClaw, Pi Coding Agent, Hermes, Kimi CLI and Kimi Code, Kilo Code, Qoder CLI, WorkBuddy, Qwen Work CN, DSH session logs, and content-detected local JSONL.

**Export back** to Claude Code, Codex and Kimi Code.

**Resumable sessions** — tool calls, results, titles, models and timestamps carry across, and the conversation continues from where the source stopped.

**Bidirectional sync**, off by default, with sub-agent conversations filtered in both directions.

**A batch panel** in the GUI, and 13 agent tools with three injection levels so low-frequency tools stay out of context.

## Install

```bash
dsh plugin --profile web add -w link:/path/to/Codex-to-DSH-exporter
```

The npm package name remains `dsh-chat-import`. This fork is not published to npm.

## Usage

Import from the "Import sessions" panel at the bottom right of the GUI, or have the agent call the tool:

```
import_chat({ format: "codex", path: "~/.codex/sessions" })
import_chat({ format: "claude", path: "~/.claude/projects" })
```

Refresh the session list, open the imported conversation, and keep going.

Every parameter, example and edge case is in [docs/USAGE.md](docs/USAGE.md).

## Status

Two suites, and they are not comparable. They cover different code and neither one substitutes for the other.

**Inherited (`/`, upstream's plugin).** **688 pass, 27 fail**, here and on a clean checkout of upstream v0.11.3. Upstream's CI fails on `main` at the `npm test` step on every recent run. The failures are inherited, not introduced here, and are not yet fixed.

At least one is a direct contradiction between code and test. `lib/import-core.mjs:261` deletes a cross-platform `cwd` so a session degrades to ungrouped rather than the entire import failing, and the comment says so, while the test asserts the Windows path survives.

Treat **688 / 715** as the baseline for that suite. A change is not green because the suite is green.

**Export (`packages/codex-archive`).** **43 pass, 0 fail**, and the number that matters more is what the tests are for: every failure case in that suite is a defect that was first reproduced. Three came from doing this rather than from reading about it —

- Node's zstd decoder accepts trailing bytes, so a digest taken after decompression reports success on a file that has been appended to. The format now carries a second digest over the stored bytes, and disabling that check makes the suite fail.
- The classifier sent four record types to `unknown` — 608 of 50 real sessions' records, 1.6%. They are modelled now; the rate is 0 of 72,369.
- The derived `normalized.jsonl` was reused on a re-run, so changing the classifier left stale IR in an archive that looked correct. The derived layer is now rebuilt every run.

## Docs

| Document | Contents |
|---|---|
| [docs/fork-plan.md](docs/fork-plan.md) | The seven changes, how the base was chosen, licence, upstreaming |
| [docs/archive-format.md](docs/archive-format.md) | The export archive: layout, manifest, ledger, verification |
| [docs/design.md](docs/design.md) | Scope, engineering contracts, prior art, limits |
| [docs/mapping.md](docs/mapping.md) | Codex to DSH event mapping, and the invariants DSH enforces |
| [packages/codex-archive/README.md](packages/codex-archive/README.md) | The export package: API, CLI, what it does and does not verify |
| [docs/USAGE.md](docs/USAGE.md) | Upstream's tool and command reference |
| [docs/INTERCHANGE.md](docs/INTERCHANGE.md) | Upstream's interchange protocol and bundle format |
| [ROADMAP.md](ROADMAP.md) | Upstream's shipped and planned work |

## Licence and credit

MIT. The base is [`Nwflower/dsh-chat-import`](https://github.com/Nwflower/dsh-chat-import), Copyright (c) 2026 Nwflower and Scarlett. Both notices are preserved in [LICENSE](LICENSE), and the unmodified original is kept at [LICENSE.upstream](LICENSE.upstream). What was added and what was changed is recorded in [NOTICE](NOTICE).
