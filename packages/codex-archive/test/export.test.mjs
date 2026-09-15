// export.test.mjs — 导出端端到端。
//
// 这些是规范里的硬要求，每一条都对应一次真实失败模式：
//   只读保证    —— 导出器动了源数据，用户的历史被改坏且不可恢复
//   凭据拒绝    —— 明文密钥进了归档，而归档会被搬来搬去
//   续跑        —— 第二次运行静默全量重拷，38 GB 的代价且没有提示
//   声明性遗漏  —— 悄悄少拿东西，事后无从知道

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runExport } from '../src/export.mjs'
import { hashFile } from '../src/hash.mjs'
import { makeCodexHome, makeOutDir, snapshotTree } from './helpers.mjs'

test('只读保证：导出前后源树逐字节不变', async () => {
  const { home, cleanup } = await makeCodexHome({ rollouts: 3 })
  const { outDir, cleanup: cleanOut } = await makeOutDir()
  try {
    const before = await snapshotTree(home)
    // 摘要而非只比大小与时间——大小相同的内容改写不会被时间戳以外的信号发现。
    const digestsBefore = {}
    for (const rel of Object.keys(before)) digestsBefore[rel] = await hashFile(join(home, rel))

    await runExport({ codexHome: home, outDir })

    const after = await snapshotTree(home)
    assert.deepEqual(after, before, '源树的文件集合、大小与修改时间都必须不变')
    for (const rel of Object.keys(before)) {
      assert.equal(await hashFile(join(home, rel)), digestsBefore[rel], `${rel} 内容不得改变`)
    }
  } finally {
    await cleanup()
    await cleanOut()
  }
})

test('凭据拒绝：明文密钥不出现在归档的任何文件里', async () => {
  const secret = 'abcdefghijklmnopqrstuvwxyz012345'
  const { home, cleanup } = await makeCodexHome({ rollouts: 1 })
  const { outDir, cleanup: cleanOut } = await makeOutDir()
  try {
    const report = await runExport({ codexHome: home, outDir })
    assert.ok(report.secrets.length > 0, '合成 config.toml 里的 Bearer 值必须被命中')

    // 逐个文件读，确认明文不在归档的任何位置。
    const stack = [outDir]
    while (stack.length > 0) {
      const dir = stack.pop()
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) { stack.push(path); continue }
        const body = await readFile(path, 'utf8').catch(() => '')
        assert.ok(!body.includes(secret), `${path} 不得含有明文密钥`)
      }
    }

    // finding 只带脱敏片段，且脱敏值本身不等于原值。
    for (const finding of report.secrets) {
      assert.notEqual(finding.redacted, secret)
      assert.ok(finding.redacted.includes('…'), '脱敏值应当省略中段')
      assert.ok(finding.line > 0, 'finding 必须带行号')
      assert.ok(finding.pattern.length > 0, 'finding 必须说明命中了哪条规则')
    }

    const archived = await readFile(join(outDir, 'environment/config.toml'), 'utf8')
    assert.ok(archived.includes('<redacted:'), '写入归档的应是占位符')
    assert.ok(archived.includes('https://example.invalid/mcp'), '非凭据内容必须保留')
  } finally {
    await cleanup()
    await cleanOut()
  }
})

test('续跑：第二次运行不传任何入参也应复用，而不是静默全量重拷', async () => {
  const { home, cleanup } = await makeCodexHome({ rollouts: 4 })
  const { outDir, cleanup: cleanOut } = await makeOutDir()
  try {
    const first = await runExport({ codexHome: home, outDir })
    assert.equal(first.copied, first.manifest.entries.length)
    assert.equal(first.reused, 0)

    // 关键：不传 ledger / previous。账本位置由格式固定，调用方不该重新实现这段查找。
    const second = await runExport({ codexHome: home, outDir })
    assert.equal(second.copied, 0, '同源重跑必须零复制')
    assert.equal(second.reused, first.manifest.entries.length)
    assert.deepEqual(
      second.manifest.entries.map((e) => e.sourceSha256).sort(),
      first.manifest.entries.map((e) => e.sourceSha256).sort(),
      '复用后的条目必须与首轮一致',
    )
  } finally {
    await cleanup()
    await cleanOut()
  }
})

test('增量：只改动一个 rollout，只有它被重做', async () => {
  const { home, cleanup } = await makeCodexHome({ rollouts: 4 })
  const { outDir, cleanup: cleanOut } = await makeOutDir()
  try {
    const first = await runExport({ codexHome: home, outDir })
    const target = first.manifest.entries.find((e) => e.kind === 'session')
    assert.ok(target)

    await writeFile(
      join(home, target.sourcePath),
      `${await readFile(join(home, target.sourcePath), 'utf8')}\n`,
      'utf8',
    )

    const second = await runExport({ codexHome: home, outDir })
    assert.equal(second.copied, 1, '只有被改动的那个需要重做')
    assert.equal(second.reused, first.manifest.entries.length - 1)

    // 内容的改动必须反映到摘要上，否则"复用"会掩盖一次真实的变更。
    const updated = second.manifest.entries.find((e) => e.kind === 'session' && e.id === target.id)
    assert.notEqual(updated.sourceSha256, target.sourceSha256)
  } finally {
    await cleanup()
    await cleanOut()
  }
})

test('续跑时派生层被重建，而不是跟着源文件一起被复用', async () => {
  const { home, cleanup } = await makeCodexHome({ rollouts: 2 })
  const { outDir, cleanup: cleanOut } = await makeOutDir()
  try {
    const first = await runExport({ codexHome: home, outDir })
    const session = first.manifest.entries.find((e) => e.kind === 'session')
    const normalizedPath = join(outDir, 'sessions', session.id, 'normalized.jsonl')
    const before = await stat(normalizedPath)

    // 等一个明确的间隔，避免把"同一毫秒内重写"误判成没重建。
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await runExport({ codexHome: home, outDir })
    const after = await stat(normalizedPath)

    assert.equal(second.reused, first.manifest.entries.length, '源工件仍然应当复用')
    assert.ok(after.mtimeMs > before.mtimeMs, 'normalized.jsonl 必须被重写：分类器是代码，源文件是数据')
    // 内容是一样的——重建不等于内容会变，这一条防止把"重建"实现成"写坏"。
    assert.equal(second.manifest.entries.find((e) => e.kind === 'session').normalizedSha256, session.normalizedSha256)
  } finally {
    await cleanup()
    await cleanOut()
  }
})

test('清单：字段齐备、counts 与 entries 一致、totals 自洽', async () => {
  const { home, cleanup } = await makeCodexHome({ rollouts: 3 })
  const { outDir, cleanup: cleanOut } = await makeOutDir()
  try {
    const { manifest } = await runExport({ codexHome: home, outDir })

    assert.equal(manifest.format, 'codex-exporter/archive')
    assert.equal(manifest.version, 1)
    assert.equal(manifest.compression, 'zstd')
    assert.equal(manifest.source.machine, null, '默认不得记录机器名')
    assert.ok(manifest.source.cliVersion, '会话头里的 cli_version 应被带出')
    assert.ok(manifest.source.originator)

    const counted = Object.values(manifest.counts).reduce((a, b) => a + b, 0)
    assert.equal(counted, manifest.entries.length, 'counts 之和必须等于条目数')

    const source = manifest.entries.reduce((a, e) => a + e.sourceBytes, 0)
    const archive = manifest.entries.reduce((a, e) => a + e.archiveBytes, 0)
    assert.equal(manifest.totals.sourceBytes, source)
    assert.equal(manifest.totals.archiveBytes, archive)

    // 每个条目都必须能落回磁盘。
    for (const entry of manifest.entries) {
      const info = await stat(join(outDir, entry.path))
      assert.equal(info.size, entry.archiveBytes, `${entry.path} 的实际大小应与清单一致`)
      assert.match(entry.sourceSha256, /^[0-9a-f]{64}$/)
      assert.match(entry.storedSha256, /^[0-9a-f]{64}$/)
    }
  } finally {
    await cleanup()
    await cleanOut()
  }
})

test('声明性遗漏：notCaptured 非空，且点名 auth.json 与 sqlite', async () => {
  const { home, cleanup } = await makeCodexHome({ rollouts: 1 })
  const { outDir, cleanup: cleanOut } = await makeOutDir()
  try {
    const { manifest } = await runExport({ codexHome: home, outDir })
    assert.ok(manifest.notCaptured.length > 0, '规范要求 notCaptured 非空')
    for (const omission of manifest.notCaptured) {
      assert.ok(omission.what.length > 0)
      assert.ok(omission.why.length > 0, '每条遗漏都必须带理由')
    }
    const named = manifest.notCaptured.map((o) => o.what).join(' ')
    assert.match(named, /auth\.json/)
    assert.match(named, /sqlite/)
    assert.match(named, /log/)
  } finally {
    await cleanup()
    await cleanOut()
  }
})

test('会话工件：source 与 normalized 并存，且 source 是压缩的原文', async () => {
  const { home, cleanup } = await makeCodexHome({ rollouts: 1 })
  const { outDir, cleanup: cleanOut } = await makeOutDir()
  try {
    const { manifest } = await runExport({ codexHome: home, outDir })
    const session = manifest.entries.find((e) => e.kind === 'session')
    const dir = join(outDir, 'sessions', session.id)

    for (const name of ['source.jsonl.zst', 'source.sha256', 'normalized.jsonl', 'meta.json']) {
      await stat(join(dir, name))
    }

    // source.sha256 独立成文件，便于外部工具直接核对。
    const sidecar = await readFile(join(dir, 'source.sha256'), 'utf8')
    assert.ok(sidecar.startsWith(session.sourceSha256), 'sidecar 必须与清单同摘要')

    // normalized 每行都是合法 JSON 且带 kind。
    const lines = (await readFile(join(dir, 'normalized.jsonl'), 'utf8')).trim().split('\n')
    assert.ok(lines.length > 0)
    for (const line of lines) {
      const entry = JSON.parse(line)
      assert.ok(typeof entry.kind === 'string' && entry.kind.length > 0)
      assert.ok(Number.isInteger(entry.line) && entry.line > 0)
    }

    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))
    assert.equal(meta.id, session.id)
    assert.ok(meta.counts && typeof meta.counts === 'object')
    assert.ok(!('line' in meta) && !('kind' in meta), 'meta 不得混入分类器簿记字段')
  } finally {
    await cleanup()
    await cleanOut()
  }
})

test('limit：受限于样本数，且仍是一份自洽的部分归档', async () => {
  const { home, cleanup } = await makeCodexHome({ rollouts: 3 })
  const { outDir, cleanup: cleanOut } = await makeOutDir()
  try {
    const { manifest } = await runExport({ codexHome: home, outDir, limit: 1 })
    assert.equal(manifest.counts.session, 1, '只应取 1 个会话')
    assert.equal(manifest.entries.filter((e) => e.kind === 'session').length, 1)
    // 环境面不受 limit 影响——限的是会话样本，不是环境。
    assert.ok(manifest.counts['environment-file'] >= 2)
  } finally {
    await cleanup()
    await cleanOut()
  }
})

test('不存在的 codex home 必须报错，而不是产出一份空归档', async () => {
  const { outDir, cleanup } = await makeOutDir()
  try {
    await assert.rejects(
      () => runExport({ codexHome: join(outDir, 'nope'), outDir }),
      /no Codex home/,
    )
  } finally {
    await cleanup()
  }
})
