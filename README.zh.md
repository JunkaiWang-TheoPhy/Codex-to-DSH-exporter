<div align="center">

🇨🇳 **中文** | 🇬🇧 [English](README.md)

# Codex-to-DSH-exporter

[![许可证](https://img.shields.io/badge/license-MIT-2EA44F?style=flat)](LICENSE)
[![基座](https://img.shields.io/badge/base-dsh--chat--import%20v0.11.3-4D6BFE?style=flat)](https://github.com/Nwflower/dsh-chat-import)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-43853D?style=flat)](package.json)
[![测试基线](https://img.shields.io/badge/inherited%20tests-688%20%2F%20715-B08900?style=flat)](#状态)
[![导出端测试](https://img.shields.io/badge/codex--archive%20tests-43%20%2F%2043-2EA44F?style=flat)](#状态)

<img src="assets/banner.png" alt="一个装满分卡片的档案抽屉，一张卡片被抽出并盖了章，右侧汇入封存的档案块" width="1000">

</div>

## 引言

Codex 的工作环境装在一个程序的目录里：会话、技能、agent 定义、MCP 服务器、命令白名单。要把它搬进 DeepSeek Harness，通常只有两条路——信任一次无法预先检查的导入，或者手工重建。

本仓库是对 [`dsh-chat-import`](https://github.com/Nwflower/dsh-chat-import) 的二次开发。上游已经能读 21 种 coding agent，并通过 harness 自己的 API 写出真实的 DSH 会话。那份代码库整体保留，未作改动。

工作分两条线，本文说明哪条是哪条。

**已提上游，不在本仓库代码里。** Codex 路径上的七项保真修复正以独立 PR 提交，好让每月已在运行这份代码的约 18,000 人拿到它们。已合并两个（#44 会话代次发现、#45 `archived_sessions` 默认根），另有七个开着（#46–#53，以及 #54）。**这些修复一个都不在本仓库的代码里。**

**在本仓库实现了的是导出端。** 在 DSH 参与之前只读地读一个 Codex home，写出可移植、可校验的归档——实现放在 `packages/codex-archive`。格式规范见 [docs/archive-format.md](docs/archive-format.md)，给导入端的分层见 [docs/pipeline-design.md](docs/pipeline-design.md)。该包自带测试（在它目录下 `npm test`：43 项，全通过），并在一个真实 5,538 个 rollout 的 Codex home 上跑过一遍。

那次实跑的全部数字：复制 50 个会话与 778 个环境文件，rollout **365 MB 压到 109 MB**（zstd），耗时 8.0 秒；`verify` 五项检查全过；第二次运行复用了 828 个条目中的 827 个，只重拷了 Codex 当时仍在写入的那个会话。分类器在 **72,369 条记录上 0 个 unknown**。

## 七项修复

每一项都能追溯到一次实测或一段 harness 源码。每一项都是对上游的一个独立 PR。逐条理由见 [docs/fork-plan.md](docs/fork-plan.md)。

| | 改动 | 为什么需要 |
|---|---|---|
| **G1** | 保留 Codex 的 `reasoning` 记录 | 可读部分占全语料 0.15%，此前与密文一起被丢弃 |
| **G2** | 读取 Codex 的 `event_msg` 通道 | 此前整通道跳过，compaction 与回合中断信号全部丢失 |
| **G3** | 处理 Codex 的 compaction 记录 | 另外五种来源都做了，唯独 Codex 没有 |
| **G4** | 发现 `~/.codex/archived_sessions/` | 测试机上有 398 个 rollout 完全取不到 |
| **G5** | 能读当前代次的 DSH 日志 | 正则匹配 `session.jsonl.zstd` 却匹配不到 `session.v3.jsonl.zstd`，**52 个会话里漏掉 48 个** |
| **G6** | 未知记录类型以 `ignorable` 事件留存 | DSH 在源码里写明这是它的兼容机制，Codex 路径此前没有使用 |
| **G7** | 记录的工作目录可重映射 | 跨机归档现在会落成未分组，这是有意设计的取舍 |

G5 是已发布行为里的缺陷，一行即可复现，且影响任何用户会话库的大部分。

## 继承来的能力

以下都是上游的工作，未作改动。

**从 21 种 agent 导入** —— Claude Code、Codex、ChatGPT、Cursor、Gemini、Antigravity CLI、Reasonix、opencode、MiMo Code、ZCode、Grok Build、OpenClaw、Pi Coding Agent、Hermes、Kimi CLI 与 Kimi Code、Kilo Code、Qoder CLI、WorkBuddy、千问办公，以及 DSH 自身的会话日志和按内容识别的本地 JSONL。

**反向导出**回 Claude Code、Codex、Kimi Code。

**可续聊的会话** —— 工具调用、结果、标题、模型与时间戳一并带过，并从源会话停下的地方继续。

**双向同步**，默认关闭，两个方向的 subagent 会话都默认过滤。

**图形界面的批量面板**，以及 13 个 agent 工具，分三档注入，低频管理工具不进上下文。

## 安装

```bash
dsh plugin --profile web add -w link:/path/to/Codex-to-DSH-exporter
```

npm 包名仍是 `dsh-chat-import`，本 fork 未发布到 npm。

## 用法

在界面右下角的「导入会话」面板里导入，或让 agent 调用工具：

```
import_chat({ format: "codex", path: "~/.codex/sessions" })
import_chat({ format: "claude", path: "~/.claude/projects" })
```

刷新会话列表，打开导入的会话，接着聊。

完整参数、示例与边界情况见 [docs/USAGE.md](docs/USAGE.md)。

## 状态

两套测试，彼此不能替代。它们覆盖不同的代码，任何一套变绿都不说明另一套。

**继承来的（`/`，上游插件）。** **688 通过、27 失败**，本仓库与上游 v0.11.3 的干净检出结果一致。上游 CI 在 `main` 上的最近每次运行都卡在 `npm test` 这一步。这些失败是继承来的，不是本仓库引入的，目前尚未修复。

至少有一处是代码与测试的直接矛盾：`lib/import-core.mjs:261` 会删掉跨平台的 `cwd`，让会话退化为未分组，而不是让整次导入失败，代码注释就是这么写的，而测试断言 Windows 路径必须存活。

请把 **688 / 715** 当作那套测试的基线。套件变绿不等于某次改动是对的。

**导出端（`packages/codex-archive`）。** **43 通过、0 失败**。比这个数字更要紧的是这些测试在测什么：那套里每一个失败用例都对应一个先被复现出来的缺陷，其中三个是动手做出来的、而不是读文档读出来的——

- Node 的 zstd 解码器接受尾随字节，于是"解压之后再算摘要"的校验会对一个被追加过内容的文件报通过。格式现在多带一个**存储字节**的摘要，把这项检查关掉，测试立刻失败。
- 分类器把四种记录类型送进了 `unknown`——50 个真实会话里 608 条，占 1.6%。现在都建了模，比例是 72,369 条里 0 条。
- 派生层 `normalized.jsonl` 曾被复用，于是改了分类器之后，归档里留着旧分类器写下的 IR，而它看上去完全正常。派生层现在每轮重建。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/fork-plan.md](docs/fork-plan.md) | 七项改动、基座如何选定、许可、上游化 |
| [docs/archive-format.md](docs/archive-format.md) | 导出归档：目录布局、manifest、ledger、校验 |
| [docs/design.md](docs/design.md) | 范围、工程契约、先例、局限 |
| [docs/mapping.md](docs/mapping.md) | Codex 到 DSH 的事件映射，以及 DSH 强制的结构不变量 |
| [packages/codex-archive/README.md](packages/codex-archive/README.md) | 导出包：API、命令行、校验了什么与没校验什么 |
| [docs/USAGE.md](docs/USAGE.md) | 上游的工具与命令参考 |
| [docs/INTERCHANGE.md](docs/INTERCHANGE.md) | 上游的互换协议与 bundle 格式 |
| [ROADMAP.md](ROADMAP.md) | 上游的已完成与计划项 |

## 许可与署名

MIT。基座是 [`Nwflower/dsh-chat-import`](https://github.com/Nwflower/dsh-chat-import)，版权归 Nwflower 与 Scarlett（2026）。两份声明都保留在 [LICENSE](LICENSE)，未改动的原文另存于 [LICENSE.upstream](LICENSE.upstream)。新增与改动的内容记录在 [NOTICE](NOTICE)。
