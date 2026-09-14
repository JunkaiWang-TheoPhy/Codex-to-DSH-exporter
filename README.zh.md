<div align="center">

**中文** | [English](README.md)

# codex-to-dsh

<img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue" alt="许可证：AGPL-3.0-or-later">
<img src="https://img.shields.io/badge/node-%3E%3D22.15.0-brightgreen" alt="Node.js：>=22.15.0">
<img src="https://img.shields.io/badge/runtime%20deps-0%20third--party-brightgreen" alt="第三方运行时依赖：0">
<img src="https://img.shields.io/badge/tests-49%20passing-brightgreen" alt="测试：49 个通过">

<img src="assets/banner.png" width="1000" alt="左侧四份 Codex rollout 日志，中间一个漏斗，右侧一份结构化的会话记录">

</div>

## 引言

工作环境总是沉积在某个程序的容器里：指令、技能、钩子、命令白名单，以及所有试过的会话记录。本项目针对的这台机器上，Codex home 里有 5,138 个按日期分区的 rollout 和 398 个归档 rollout，合计 37.97 GB；旁边是 91 个 skill、一份配置了 25 个 MCP server 和数百条项目信任记录的 `config.toml`，以及 49 KB 的 `AGENTS.md`。配置换台机器重搭是一天的工作量；历史记录写在厂商自己的格式里，用不上那个程序的时候，它也就一起没了。

DeepSeek Harness（DSH）把同类内容放在开放格式里，目录归用户所有。它的两个性质决定了本项目的形状。会话编解码器以 MIT 许可公开导出，第三方不必 fork harness 就能生成可加载的产物。存储位置是 header 的纯函数：DSH 通过扫描 `<root>/<projectKey(cwd)>/<encodeSegment(id)>/session.v3.jsonl.zstd` 发现会话，加载时按 header 重算这个路径，既没有注册表要更新，也没有索引要失效。阻碍出在迁移链上：目录在构建期静态生成，`dsh-session-format` 拒绝任何不相邻的边，而 Codex rollout 在 `v0→v1→v2→v3` 这条谱系里没有整数前驱。导入只能走合成这条路——生成当前代的产物，再用 harness 自己的校验器验证它。

本项目按四层来做这件事。L1 逐个 surface 盘点 Codex home，说明每一项在 harness 侧对应什么。L3 为 rollout 历史建立可搜索的索引，并通过一个带三个只读工具的 harness 插件交给 agent 使用。L4 直接读会话目录树来管理 harness 会话：列出、搜索、移入回收站、恢复、打包、诊断，全程不启动 harness。L2 是 rollout 到会话的转换器，以库的形式实现并配有测试，另有一个只读的 `convert` 预览；本仓库里没有任何命令会把转换结果写进真实的 harness home。

文中的数字都来自实际运行。一次冷启动的索引构建读取 5,536 个 rollout、覆盖 37.97 GB，用时 20.8 秒，因为每个文件只读到 512 KB / 400 行的头部；对同一个 home 做完整解析，60 秒内没有跑完。转换合成 fixture 把 25 行 rollout 变成 30 行产物，九项结构检查全部通过，其中包括 DSH 之后会从 header 重算的存储路径。

有几件事是刻意不做的。没有批量导入，也没有任何写进真实 `~/.dsh` 的代码路径：一次 38 GB 的单向写入，失败方式又安静，值得先在 100 个会话上量一遍。索引只存标题、工作区和计数，不存消息正文。DSH 能否从合成产物继续一段对话，没有测过，也不作承诺。仓库不锁定 harness 版本，会话格式目前仍是 release candidate。

下一步是打开 L2 的闸门：先转换一百个真实 rollout，在 harness 里加载并读回，再决定要不要跑全量。在那之前，`pnpm install && pnpm run test` 会用 fixture 和机器上已有的真实会话来检验转换库。

## 这是什么

今天能跑的是三层，第四层停在库的边界上。

**L1 —— 环境盘点。** `codex-to-dsh env` 走查 Codex home 的十个 surface（`AGENTS.md`、`config.toml`、`hooks.json`、`rules/`、`skills/`、`prompts/`、`agents/`、`plugins/`、`sessions/`、`archived_sessions/`），报告每一项是否存在、占多大、多少条目，并打印它在 harness 侧对应什么：`hooks.json` 已经由 `@deepseek-ai/dsh-hooks-codex` 接上，skill 走 `~/.agents/skills` 和 `~/.dsh/skills`，配置写在 `~/.dsh/settings.yaml`。报告到此为止。这些目标都是用户自己在维护的文件，一个会覆盖 `~/.dsh/AGENTS.md` 的工具比没有工具更糟。

**L3 —— 历史索引与插件。** `codex-to-dsh index build` 读取 Codex home 下每个 rollout 的头部，把身份、工作区、时间戳、标题和各类记录计数写进 `<dsh-home>/codex-to-dsh/rollout-index.json`。配套插件在 host plane 注册 `codex_history_search`、`codex_history_locate` 和 `dsh_session_list` 三个 agent 工具，所有 agent 和 preset 都能看到。插件只读，不写任何一个 home；索引构建只写 harness home 下它自己的那个文件，从不碰 Codex home 或会话产物。

**L4 —— 会话管理。** `dsh-session-store` 扫描 harness home 找出会话，按工作区分组，搜索标题、id 和路径，把会话连同清单移进同级的回收站目录，导出并校验带 SHA-256 的 bundle，报告索引漂移而不改动任何东西。

**L2 —— rollout 到会话的转换。** `synthesizeSession` 把解析后的 rollout 映射成 DSH v3 事件，`verifyArtifact` 重新解析结果并跑九项检查，`codex-to-dsh convert <rollout>` 打印账目和检查结果。测试覆盖映射、顺序修补和路径推导。缺的是一个遍历真实 `~/.codex` 并写进真实 `~/.dsh` 的命令。

## 架构

| 路径 | 内容 |
|---|---|
| `packages/codex-rollout` | Codex rollout JSONL 的流式解析器，覆盖 `sessions/YYYY/MM/DD/` 日期分区目录和扁平的 `archived_sessions/`。把每一行归一成统一的 entry 联合类型，对两条写入通道去重，并构建可搜索的历史索引。它对 DSH 一无所知。 |
| `packages/dsh-session-artifact` | 关于 harness 存储格式的全部事实：`projectKey`、`encodeSegment`、产物路径、v3 事件构造器、`synthesizeSession` 和 `verifyArtifact`。其他包都不计算会话路径。 |
| `packages/dsh-session-store` | 只用 `node:fs` 和 `node:zlib` 读写和管理 harness home，不启动 harness：发现、按工作区分组、搜索、带清单的回收站、bundle、漂移诊断。 |
| `apps/cli` | `codex-to-dsh` 命令：`env`、`mapping`、`list`、`search`、`index`、`export`、`bundle`、`trash`、`convert`、`doctor`。 |
| `plugins/dsh-plugin-codex-history` | 一个 DSH 插件，在 host plane 注册三个只读 agent 工具。通过 `cordis.patch.yml` 加载，该文件向已启动 profile 的条目树插入一行，配置为 `maxResults: 20`。 |
| `docs/` | `mapping.md` 记录 Codex 到 DSH 的事件契约、存储身份约束、C1–C5 五条不变量及其真实报错，以及会丢失什么。`design.md` 记录范围、工程约定、先例与限制。`capability-parity.md` 是与 `cockpit-tools` 的能力对照表，缺口都标了出来。 |
| `fixtures/` | `rollout-sample.jsonl`，25 行合成 rollout，供解析器、产物和插件测试使用。 |

## 结构不变量

TypeScript 的类型表达不了这些约束。每一条都是拿合成产物跑已安装的 `Session` 校验器、读它的报错找出来的。

| # | 不变量 | 违反时的报错 |
|---|---|---|
| **C1** | 承载消息的事件必须带 `surfaceOp` 标记 | `format v3 assistant/message at seq 3 requires a surfaceOp marker` |
| **C2** | 消息信封必须带非空字符串 `id` | `seed assistant/message at index 3 lacks an identified message` |
| **C3** | `assistant/message` 必须带 `turn`、`step` 和 `stream` 数组 | `seed assistant/message at index 3 has invalid settlement fields` |
| **C4** | `seq` 从 0 起连续 | `released v2 row 8 has seq gap (expected 8, got 900)` |
| **C5** | 无法识别的事件类型必须带 `ignorable: true` | 在 surface fold 中抛出；只有带上该标记，fold 才会跳过这个事件 |

需要 surface 标记的只有四类：`user/message`、`assistant/message`、`tool/result`、`system/message`。`turn/start`、`turn/end`、`step/start`、`step/end`、`tool/call`、`request/context` 不属于这一类，带上标记反而会出错。

`stream: []` 能通过所有校验器，内容由 `message.content` 承载。rollout 记录的是已经定型的内容，本来就没有流式数据，这一条省掉了按格式字面理解时最大的一块实现成本。

`SessionBuilder` 自己持有 `seq` 计数器，消息构造函数一律写出 surface 标记和消息 id，调用方无法违反 C1、C2、C4。C3 和 C5 在事件产生的地方强制。

与之相邻的是存储身份约束。加载时 DSH 从产物 header 重算期望路径，两者不一致就抛出 `corrupt session log "<path>": header id "<id>" and cwd identify "<expected path>"`。`cwd` 是地址的一部分，所以 `cwdRewrite` 会让会话搬家；两个项目出现同一个 session id 是致命错误。

## 实测数据

| 测量项 | 数值 | 来源 |
|---|---|---|
| 索引的 Codex 历史规模 | 5,536 个 rollout，37.97 GB（5,138 个按日期分区，398 个归档） | 2026-09-15 对真实 Codex home 做的一次冷启动 `index build` |
| 冷启动构建耗时 | 20.8 秒 | 同一次运行：`elapsedMs` 为 20803，挂钟时间 20.88 秒 |
| 未改动 home 的重新扫描 | 0.30 秒，`read: 0`、`reused: 5536` | 用同一次运行产出的索引再跑一次 `index build`；条目按 `(path, size, mtimeMs)` 缓存 |
| 同一 home 的完整解析 | 60 秒内没有跑完：5,536 个 rollout 中处理了 1,767 个，14.49 GB | 对每个 rollout 调 `parseRolloutFile`，到 60 秒中止 |
| 单个最大 rollout | 1.26 GB：有界头部读取 7 毫秒，完整解析 3.8 秒 | 对该文件分别调用 `parseRolloutHead` 和 `parseRolloutFile` |
| reasoning 的体积与加密占比 | reasoning 占全语料字节的 7.0%；`encrypted_content` 占单条 reasoning 记录的 84.1%，可读的 `content` 与 `summary` 占 2.5% | `docs/mapping.md` 第 6、7 节，基于 200 个 rollout 的均匀随机样本（207,428 行，1.16 GB）。早先 46.7% 的说法取自目录序前 60 个文件，已撤回 |
| harness home 中的会话代次 | 文档记录为 generation 0 有 4 个、generation 3 有 39 个；重跑时 44 个会话为 `v0:4 v3:40` | `docs/design.md` 第 5.5 节与 `docs/mapping.md` 第 2.2 节；2026-09-15 的 `pnpm run test` 与 `codex-to-dsh doctor` |
| `projectKey` 与真实会话目录的比对 | 文档记录为 43 个；重跑时为 44 个 | `docs/mapping.md` 第 2.1 节；2026-09-15 的测试诊断输出 |
| 测试套件 | 49 个测试通过 | `pnpm run test`：codex-rollout 16、dsh-session-artifact 15、dsh-session-store 10、插件 8 |
| fixture 转换 | 25 行 rollout 变成 30 行产物，9 项结构检查通过，1 个孤立工具输出补上了合成的调用 | `codex-to-dsh convert fixtures/rollout-sample.jsonl` |

以上数字全部来自 2026-09-15 一台 macOS 机器上的 Node 22.22.1，是这一台机器在数据集上的测量结果。代次计数会随着机器使用而变化。

## 安装

需要 Node.js `>=22.15.0` 和 pnpm。

```bash
pnpm install
pnpm run build
pnpm run test
```

`pnpm install` 只解析六个 workspace 项目：三个包和插件都不声明第三方运行时依赖，lockfile 里的外部包只有根目录的开发依赖 `typescript`、`@types/node` 以及它依赖的 `undici-types`。

## 用法

```bash
pnpm run cli <command> [options]
```

同一个入口在 `apps/cli/package.json` 里声明为 `codex-to-dsh` bin，所以在 checkout 里也可以直接跑 `node --experimental-strip-types apps/cli/src/main.ts <command>`。参数直接跟在后面即可；在脚本名后插入字面量 `--`，会被 CLI 自己的参数解析器当成某个 flag 的取值吃掉。

| 命令 | 作用 |
|---|---|
| `env` | 盘点 Codex home：instructions、config、hooks、rules、skills、prompts、agents、plugins、sessions、archived sessions |
| `mapping` | 打印 Codex 到 DSH 的事件映射表（`DEFAULT_MAPPING`） |
| `list` | 按工作区分组列出 harness 会话 |
| `search` | 按标题、id 或工作区搜索 harness 会话 |
| `index build` | 构建或刷新 Codex rollout 历史的可搜索索引 |
| `index search` | 按标题、工作区或 rollout id 查询该索引 |
| `export` | 把选中的会话复制成可移植 bundle，每个产物带 SHA-256 |
| `bundle` | 校验 bundle，不执行导入 |
| `trash` | `trash list`、`trash restore <id>`、`trash empty --yes` |
| `convert` | 转换一个 Codex rollout，打印账目和九项检查，不写任何文件 |
| `doctor` | 报告两个 home 的状态、会话代次分布和索引漂移 |

通用选项：`--codex-home <path>`（默认 `$CODEX_HOME` 或 `~/.codex`）、`--dsh-home <path>`（默认 `$DSH_HOME` 或 `~/.dsh`）、`--json`。退出码：`0` 成功，`1` 用法错误，`2` 某项检查失败。

```bash
# 以机器可读的形式盘点 Codex 侧
pnpm run cli env --json

# 建立 rollout 历史索引并查询
pnpm run cli index build
pnpm run cli index search "keyboard"

# 试跑一次转换，查看九项检查
pnpm run cli convert fixtures/rollout-sample.jsonl

# harness 会话
pnpm run cli list
pnpm run cli trash list
pnpm run cli doctor
```

把同一份历史交给 agent，需要把插件装进某个 profile，并建立插件读取的索引：

```bash
dsh plugin --profile <profile> add <path-to-repo>/plugins/dsh-plugin-codex-history
pnpm run cli index build
pnpm run cli list
```

插件读取的输入是 `<dsh-home>/codex-to-dsh/rollout-index.json`（由 `index build` 写出）和 `<dsh-home>/codex-to-dsh/index.json`（由 `list` 写出）。任一文件缺失时，工具返回生成它的命令，不会直接报错退出；索引描述的是另一个 Codex home 时，工具会在结果里说明这一点。

## 设计取舍与理由

**上游 `cockpit-tools` 的代码无法复用。** 它在 `Cargo.toml` 和 README 里声明 `CC-BY-NC-SA-4.0`，仓库根目录没有 LICENSE 文件。NonCommercial 加 ShareAlike 与 AGPL-3.0 双向不兼容：非商业条款会让组合作品失去自由软件的资格，ShareAlike 则要求对结果重新许可。本仓库没有任何内容派生自它。它作为设计参考，用来说明如何在不破坏未知键的前提下编辑 `config.toml`，以及两种 rollout 布局与 `session_index.jsonl`、SQLite 之间的对账问题。见 `docs/design.md` 第 6 节和 `docs/capability-parity.md`。

**`cc-switch`（MIT）用作规格来源。** 复用在许可上没有问题，但它的会话模块是 Tauri 应用里的 Rust 代码，与该应用自身的状态和一条十八步的 SQLite schema 升级链绑在一起，移植比照 DSH 存储格式重写更贵。它的 rollout 文件名文法、subagent 过滤规则，以及幂等迁移账本的纪律（只在成功时写完成标记，每次迁移单独备份目录）影响了这里的实现。

**插件自带一份 harness API 表面的声明。** `plugins/dsh-plugin-codex-history/src/dsh-types.ts` 保存插件用到的那一小块；该包不声明任何 harness 依赖，旁边没有 harness checkout 也能构建和测试。公开 registry 在这个用途上也不完整：`@deepseek-ai/dsh-session-persistence-jsonl@0.0.1-rc.1` 依赖 `@deepseek-ai/dsh-type-meta@^0.0.1-rc.1`，后者返回 404，把 harness 包写成 peer dependency 会让安装失败。

**rollout 被合成成当前代的产物。** DSH 的迁移目录在构建期生成，拒绝任何不相邻的边，外部格式无法注册成前驱代次。`dsh-session-artifact` 直接导入 `releasedV3SessionFormatCodec`、`assertReleasedV3Header` 和 `restoreReleasedV3Artifact` 来构造产物。

**会话路径不由调用方拼装。** 每次写入都经过 `sessionArtifactPath()`，因为 DSH 加载时会从产物 header 重算期望路径，对不上就拒收。这个推导本身有损：分隔符不可还原，key 会被截断到 251 个字符。换个地方拼出一条看起来合理的路径，读出来的就是 DSH 拒绝加载的会话。

**历史索引只读头部。** `parseRolloutHead` 在 512 KB 或 400 行处停下，先到哪个算哪个，单个 rollout 的成本与它的大小无关；索引存的是身份、工作区、标题和计数，不存消息正文。两个选择出自同一次测量：完整解析这个 home 在 60 秒内没有跑完，而针对 37.97 GB 的正文索引是另一个项目，成本结构也不同。

## 仓库卫生

`fixtures/` 下的内容全部是合成的。`fixtures/rollout-sample.jsonl` 是一个 25 行的 rollout，它的 `base_instructions` 写着 `Synthetic fixture. Not a real session.`，工作区路径是 `/home/example/work/demo-project`。仓库里没有真实会话数据、凭据或个人路径：`.gitignore` 排除 `_recon/`、`*.local.json`、`*.local.yml`、`scratch/` 和 `tmp/`，CLI 把索引放在 harness home 下，不放进仓库。有三个测试会读取真实的 `~/.dsh/sessions`，它们从不写入，机器上没有 harness home 时自动跳过。

## 许可证

AGPL-3.0-or-later，全文见 [LICENSE](LICENSE)。
