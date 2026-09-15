// verify.test.mjs — 校验器。
//
// 校验器的价值全在**能否捕获篡改**上。一个永远通过的校验器比没有校验器更糟：
// 它会让人以为归档可信。所以每个用例都先制造一个具体缺陷，再断言它被抓住。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runExport } from '../src/export.mjs'
import { verifyArchive } from '../src/verify.mjs'
import { makeCodexHome, makeOutDir } from './helpers.mjs'

/** 造一份已导出且校验通过的归档，交给用例去破坏。 */
async function makeArchive(options = {}) {
  const home = await makeCodexHome(options)
  const out = await makeOutDir()
  const report = await runExport({ codexHome: home.home, outDir: out.outDir })
  return {
    home: home.home,
    outDir: out.outDir,
    report,
    cleanup: async () => { await home.cleanup(); await out.cleanup() },
  }
}

test('未动过的归档校验通过', async () => {
  const a = await makeArchive({ rollouts: 2 })
  try {
    const result = await verifyArchive(a.outDir)
    assert.equal(result.ok, true, JSON.stringify(result.problems))
    assert.equal(result.problems.length, 0)
    // 每个 manifest 条目一行，外加每个会话一条派生层记录。
    const sessions = a.report.manifest.entries.filter((e) => e.kind === 'session').length
    assert.equal(result.results.length, a.report.manifest.entries.length + sessions)
    assert.ok(result.results.every((r) => r.ok))
  } finally {
    await a.cleanup()
  }
})

test('捕获篡改：压缩流尾随一个字节即校验失败', async () => {
  const a = await makeArchive({ rollouts: 1 })
  try {
    const entry = a.report.manifest.entries.find((e) => e.kind === 'session')
    const path = join(a.outDir, entry.path)
    // 这一条是本套件里最要紧的用例：在 zstd 帧后追加一个字节，**解压出来的明文一字不差**
    // （实测 Node 的解码器接受尾随字节）。只比对解压后摘要的校验器会对它报"通过"，
    // 而文件已经不是当初写下的那个。存储摘要必须把它抓住。
    const original = await readFile(path)
    await writeFile(path, Buffer.concat([original, Buffer.from([0])]))

    const result = await verifyArchive(a.outDir)
    assert.equal(result.ok, false, '被改动的工件必须让校验失败')
    assert.ok(
      result.problems.some((p) => /stored digest mismatch/.test(p)),
      `必须由存储摘要抓住：${JSON.stringify(result.problems)}`,
    )
  } finally {
    await a.cleanup()
  }
})

test('捕获篡改：改动明文内容同样失败（源摘要这一路仍然有效）', async () => {
  const a = await makeArchive({ rollouts: 1 })
  try {
    const entry = a.report.manifest.entries.find((e) => e.kind === 'environment-file')
    const path = join(a.outDir, entry.path)
    await writeFile(path, `${await readFile(path, 'utf8')}<!-- appended -->\n`, 'utf8')

    const result = await verifyArchive(a.outDir)
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((p) => /digest mismatch/.test(p)), JSON.stringify(result.problems))
  } finally {
    await a.cleanup()
  }
})

test('两个摘要的分工：会话上两者不同，明文环境文件上两者相同', async () => {
  const a = await makeArchive({ rollouts: 1 })
  try {
    for (const entry of a.report.manifest.entries) {
      assert.match(entry.storedSha256, /^[0-9a-f]{64}$/, `${entry.path} 必须有存储摘要`)
      if (entry.kind === 'session') {
        assert.notEqual(entry.storedSha256, entry.sourceSha256, '压缩后的存储摘要不可能等于原文摘要')
      } else {
        assert.equal(entry.storedSha256, entry.sourceSha256, '明文写入时两个摘要本就该相同')
      }
    }
  } finally {
    await a.cleanup()
  }
})

test('捕获截断：工件被截短同样失败', async () => {
  const a = await makeArchive({ rollouts: 1 })
  try {
    const entry = a.report.manifest.entries.find((e) => e.kind === 'session')
    await truncate(join(a.outDir, entry.path), 8)

    const result = await verifyArchive(a.outDir)
    assert.equal(result.ok, false)
  } finally {
    await a.cleanup()
  }
})

test('捕获缺失：source 文件不在即失败（只有 normalized 是无效的）', async () => {
  const a = await makeArchive({ rollouts: 1 })
  try {
    const entry = a.report.manifest.entries.find((e) => e.kind === 'session')
    await rm(join(a.outDir, entry.path), { force: true })

    const result = await verifyArchive(a.outDir)
    assert.equal(result.ok, false)
    assert.ok(
      result.problems.some((p) => /no source\.jsonl\.zst|unreadable/.test(p)),
      '缺 source 必须被点名，而不是被当成「文件不存在」泛泛带过',
    )
    // normalized.jsonl 仍在——这正是规范说"只有 normalized 判定为无效"的场景。
    const norm = await readFile(join(a.outDir, 'sessions', entry.id, 'normalized.jsonl'), 'utf8')
    assert.ok(norm.split('\n').filter((l) => l.trim().length > 0).length > 0, '（本用例只确认 normalized 未被当作替代品）')
    assert.ok(!result.results.some((r) => r.ok && r.id.includes(entry.id) && r.detail.includes('stored')),
      '缺件的条目不得留下任何"通过"的记录')
  } finally {
    await a.cleanup()
  }
})

test('捕获账本不一致：manifest 摘要与账本不符即失败', async () => {
  const a = await makeArchive({ rollouts: 1 })
  try {
    const ledgerPath = join(a.outDir, 'ledger.json')
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
    const id = Object.keys(ledger.sessions)[0]
    ledger.sessions[id].sourceSha256 = 'f'.repeat(64)
    await writeFile(ledgerPath, JSON.stringify(ledger), 'utf8')

    const result = await verifyArchive(a.outDir)
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((p) => /ledger.*disagrees/.test(p)), JSON.stringify(result.problems))
  } finally {
    await a.cleanup()
  }
})

test('捕获空的 notCaptured：声明缺失即失败', async () => {
  const a = await makeArchive({ rollouts: 1 })
  try {
    const manifestPath = join(a.outDir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.notCaptured = []
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')

    const result = await verifyArchive(a.outDir)
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((p) => /notCaptured is empty/.test(p)))
  } finally {
    await a.cleanup()
  }
})

test('不可读的 manifest 返回失败而不是抛异常', async () => {
  const a = await makeArchive({ rollouts: 1 })
  try {
    await writeFile(join(a.outDir, 'manifest.json'), '{ not json', 'utf8')
    const result = await verifyArchive(a.outDir)
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((p) => /manifest\.json unreadable/.test(p)))
  } finally {
    await a.cleanup()
  }
})

test('派生层也纳入校验：normalized.jsonl 被改动即失败', async () => {
  const a = await makeArchive({ rollouts: 1 })
  try {
    const entry = a.report.manifest.entries.find((e) => e.kind === 'session')
    const path = join(a.outDir, 'sessions', entry.id, 'normalized.jsonl')
    const rows = (await readFile(path, 'utf8')).trim().split('\n')
    // 把某一行的 text 改掉——派生层被改，源文件一字未动。
    const row = JSON.parse(rows[0])
    rows[0] = JSON.stringify({ ...row, injected: true })
    await writeFile(path, `${rows.join('\n')}\n`, 'utf8')

    const result = await verifyArchive(a.outDir)
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((p) => /normalized digest mismatch/.test(p)), JSON.stringify(result.problems))
  } finally {
    await a.cleanup()
  }
})

test('派生层缺失即失败：删掉 normalized.jsonl 不该被判为通过', async () => {
  const a = await makeArchive({ rollouts: 1 })
  try {
    const entry = a.report.manifest.entries.find((e) => e.kind === 'session')
    await rm(join(a.outDir, 'sessions', entry.id, 'normalized.jsonl'), { force: true })

    const result = await verifyArchive(a.outDir)
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((p) => /normalized\.jsonl missing or unreadable/.test(p)))
  } finally {
    await a.cleanup()
  }
})

test('环境文件也纳入校验，不只是会话', async () => {
  const a = await makeArchive({ rollouts: 1 })
  try {
    const entry = a.report.manifest.entries.find((e) => e.kind === 'environment-file')
    assert.ok(entry, '合成 home 应有环境文件')
    await writeFile(join(a.outDir, entry.path), 'tampered\n', 'utf8')

    const result = await verifyArchive(a.outDir)
    assert.equal(result.ok, false)
    const row = result.results.find((r) => r.id === `environment-file:${entry.id}`)
    assert.equal(row?.ok, false)
  } finally {
    await a.cleanup()
  }
})
