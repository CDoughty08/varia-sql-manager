// Deterministic static classification of Vitest files for:
// 1. Isolation splitting (vitest.config.ts): pure stateless Node tests share a worker module cache (isolate: false),
//    eliminating ~50-56% repeated module-import overhead across 450+ files while keeping mocked, DOM, timer and
//    process-spawning tests strictly isolated (isolate: true).
// 2. Cross-OS scope (VARIA_CHECK_SCOPE=os on CI Windows and macOS Check): keeps every OS, main-process, scripts,
//    filesystem-write, network, child_process and Release-sidecar test on all three OSes while avoiding repeating
//    pure JS/React/docs-lint tests that Linux Check already verified on the same commit.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const needsIsolationPattern = new RegExp([
  /@vitest-environment\s+/.source,
  /from\s+['"]react-dom(?:\/|['"])/.source,
  /\bvi\.(?:mock|doMock|stubGlobal|stubEnv|useFakeTimers)\s*\(/.source,
  /\bvi\.spyOn\s*\(\s*(?:process|globalThis|global|Date|console)\b/.source,
  /\bprocess\.env(?:\s*\[|\.\w+\s*=)/.source,
  /\bdelete\s+process\.env\b/.source,
  /\b(?:globalThis|global|window)\.\w+\s*=/.source,
  /from\s+['"](?:node:)?child_process['"]/.source
].join('|'))

const osSensitivePattern = new RegExp([
  /from\s+['"][^'"]*(?:src\/main\/|scripts\/|build\/)/.source,
  /require\s*\(\s*['"][^'"]*(?:src\/main\/|scripts\/|build\/)/.source,
  /\b(?:process\.platform|process\.arch|os\.platform|os\.homedir|os\.tmpdir|path\.sep|path\.win32|path\.posix)\b/.source,
  /from\s+['"](?:node:)?(?:child_process|os|net|http|https|tls|dgram)['"]/.source,
  /\b(?:mkdtemp|writeFile|mkdir|unlink|rename|chmod|symlink|tmpdir|createWriteStream|openSync|statSync|lstat|realpath)\b/.source,
  /\brm\s*\(/.source,
  /\baccess\s*\(/.source
].join('|'))

/** All Vitest test files under `tests/` (excluding benchmarks under `tests/bench/`), sorted. */
export function vitestFiles(testsDir = 'tests') {
  return readdirSync(testsDir)
    .filter(name => name.endsWith('.test.ts'))
    .sort()
    .map(name => `tests/${name}`)
}

/** Splits `tests/*.test.ts` into non-isolated stateless Node files and strictly isolated files. */
export function classifyVitestIsolation(testsDir = 'tests') {
  const stateless = [], isolated = []
  for (const file of vitestFiles(testsDir)) {
    const base = file.slice('tests/'.length)
    if (base === 'backend-sidecar.test.ts' || base.endsWith('-live.test.ts')) {
      isolated.push(file)
      continue
    }
    const source = readFileSync(join(testsDir, base), 'utf8')
    if (needsIsolationPattern.test(source)) isolated.push(file)
    else stateless.push(file)
  }
  return { stateless, isolated }
}

/** Splits `tests/*.test.ts` into OS-sensitive files (run on all 3 OSes) and platform-independent files (Linux + local). */
export function classifyVitestOsScope(testsDir = 'tests') {
  const osSensitive = [], platformIndependent = []
  for (const file of vitestFiles(testsDir)) {
    const base = file.slice('tests/'.length)
    if (base === 'backend-sidecar.test.ts' || base.endsWith('-live.test.ts')) {
      osSensitive.push(file)
      continue
    }
    const source = readFileSync(join(testsDir, base), 'utf8')
    if (osSensitivePattern.test(source)) osSensitive.push(file)
    else platformIndependent.push(file)
  }
  return { osSensitive, platformIndependent }
}
