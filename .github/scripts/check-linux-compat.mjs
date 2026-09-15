// .github/scripts/check-linux-compat.mjs — 跨平台路径纪律静态检查（CI + 本地 pre-push）
//
// 背景：CI（ubuntu + node 22）的 npm test 曾长期红而本地（Windows）全绿——测试用
// 反斜杠合成路径（mock 树键），代码里的 join() 在 posix 下对反斜杠路径产出混合
// 分隔符（'D:\demo\x/summary.json'），mock 的裸 tree[key] 查找在 Linux 落空；
// 或断言把 node:path 运算结果与写死的反斜杠字面量比较（posix 下 dirname 行为不同）。
//
// 规则（违反即失败，退出码 1）：
//   1. mock 树查找必须做分隔符归一：测试文件若出现 `tree[key]` 裸查找（stat /
//      readText / listDir 读 mock 树），必须同时含 `.replace(/\\/g, …)` 归一
//      （模板：index.test.mjs makeCtx 的 norm + lookup 三态命中）。
//   2. 断言不得把 dirname()/join()/basename()/relative() 的结果与写死的
//      'X:\…' 反斜杠字面量比较（期望值必须用同口径 node:path 函数计算）。
//
// 用法：node .github/scripts/check-linux-compat.mjs（无参数，扫描 test/*.test.mjs）。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../../test/', import.meta.url))
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs'))
const problems = []
const normMark = '/\\\\/g' // 源文本里 `.replace(/\\/g, …)` 的字面量

for (const file of files) {
  const src = readFileSync(join(dir, file), 'utf8')
  const lines = src.split(/\r?\n/)

  // 规则 1：裸 tree[...] 查找必须有分隔符归一
  const hasBareTreeLookup = /\btree\s*\[/.test(src)
  if (hasBareTreeLookup && !src.includes(normMark)) {
    const line = lines.findIndex((l) => /\btree\s*\[/.test(l)) + 1
    problems.push(
      `${file}:${line} mock 树查找（tree[key]）缺少分隔符归一——Linux CI 会因代码 join() ` +
      `产出混合分隔符而红。请套用 index.test.mjs makeCtx 的 norm + lookup 三态命中模式 ` +
      `（.replace(/\\\\/g, '/') 归一后再查树）。`
    )
  }

  // 规则 2：node:path 结果不得与写死的反斜杠字面量比较
  const pathCall = '(?:dirname|join|basename|relative)\\s*\\('
  const driveLit = "['\"][A-Za-z]:\\\\"
  const cmp = '\\s*(?:===|!==|==|!=)\\s*'
  const r1 = new RegExp(`${pathCall}[^)]*\\)${cmp}${driveLit}`)
  const r2 = new RegExp(`${driveLit}[^'\"]*['\"]${cmp}${pathCall}`)
  for (let i = 0; i < lines.length; i++) {
    if (r1.test(lines[i]) || r2.test(lines[i])) {
      problems.push(
        `${file}:${i + 1} 断言把 dirname()/join()/basename()/relative() 的结果与写死的 ` +
        `反斜杠路径比较——posix（Linux CI）下结果不同（如 dirname('D:\\…') 为 '.'）。` +
        `期望值必须用同口径 node:path 函数计算。`
      )
    }
  }
}

if (problems.length > 0) {
  console.error('check-linux-compat: FAIL — 跨平台路径纪律违规：')
  for (const p of problems) console.error('  - ' + p)
  console.error('修复后重跑；这是 CI 上 npm test 长期红（Linux 专属）的防回归护栏。')
  process.exit(1)
}
console.log(`check-linux-compat: OK — ${files.length} 个测试文件无跨平台路径违规`)
