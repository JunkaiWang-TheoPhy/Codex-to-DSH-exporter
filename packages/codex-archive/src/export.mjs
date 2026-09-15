// export.mjs — 导出端主流程。
//
// 契约（docs/archive-format.md §1）：**全部原样，唯一例外是凭据**。
//
// 关于凭据的作用范围，本实现做一个必须显式说明的决定：
//
//   - **环境文件**（config.toml / AGENTS.md / hooks.json / rules / skills / prompts /
//     agents）先扫描再写入。命中即脱敏，并把 finding 记进 manifest。
//   - **rollout 逐字节照搬，不脱敏。** 这不是遗漏。`sourceSha256` 是**原始字节**的
//     摘要，脱敏会让摘要与内容不符，从而摧毁归档的证据属性——而那正是本格式存在的
//     理由（规范 §2）。凭据实际住在环境文件与 auth.json 里，auth.json 根本不复制。
//   - 扫描 38 GB 的 rollout 内容也是不可行的开销，且那些内容本身是用户自己的对话。
//
// 也就是说：**环境面拒绝写入凭据，会话面保持逐字节完整**。这个划分写进 manifest 的
// `notCaptured`，不让它只存在于代码注释里。

import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createZstdCompress } from 'node:zlib'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

import { copyThroughDigest, hashFile, hashValue, writeAtomic } from './hash.mjs'
import { isScannable, scanAndRedact } from './credentials.mjs'
import { classifyRollout, summarizeRollout } from './classify.mjs'
import { defaultOmissions, scanEnvironment, scanSessions } from './scan.mjs'

const FORMAT = 'codex-exporter/archive'
const TOOL = { name: 'codex-to-dsh-exporter', version: '0.1.0' }

/**
 * 探测内置 zstd 是否可用。
 *
 * 仓库 `engines` 写的是 >=22.13，而 `createZstdCompress` 是 22.15 才有的。所以这里
 * 实测而不是假定：不可用就降级为不压缩，并把 `compression: 'none'` 如实写进 manifest。
 * @returns {import('./types.d.ts').ArchiveCompression}
 */
export function detectCompression() {
  try {
    const stream = createZstdCompress()
    stream.destroy()
    return 'zstd'
  } catch {
    return 'none'
  }
}

/** 读一个 JSON 文件；不存在或不可解析都返回 undefined（首次运行的正常情况）。 */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 会话在归档内的目录。 */
function sessionDirRel(id) {
  return `sessions/${id}`
}

/**
 * 跑一次导出。
 * @param {import('./types.d.ts').ExportOptions} options
 * @returns {Promise<import('./types.d.ts').ExportReport>}
 */
export async function runExport(options) {
  const started = Date.now()
  const home = options.codexHome
  const outDir = options.outDir
  const includeSessions = options.includeSessions !== false
  const compression = detectCompression()
  const signal = options.signal
  const progress = options.onProgress ?? (() => {})

  if (!existsSync(home)) throw new Error(`no Codex home at ${home}`)
  await mkdir(outDir, { recursive: true })

  // 账本与上一轮 manifest 的位置由格式固定，调用方不该重新实现这段查找。
  // 缺省时自动读取同一 outDir 里已有的那份；读不到就是首次运行。
  // 只认入参的话，忘传的后果是**静默全量重拷**——38 GB 的代价，且没有任何提示。
  const previous = options.previous ?? await readJson(join(outDir, 'manifest.json'))
  const ledgerIn = options.ledger ?? await readJson(join(outDir, 'ledger.json'))

  /** 上一轮 manifest 的条目索引，用于复用。 */
  const previousEntries = new Map((previous?.entries ?? []).map((e) => [`${e.kind}:${e.id}`, e]))
  /** @type {import('./types.d.ts').ArchiveEntry[]} */
  const entries = []
  /** @type {import('./types.d.ts').SecretFinding[]} */
  const secrets = []
  /** @type {Record<string, import('./types.d.ts').LedgerRecord>} */
  const ledgerSessions = { ...(ledgerIn?.sessions ?? {}) }
  let copied = 0
  let reused = 0
  let skipped = 0
  let sourceBytes = 0
  let archiveBytes = 0

  // ---- 会话 ----------------------------------------------------------------

  if (includeSessions) {
    /** @type {Awaited<ReturnType<typeof scanSessions>> extends AsyncGenerator<infer T> ? T[] : never} */
    const sessions = []
    for await (const session of scanSessions(home, { signal })) {
      if (signal?.aborted) throw new Error('aborted')
      sessions.push(session)
    }
    progress({ phase: 'scan', done: sessions.length, total: sessions.length, detail: `${sessions.length} rollouts found` })

    const limit = typeof options.limit === 'number' && options.limit > 0
      ? Math.min(options.limit, sessions.length)
      : sessions.length
    let done = 0
    for (const session of sessions.slice(0, limit)) {
      if (signal?.aborted) throw new Error('aborted')
      done += 1
      const key = `session:${session.id}`
      const prev = previousEntries.get(key)
      const ledgerRow = ledgerSessions[session.id]
      // 两条路径（复用与重拷）都要往这个目录里写派生层，所以目录先定下来。
      const dirRel = sessionDirRel(session.id)
      const dirAbs = join(outDir, dirRel)

      // 复用条件：账本说完成，(bytes, mtime) 未变，且归档里的工件仍在。
      //
      // 上一轮 manifest 条目是可选的：账本加一次 stat 就足以重建条目。这很重要——
      // 一份被单独搬走的账本（或 manifest 损坏）不该逼出一次全量重拷。
      const sourceNameForReuse = compression === 'zstd' ? 'source.jsonl.zst' : 'source.jsonl'
      const reusablePath = prev?.path ?? `${sessionDirRel(session.id)}/${sourceNameForReuse}`
      const reusable =
        ledgerRow?.status === 'complete'
        && ledgerRow.sourceBytes === session.bytes
        && ledgerRow.mtimeMs === session.mtimeMs
        && ledgerRow.sourceSha256 !== ''
        && existsSync(join(outDir, reusablePath))

      if (reusable) {
        const reusableAbs = join(outDir, reusablePath)
        const archiveBytesOnDisk = (await stat(reusableAbs)).size
        // 复用时必须把存储摘要重新算出，不能从上一轮 manifest 抄：工件可能被外部
        // 改过，而"复用"的语义是"归档里的这份仍然等于本轮该有的那份"。代价是每次
        // 续跑对已有工件多读一遍（只读，不重写），换掉的是校验器里那个盲点。
        const storedSha256 = await hashFile(reusableAbs)

        // 派生层不复用，每轮重建。
        //
        // 这一条是实测发现的：分类器属于**代码**，源文件属于**数据**，用数据侧的
        // (bytes, mtime) 判断派生层是否最新是个范畴错误——改了分类器、源文件一字未动，
        // 复用的仍是旧分类器写下的 normalized.jsonl，而它看上去完全正常。重建一份
        // 派生层的代价只是 CPU，源文件那一次昂贵的压缩拷贝仍然被复用。
        const normalized = await writeNormalized(session.sourcePath, join(dirAbs, 'normalized.jsonl'), signal)

        entries.push({
          kind: 'session',
          id: session.id,
          path: reusablePath,
          sourcePath: session.sourcePathRel,
          sourceBytes: session.bytes,
          sourceSha256: ledgerRow.sourceSha256,
          archiveBytes: archiveBytesOnDisk,
          storedSha256,
          normalizedSha256: normalized.sha256,
        })
        sourceBytes += session.bytes
        archiveBytes += archiveBytesOnDisk
        reused += 1
        if (done % 250 === 0) progress({ phase: 'copy', done, total: limit, detail: 'reused' })
        continue
      }

      await mkdir(dirAbs, { recursive: true })

      try {
        // 1) 源文件：逐字节 + 原始字节摘要（压缩前）。
        const sourceName = compression === 'zstd' ? 'source.jsonl.zst' : 'source.jsonl'
        const copy = await copyThroughDigest(
          session.sourcePath,
          join(dirAbs, sourceName),
          { compression, ...(signal ? { signal } : {}) },
        )

        // 2) source.sha256：单独成文件，便于外部工具直接核对而不必解析 manifest。
        await writeAtomic(join(dirAbs, 'source.sha256'), `${copy.sourceSha256}  ${session.sourcePathRel}\n`)

        // 3) normalized.jsonl：派生层，行级流式写。
        const normalized = await writeNormalized(session.sourcePath, join(dirAbs, 'normalized.jsonl'), signal)

        // 4) meta.json：分类摘要。
        const meta = await summarizeRollout(session.sourcePath, signal ? { signal } : {})
        await writeAtomic(join(dirAbs, 'meta.json'), `${JSON.stringify({
          id: session.id,
          layout: session.layout,
          sourcePath: session.sourcePathRel,
          sourceBytes: copy.sourceBytes,
          sourceSha256: copy.sourceSha256,
          ...meta,
        }, null, 2)}\n`)

        entries.push({
          kind: 'session',
          id: session.id,
          path: `${dirRel}/${sourceName}`,
          sourcePath: session.sourcePathRel,
          sourceBytes: copy.sourceBytes,
          sourceSha256: copy.sourceSha256,
          archiveBytes: copy.archiveBytes,
          storedSha256: copy.storedSha256,
          normalizedSha256: normalized.sha256,
        })
        sourceBytes += copy.sourceBytes
        archiveBytes += copy.archiveBytes
        copied += 1

        // 只有三个文件都写成功才推进账本——partial 绝不留在校验器会接受的位置。
        ledgerSessions[session.id] = {
          sourcePath: session.sourcePathRel,
          sourceBytes: session.bytes,
          mtimeMs: session.mtimeMs,
          sourceSha256: copy.sourceSha256,
          capturedAt: Date.now(),
          status: 'complete',
        }
      } catch (error) {
        skipped += 1
        ledgerSessions[session.id] = {
          sourcePath: session.sourcePathRel,
          sourceBytes: session.bytes,
          mtimeMs: session.mtimeMs,
          sourceSha256: '',
          capturedAt: Date.now(),
          status: 'failed',
          reason: String(error?.message ?? error),
        }
      }

      if (done % 50 === 0 || done === limit) {
        progress({ phase: 'copy', done, total: limit, detail: `${copied} copied, ${reused} reused, ${skipped} failed` })
      }
    }
  }

  // ---- 环境面 --------------------------------------------------------------

  for await (const item of scanEnvironment(home, { signal })) {
    if (signal?.aborted) throw new Error('aborted')
    const key = `${item.kind}:${item.id}`
    const prev = previousEntries.get(key)
    const destRel = `environment/${item.sourcePathRel}`
    const destAbs = join(outDir, destRel)

    let body
    try {
      body = await readFile(item.sourcePath, 'utf8')
    } catch {
      skipped += 1
      continue
    }

    let payload = body
    let redactedCount = 0
    if (isScannable(item.sourcePathRel)) {
      const scanned = scanAndRedact(body, item.sourcePathRel)
      payload = scanned.redacted
      redactedCount = scanned.hits
      secrets.push(...scanned.findings)
    }

    const digest = hashValue(payload)
    const reusableEnv = prev?.sourceSha256 === digest && existsSync(destAbs)

    if (reusableEnv) {
      const bytesOnDisk = (await stat(destAbs)).size
      // 环境文件是明文，两个摘要相同——但同样现场重算，理由与会话复用一致。
      const storedSha256 = await hashFile(destAbs)
      entries.push(prev === undefined ? {
        kind: item.kind, id: item.id, path: destRel, sourcePath: item.sourcePathRel,
        sourceBytes: bytesOnDisk, sourceSha256: digest, archiveBytes: bytesOnDisk, storedSha256,
      } : { ...prev, archiveBytes: bytesOnDisk, storedSha256 })
      sourceBytes += bytesOnDisk
      archiveBytes += bytesOnDisk
      reused += 1
      continue
    }

    await mkdir(dirname(destAbs), { recursive: true })
    await writeFile(destAbs, payload, 'utf8')
    const bytes = Buffer.byteLength(payload, 'utf8')
    entries.push({
      kind: item.kind,
      id: item.id,
      path: destRel,
      sourcePath: item.sourcePathRel,
      sourceBytes: bytes,
      sourceSha256: digest,
      archiveBytes: bytes,
      storedSha256: digest,
    })
    sourceBytes += bytes
    archiveBytes += bytes
    copied += 1
    if (redactedCount > 0) {
      progress({ phase: 'copy', done: copied, total: copied, detail: `${item.sourcePathRel}: ${redactedCount} credential(s) refused` })
    }
  }

  // ---- 清单与账本 -----------------------------------------------------------

  progress({ phase: 'ledger', done: 0, total: 1 })
  const /** @type {import('./types.d.ts').ArchiveLedger} */ ledger = {
    version: 1,
    updatedAt: Date.now(),
    sessions: ledgerSessions,
  }

  const /** @type {Map<string, number>} */ counts = new Map()
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1)

  const notCaptured = [
    ...defaultOmissions({ includePlugins: options.includePlugins === true }),
    {
      what: 'credentials inside session rollouts',
      why: 'rollouts are copied byte-for-byte so sourceSha256 matches the original; redacting them would break that. Credentials in the environment surface are refused.',
    },
  ]

  const /** @type {import('./types.d.ts').ArchiveManifest} */ manifest = {
    format: FORMAT,
    version: 1,
    createdAt: started,
    tool: TOOL,
    source: {
      codexHome: home,
      ...(await firstMeta(entries, options) ?? {}),
      machine: options.includeMachine === true ? hostname() : null,
    },
    compression,
    counts: Object.fromEntries([...counts.entries()].sort()),
    totals: { sourceBytes, archiveBytes },
    entries,
    notCaptured,
    secrets,
  }

  progress({ phase: 'manifest', done: 0, total: 2 })
  await writeAtomic(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeAtomic(join(outDir, 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`)
  progress({ phase: 'done', done: 1, total: 1 })

  return {
    manifest,
    ledger,
    copied,
    reused,
    skipped,
    secrets,
    elapsedMs: Date.now() - started,
  }
}

/**
 * manifest 的 `source.cliVersion` / `originator`。
 *
 * 取自会话的 `session_meta`——Codex 没有单独的版本文件，而 session_meta 里带
 * `cli_version` 与 `originator`（实测字段名如此）。读一个会话的头部即可，不扫全量。
 */
async function firstMeta(entries, options) {
  const metaPath = entries.find((e) => e.kind === 'session')
  if (metaPath === undefined) return undefined
  try {
    const head = await readHead(join(options.codexHome, metaPath.sourcePath))
    if (head === undefined) return undefined
    const record = JSON.parse(head)
    const payload = record?.payload ?? {}
    const out = {}
    if (typeof payload.cli_version === 'string') out.cliVersion = payload.cli_version
    if (typeof payload.originator === 'string') out.originator = payload.originator
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

/**
 * 读一个文件的首行。
 *
 * 只读固定大小的前缀而不是整个文件——rollout 最大实测 206 MB，而 session_meta 是首行。
 * 失败返回 undefined：版本信息缺失不该让整次导出失败。
 * @param {string} path
 * @returns {Promise<string | undefined>}
 */
async function readHead(path) {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = text.indexOf('\n')
    return newline === -1 ? text : text.slice(0, newline)
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

/**
 * 写 `normalized.jsonl`：一行一个 IR 条目，行级流式。
 *
 * 明文不压缩，与规范 §2 的目录布局一致——它是派生层，可读性是它存在的理由。
 *
 * 返回值里的摘要是**落盘字节**的摘要，写完时顺手算，别处不再读一遍这个文件。
 * `lines` 的用处是把"这一层是空的"变成可断言的事实：一份 0 行的派生层与一份正常
 * 的派生层在文件系统上长得一样。
 * @param {string} sourcePath - rollout 路径。
 * @param {string} destPath - 归档内的目标路径。
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ sha256: string, bytes: number, lines: number }>}
 */
async function writeNormalized(sourcePath, destPath, signal) {
  const { createWriteStream } = await import('node:fs')
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256')
  const stream = createWriteStream(destPath, { encoding: 'utf8' })
  let bytes = 0
  let lines = 0
  try {
    for await (const entry of classifyRollout(sourcePath, signal ? { signal } : {})) {
      const chunk = `${JSON.stringify(entry)}\n`
      bytes += Buffer.byteLength(chunk, 'utf8')
      lines += 1
      hash.update(chunk)
      if (!stream.write(chunk)) {
        await new Promise((resolve) => stream.once('drain', resolve))
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      stream.end((error) => (error ? reject(error) : resolve(undefined)))
    })
  }
  return { sha256: hash.digest('hex'), bytes, lines }
}

/** 清理一个不完整的会话目录。导出中途失败时调用，避免 partial 被误当成完整。 */
export async function discardPartial(outDir, id) {
  await rm(join(outDir, sessionDirRel(id)), { recursive: true, force: true })
}
