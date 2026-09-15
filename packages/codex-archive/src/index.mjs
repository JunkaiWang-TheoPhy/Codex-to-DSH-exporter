// index.mjs — 公开 API。
//
// 导出端只做一件事：只读地读一个 Codex home，写出可移植、可校验、自描述的归档。
// 导入端是另一个程序，读这个归档并决定带走什么。
//
// 用法：
//   import { runExport, verifyArchive } from './src/index.mjs'
//   const report = await runExport({ codexHome: '~/.codex', outDir: './out' })

export { runExport, detectCompression, discardPartial } from './export.mjs'
export { verifyArchive } from './verify.mjs'
export {
  classifyRecord, classifyRollout, summarizeRollout, textOf, ENTRY_KINDS,
} from './classify.mjs'
export { scanSessions, scanEnvironment, rolloutIdFromFilename, defaultOmissions } from './scan.mjs'
export { scanAndRedact, isScannable } from './credentials.mjs'
export { copyThroughDigest, hashFile, hashValue, writeAtomic } from './hash.mjs'
