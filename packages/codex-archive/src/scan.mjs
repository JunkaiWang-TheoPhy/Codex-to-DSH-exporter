// scan.mjs — 枚举一个 Codex home 里值得归档的东西。
//
// 只读：全部操作是 readdir / stat / read。本模块不打开任何写句柄，也不接受可写路径。
//
// 路径形态均在真实语料上核验：
//   sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl   5538 个文件里 0 个失配
//   archived_sessions/rollout-<ISO>-<uuid>.jsonl     扁平，无日期分区
// 文件名里 UUID 提取规则见 ROLLOUT_NAME；实测 5538/5538 尾部都是规范 UUID。

import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** `rollout-<YYYY-MM-DDTHH-MM-SS>-<uuid>.jsonl`。 */
const ROLLOUT_NAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/

/**
 * 从 rollout 文件名取出会话 UUID。
 * @param {string} name - 文件名（不含目录）。
 * @returns {string | undefined} UUID，或 undefined 表示不是 rollout 名。
 */
export function rolloutIdFromFilename(name) {
  const m = ROLLOUT_NAME.exec(name)
  return m ? m[1] : undefined
}

/**
 * 深度优先列出目录项；读不到的子树跳过而不是抛错。
 *
 * 语料里有已删除/无权限的路径，一个读不到的子目录不该让整次导出失败。
 * @param {string} dir - 起始目录。
 * @param {{ maxDepth?: number }} [options]
 * @returns {AsyncGenerator<{ path: string, name: string, isDir: boolean, bytes: number, mtimeMs: number }>}
 */
async function* walk(dir, options = {}) {
  const maxDepth = options.maxDepth ?? 6
  /** @type {{ path: string, depth: number }[]} */
  const stack = [{ path: dir, depth: 0 }]
  while (stack.length > 0) {
    const { path, depth } = stack.pop()
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) {
        if (depth + 1 <= maxDepth) stack.push({ path: child, depth: depth + 1 })
        else yield { path: child, name: entry.name, isDir: true, bytes: 0, mtimeMs: 0 }
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = await stat(child)
        yield { path: child, name: entry.name, isDir: false, bytes: info.size, mtimeMs: info.mtimeMs }
      } catch {
        continue
      }
    }
  }
}

/** 相对 Codex home 的、以 `/` 分隔的路径。归档内一律用正斜杠，跨平台可读。 */
function relOf(home, path) {
  return relative(home, path).split(sep).join('/')
}

/**
 * 枚举全部 rollout。
 * @param {string} codexHome - Codex home。
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {AsyncGenerator<{ id: string, sourcePath: string, sourcePathRel: string, bytes: number, mtimeMs: number, layout: 'dated' | 'archived' }>}
 */
export async function* scanSessions(codexHome, options = {}) {
  for (const [root, layout] of [['sessions', 'dated'], ['archived_sessions', 'archived']]) {
    for await (const entry of walk(join(codexHome, root))) {
      if (options.signal?.aborted) return
      if (entry.isDir) continue
      const id = rolloutIdFromFilename(entry.name)
      if (id === undefined) continue
      yield {
        id,
        sourcePath: entry.path,
        sourcePathRel: relOf(codexHome, entry.path),
        bytes: entry.bytes,
        mtimeMs: entry.mtimeMs,
        layout,
      }
    }
  }
}

/**
 * 环境面：要归档的文件与目录。
 *
 * `plugins/` 默认只记清单不搬载荷——本机实测 331 MB，而它是可重新安装的产物。
 */
const ENVIRONMENT = [
  { rel: 'AGENTS.md', kind: 'environment-file' },
  { rel: 'config.toml', kind: 'environment-file' },
  { rel: 'hooks.json', kind: 'environment-file' },
  { rel: 'rules', kind: 'rule', recurse: true },
  { rel: 'prompts', kind: 'prompt', recurse: false },
  { rel: 'agents', kind: 'agent', recurse: false },
  { rel: 'skills', kind: 'skill', recurse: true },
]

/**
 * 枚举环境面的文件。
 *
 * 不存在的项静默跳过——一个 Codex home 没有 `hooks.json` 是正常的，不是错误。
 * @param {string} codexHome - Codex home。
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {AsyncGenerator<{ kind: import('./types.d.ts').EntryKind, id: string, sourcePath: string, sourcePathRel: string, bytes: number, mtimeMs: number }>}
 */
export async function* scanEnvironment(codexHome, options = {}) {
  for (const spec of ENVIRONMENT) {
    const root = join(codexHome, spec.rel)
    let info
    try {
      info = await stat(root)
    } catch {
      continue
    }

    if (info.isFile()) {
      if (options.signal?.aborted) return
      yield {
        kind: /** @type {import('./types.d.ts').EntryKind} */ (spec.kind),
        id: spec.rel,
        sourcePath: root,
        sourcePathRel: spec.rel,
        bytes: info.size,
        mtimeMs: info.mtimeMs,
      }
      continue
    }

    if (!info.isDirectory()) continue

    for await (const entry of walk(root, { maxDepth: spec.recurse ? 6 : 1 })) {
      if (options.signal?.aborted) return
      if (entry.isDir) continue
      // skills/ 顶层的 LEGAL.md / LICENSE / README.md / meta.json 是目录级元数据，
      // 不是 skill 本身（本机实测这 4 个文件与 ~/.agents/skills 同名但非 skill）。
      // 它们仍归档，只是 id 不按 skill 命名——由相对路径决定，不臆造 skill 名。
      const rel = relOf(codexHome, entry.path)
      yield {
        kind: /** @type {import('./types.d.ts').EntryKind} */ (spec.kind),
        id: rel,
        sourcePath: entry.path,
        sourcePathRel: rel,
        bytes: entry.bytes,
        mtimeMs: entry.mtimeMs,
      }
    }
  }
}

/**
 * 必须明确声明「没有带走」的东西。规范要求 `notCaptured` 非空。
 *
 * 这些是实测存在于本机 Codex home 的条目；列在这里意味着导出**有意**不取它们，
 * 而不是忘了。每一项带理由。
 * @param {{ includePlugins?: boolean }} [options]
 * @returns {import('./types.d.ts').Omission[]}
 */
export function defaultOmissions(options = {}) {
  const base = [
    { what: 'auth.json', why: 'credentials are never exported, by construction' },
    { what: '*.sqlite (state_*, logs_*, memories_*, thread_history_*, queue_*, goals_*)', why: 'index and cache stores; the archived rollouts carry the conversation content' },
    { what: 'log/, logs/', why: 'process logs, not agent context' },
    { what: '.codex-global-state.json', why: 'desktop UI state, not agent context' },
    { what: 'cache/', why: 'regenerable cache' },
    { what: 'computer-use/', why: 'screen-capture artifacts; may contain unrelated personal content' },
    { what: 'browser/', why: 'browser profile; credentials and cookies live here' },
    { what: 'attachments/', why: 'large binary attachments; not needed for the environment or the conversation text' },
    { what: 'vendor_imports/', why: 'third-party imports, re-obtainable upstream' },
    { what: 'backups/, backup-*/, cockpit-*-backup/', why: 'point-in-time copies of the same data' },
    { what: '.tmp/', why: 'temporary working files' },
  ]
  if (!options.includePlugins) {
    base.push({ what: 'plugins/', why: 'installed plugin payloads; re-installable, and 331 MB on the measured machine' })
  }
  return base
}
