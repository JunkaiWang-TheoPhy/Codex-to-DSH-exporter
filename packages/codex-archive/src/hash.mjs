// hash.mjs — 流式摘要与一次遍历的「摘要 + 压缩 + 落盘」。
//
// 语料实测 38 GB / 5536 个 rollout，最大单文件 206 MB，所以任何一处都不允许把
// 文件读进内存。本模块的全部操作都是流向的：读 → 摘要 → （可选）压缩 → 写。

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress } from 'node:zlib'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 摘要算法。写死 sha256——manifest 的 `sourceSha256` 字段名即契约。 */
const ALGORITHM = 'sha256'

/**
 * 流式计算一个文件的 sha256。
 * @param {string} path - 文件路径。
 * @returns {Promise<string>} 64 位小写十六进制摘要。
 */
export async function hashFile(path) {
  const hash = createHash(ALGORITHM)
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/**
 * 计算一段文本的 sha256。
 * @param {string | Buffer} value - 待摘要的内容。
 * @returns {string} 64 位小写十六进制摘要。
 */
export function hashValue(value) {
  return createHash(ALGORITHM).update(value).digest('hex')
}

/**
 * 把源文件流式复制到归档，同时算出**原始字节**与**存储字节**两个摘要。
 *
 * `sourceSha256` 在压缩之前取，这是归档的证据属性所在：它必须能证明归档与磁盘上
 * 原本的字节一致，而不是与压缩后的一致。
 *
 * `storedSha256` 是落盘字节的摘要，两个摘要都在一次遍历里算出。它存在的理由是实测的：
 * Node 的 zstd 解码器**接受尾随字节**——在帧后追加一个字节，解出来的明文一字不差，
 * 于是只比对解压后摘要的校验会对着一个已经被改过的文件报"通过"。存储字节摘要把
 * 这一类改动盖住，而它不依赖压缩是否可复现（zstd 的输出依赖分块边界，实测同一份
 * 输入分块不同结果不同，所以不能靠重压缩来比对）。
 * @param {string} sourcePath - 源文件，只读打开。
 * @param {string} destPath - 归档内的目标路径。
 * @param {{ compression?: import('./types.d.ts').ArchiveCompression, signal?: AbortSignal }} [options]
 * @returns {Promise<{ sourceBytes: number, sourceSha256: string, storedSha256: string, archiveBytes: number }>}
 */
export async function copyThroughDigest(sourcePath, destPath, options = {}) {
  const compression = options.compression ?? 'zstd'
  const hash = createHash(ALGORITHM)
  const storedHash = createHash(ALGORITHM)
  let sourceBytes = 0

  // 计数与摘要支路。用 Transform 而不是异步生成器函数——pipeline 对后者的处理
  // 不是「把上游喂进来」，实测会静默挂住。
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      sourceBytes += chunk.length
      hash.update(chunk)
      callback(null, chunk)
    },
  })

  // 存储支路必须在压缩**之后**：它要摘的是真正写下去的那些字节。
  const storeTap = new Transform({
    transform(chunk, _encoding, callback) {
      storedHash.update(chunk)
      callback(null, chunk)
    },
  })

  await mkdir(dirname(destPath), { recursive: true })
  const stages = [createReadStream(sourcePath), tap]
  if (compression === 'zstd') stages.push(createZstdCompress())
  stages.push(storeTap, createWriteStream(destPath))

  await pipeline(stages, options.signal ? { signal: options.signal } : {})

  const info = await stat(destPath)
  return {
    sourceBytes,
    sourceSha256: hash.digest('hex'),
    storedSha256: storedHash.digest('hex'),
    archiveBytes: info.size,
  }
}

/**
 * 原子写：先写同目录下的临时文件，再 rename 覆盖目标。
 *
 * 直接写目标文件的失败模式很难查——半个 JSON 会被下一次读取当成合法输入解析失败，
 * 或者更糟，被当成合法的空 manifest。rename 在同一文件系统上是原子的。
 * @param {string} path - 目标路径。
 * @param {string} content - 完整内容。
 * @returns {Promise<void>}
 */
export async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await pipeline(Readable.from([Buffer.from(content, 'utf8')]), createWriteStream(tmp))
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}
