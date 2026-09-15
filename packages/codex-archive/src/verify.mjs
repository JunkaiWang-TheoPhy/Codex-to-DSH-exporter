// verify.mjs — 按 manifest 校验一个归档。
//
// 规范 §6 定义了四项检查：
//   1. 逐条重算存储字节的摘要，与 `sourceSha256` 比对（压缩的先解压）
//   2. 完整性：每个会话目录必须有 source 文件；只有 normalized 的判定为无效
//   3. 账本一致：没有条目在 ledger 里是 complete 而 manifest 摘要不符
//   4. 声明性遗漏：`notCaptured` 存在且非空
//
// 校验**不声称**归档忠实复制了 Codex 持有的一切。它证明归档与 manifest 一致，而
// manifest 说明了取走了什么、没取什么。这是两个不同的断言，后者才是诚实的那个。
//
// 条目层面同时核两个摘要，因为它们是两个不同的断言，实测缺一不可：
//   - `sourceSha256`：解压后的字节等于导出时的原始字节（证据属性）
//   - `storedSha256`：落盘的字节等于导出时写下的字节
// 只核前者会漏掉一整类改动——Node 的 zstd 解码器接受尾随字节，在帧后追加字节后
// 明文一字不差，只核前者的校验会对被改过的文件报"通过"。

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import { join } from 'node:path'

/**
 * 存储字节的 sha256（不解压）。
 * @param {string} path - 归档内的存储路径。
 */
async function digestRaw(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/**
 * 对存储的字节求 sha256；压缩的先解压，这样摘要对应的是**原始**字节。
 *
 * 是否解压按存储路径的后缀判断，而不是按 manifest 的全局 `compression`。后者描述的是
 * **会话工件**的编码（规范 §2 的布局里只有会话带 `.zst`），环境文件一律明文——用一个
 * 全局标志去套两者，会让明文写的环境文件被当成压缩流解压而全部校验失败。
 * @param {string} path - 归档内的存储路径。
 */
async function digestStored(path) {
  const hash = createHash('sha256')
  if (path.endsWith('.zst')) {
    await pipeline(createReadStream(path), createZstdDecompress(), hash)
  } else {
    await pipeline(createReadStream(path), hash)
  }
  return hash.digest('hex')
}

/**
 * 校验一个归档。
 * @param {string} outDir - 归档根目录。
 * @returns {Promise<{ ok: boolean, checks: string[], results: { id: string, ok: boolean, detail: string }[], problems: string[] }>}
 */
export async function verifyArchive(outDir) {
  /** @type {{ id: string, ok: boolean, detail: string }[]} */
  const results = []
  /** @type {string[]} */
  const problems = []
  const checks = ['manifest-readable', 'entries-match-digest', 'session-source-present', 'ledger-agrees', 'notCaptured-nonempty']

  let manifest
  try {
    manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'))
  } catch (error) {
    return { ok: false, checks, results, problems: [`manifest.json unreadable: ${String(error?.message ?? error)}`] }
  }

  // 1) 逐条摘要。
  for (const entry of manifest.entries ?? []) {
    const path = join(outDir, entry.path)
    try {
      const actual = await digestStored(path)
      const sourceOk = actual === entry.sourceSha256
      // 落盘字节单独核一次。没有这一项，改一个字节的存储流仍然可能被判为通过。
      const raw = await digestRaw(path)
      const storedOk = raw === entry.storedSha256
      const ok = sourceOk && storedOk
      const detail = sourceOk && storedOk
        ? `source ${actual.slice(0, 12)}… stored ${raw.slice(0, 12)}…`
        : [
            sourceOk ? undefined : `source digest mismatch: manifest ${entry.sourceSha256.slice(0, 12)}…, stored ${actual.slice(0, 12)}…`,
            storedOk ? undefined : `stored digest mismatch: manifest ${entry.storedSha256.slice(0, 12)}…, on disk ${raw.slice(0, 12)}…`,
          ].filter(Boolean).join('; ')
      results.push({ id: `${entry.kind}:${entry.id}`, ok, detail })
      if (!sourceOk) problems.push(`${entry.id}: digest mismatch`)
      if (!storedOk) problems.push(`${entry.id}: stored digest mismatch`)
    } catch (error) {
      results.push({ id: `${entry.kind}:${entry.id}`, ok: false, detail: `unreadable: ${String(error?.message ?? error)}` })
      problems.push(`${entry.id}: artifact missing or unreadable`)
    }
  }

  // 1b) 派生层。它可重建，所以它坏了不是灾难——但它坏了必须**看得见**，否则下游会
  // 拿一份与当前分类器不符的 IR 当作归档的内容。只在条目记了摘要时才核。
  for (const entry of (manifest.entries ?? []).filter((e) => e.normalizedSha256 !== undefined)) {
    const path = join(outDir, 'sessions', entry.id, 'normalized.jsonl')
    try {
      const actual = await digestRaw(path)
      const ok = actual === entry.normalizedSha256
      results.push({
        id: `normalized:${entry.id}`,
        ok,
        detail: ok
          ? `sha256 ${actual.slice(0, 12)}…`
          : `normalized digest mismatch: manifest ${entry.normalizedSha256.slice(0, 12)}…, on disk ${actual.slice(0, 12)}…`,
      })
      if (!ok) problems.push(`${entry.id}: normalized digest mismatch`)
    } catch (error) {
      results.push({ id: `normalized:${entry.id}`, ok: false, detail: `unreadable: ${String(error?.message ?? error)}` })
      problems.push(`${entry.id}: normalized.jsonl missing or unreadable`)
    }
  }

  // 2) 完整性——每个会话目录必须有 source 文件。只有 normalized 的判定为无效。
  // 会话 source 文件名随 manifest 声明的压缩方式而定。
  const sourceName = manifest.compression === 'zstd' ? 'source.jsonl.zst' : 'source.jsonl'
  const sessionsRoot = join(outDir, 'sessions')
  let sessionDirs = []
  try {
    sessionDirs = (await readdir(sessionsRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    sessionDirs = []
  }
  const manifestSessions = new Set((manifest.entries ?? []).filter((e) => e.kind === 'session').map((e) => e.id))
  for (const id of sessionDirs) {
    if (!manifestSessions.has(id)) {
      problems.push(`sessions/${id}: directory present but not listed in the manifest`)
      continue
    }
    try {
      await stat(join(sessionsRoot, id, sourceName))
    } catch {
      problems.push(`sessions/${id}: no ${sourceName} (a directory holding only normalized.jsonl is invalid)`)
    }
  }

  // 3) 账本一致。
  let ledger
  try {
    ledger = JSON.parse(await readFile(join(outDir, 'ledger.json'), 'utf8'))
  } catch {
    problems.push('ledger.json unreadable')
    ledger = undefined
  }
  if (ledger !== undefined) {
    const byId = new Map((manifest.entries ?? []).filter((e) => e.kind === 'session').map((e) => [e.id, e]))
    for (const [id, row] of Object.entries(ledger.sessions ?? {})) {
      if (row.status !== 'complete') continue
      const entry = byId.get(id)
      if (entry === undefined) {
        problems.push(`ledger: ${id} is complete but has no manifest entry`)
        continue
      }
      if (entry.sourceSha256 !== row.sourceSha256) {
        problems.push(`ledger: ${id} digest disagrees with the manifest`)
      }
    }
  }

  // 4) 声明性遗漏。
  if (!Array.isArray(manifest.notCaptured) || manifest.notCaptured.length === 0) {
    problems.push('notCaptured is empty; an export that silently omits things is worse than one that says so')
  }

  return { ok: problems.length === 0 && results.every((r) => r.ok), checks, results, problems }
}
