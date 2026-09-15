#!/usr/bin/env node
// codex-archive — 命令行入口。
//
//   codex-archive export --codex-home ~/.codex --out ./my-archive [--limit 50]
//   codex-archive verify ./my-archive
//
// 默认行为是保守的：机器名不记、插件载荷不搬、写盘量在开始前先说清楚。

import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { runExport } from '../src/export.mjs'
import { verifyArchive } from '../src/verify.mjs'

const USAGE = `codex-archive — read a Codex home read-only and write a portable archive

Usage
  codex-archive export [options]
  codex-archive verify <archive-dir>

Export options
  --codex-home <path>   Codex home to read (default: $CODEX_HOME or ~/.codex)
  --out <path>          Archive directory to write (required)
  --limit <n>           Copy at most n session rollouts (for a sampled run)
  --include-plugins     Copy plugin payloads (default: inventory only)
  --include-machine     Record the machine hostname (default: omitted)
  --quiet               Do not print per-step progress
  --help                Show this help

Exit codes
  0  success
  1  usage error
  2  a check failed
`

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function main(argv) {
  const command = argv[0]
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE)
    return command === undefined ? 1 : 0
  }

  if (command === 'export') {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        'codex-home': { type: 'string' },
        out: { type: 'string' },
        limit: { type: 'string' },
        'include-plugins': { type: 'boolean', default: false },
        'include-machine': { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    })
    if (values.help === true) { process.stdout.write(USAGE); return 0 }
    if (values.out === undefined) {
      process.stderr.write('export requires --out <path>\n\n' + USAGE)
      return 1
    }

    const codexHome = resolve(values['codex-home'] ?? process.env.CODEX_HOME ?? `${homedir()}/.codex`)
    const outDir = resolve(values.out)
    const started = Date.now()
    let lastLine = ''

    const report = await runExport({
      codexHome,
      outDir,
      includePlugins: values['include-plugins'] === true,
      includeMachine: values['include-machine'] === true,
      ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}),
      onProgress: values.quiet === true ? undefined : (event) => {
        const line = `  ${event.phase.padEnd(8)} ${String(event.done).padStart(6)}/${event.total}${event.detail ? `  ${event.detail}` : ''}`
        if (line !== lastLine) { process.stderr.write(`${line}\n`); lastLine = line }
      },
    })

    process.stdout.write(`\narchive  ${outDir}\n`)
    process.stdout.write(`  compression   ${report.manifest.compression}\n`)
    process.stdout.write(`  sessions      ${report.manifest.counts.session ?? 0}\n`)
    // 按 kind 数，不用 entries 总数减会话数——后者在 manifest 里出现新的 kind 时会
    // 静默把技能、提示词算进"环境文件"，而报告是用户唯一看到的账。
    const envKinds = Object.entries(report.manifest.counts).filter(([kind]) => kind !== 'session')
    process.stdout.write(`  environment   ${envKinds.map(([kind, n]) => `${n} ${kind}`).join(', ') || 'none'}\n`)
    process.stdout.write(`  copied        ${report.copied}\n`)
    process.stdout.write(`  reused        ${report.reused}\n`)
    process.stdout.write(`  skipped       ${report.skipped}\n`)
    process.stdout.write(`  source/archive ${human(report.manifest.totals.sourceBytes)} -> ${human(report.manifest.totals.archiveBytes)}\n`)
    process.stdout.write(`  elapsed       ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
    if (report.secrets.length > 0) {
      process.stdout.write(`\n  ${report.secrets.length} credential-shaped value(s) refused:\n`)
      for (const finding of report.secrets.slice(0, 20)) {
        process.stdout.write(`    ${finding.sourcePath}:${finding.line}  ${finding.pattern}  ${finding.redacted}\n`)
      }
    }
    process.stdout.write('\nRun `codex-archive verify <dir>` before trusting it.\n')
    return 0
  }

  if (command === 'verify') {
    const target = argv[1]
    if (target === undefined) { process.stderr.write(`verify requires an archive directory\n\n${USAGE}`); return 1 }
    const report = await verifyArchive(resolve(target))
    for (const result of report.results) {
      process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} ${result.id}  ${result.detail}\n`)
    }
    for (const problem of report.problems) process.stdout.write(`FAIL ${problem}\n`)
    process.stdout.write(`\n${report.checks.length} checks run; ${report.ok ? 'archive verified' : 'archive FAILED verification'}\n`)
    return report.ok ? 0 : 2
  }

  process.stderr.write(`unknown command "${command}"\n\n${USAGE}`)
  return 1
}

process.exitCode = await main(process.argv.slice(2))
