// Checks the Linux AppImage itself, which the packaged smoke test (run on dist/linux-unpacked) never touched: its runtime,
// squashfs, generated AppRun and bundled files. Release builds' Linux packaging job runs it (package.yml).
//
//   node scripts/appimage-check.mjs inspect <AppImage>   extract it, read back the fuses, and run its AppRun against a stand-in
//                                                        executable with the search-path variables unset, empty and set
//   node scripts/appimage-check.mjs refusal <AppImage>   launch it where unprivileged user namespaces are restricted: AppRun
//                                                        adds --no-sandbox, and main must refuse to start rather than run
//                                                        the renderer unsandboxed
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getCurrentFuseWire } from '@electron/fuses'

/** The search paths AppRun exports, each with its application directory first. */
export const searchPaths = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']

/**
 * What is wrong with the search paths AppRun handed its executable, given what it was started with. An empty component
 * means the current directory (for LD_LIBRARY_PATH, libraries loaded from wherever the user happens to be), so none may
 * have one; the AppDir's own entry comes first, and a value the caller set survives.
 */
export function searchPathProblems(received, given, appDir) {
  const problems = []
  for (const name of searchPaths) {
    const value = received[name]
    if (value === undefined) { problems.push(`${name} is not set`); continue }
    const parts = value.split(':')
    if (parts.some(part => part === '')) problems.push(`${name} has an empty component: ${JSON.stringify(value)}`)
    if (!parts[0].startsWith(appDir)) problems.push(`${name} does not start with the AppDir: ${JSON.stringify(value)}`)
    for (const part of (given[name] ?? '').split(':').filter(Boolean)) if (!parts.includes(part)) problems.push(`${name} lost ${part}: ${JSON.stringify(value)}`)
  }
  return problems
}

/** The executable AppRun starts, from its BIN line. */
export function appRunExecutable(appRun) {
  const match = /^BIN="\$APPDIR\/([^"/]+)"$/m.exec(appRun)
  if (!match) throw new Error('AppRun has no BIN="$APPDIR/<executable>" line; review the AppImage launcher.')
  return match[1]
}

/** Parses the stand-in executable's report: one NAME=value line per variable, and ARG=value per argument. */
export function parseReport(text) {
  const env = {}, args = []
  for (const line of text.split('\n')) {
    const match = /^(\w+)=(.*)$/.exec(line)
    if (!match) continue
    if (match[1] === 'ARG') args.push(match[2])
    else if (match[1].startsWith('SET_')) env[match[1].slice(4)] = match[2]
  }
  return { env, args }
}

const standIn = `#!/bin/sh
${searchPaths.map(name => `[ "\${${name}+set}" = set ] && printf 'SET_${name}=%s\\n' "$${name}"`).join('\n')}
for arg in "$@"; do printf 'ARG=%s\\n' "$arg"; done
exit 0
`

/**
 * Runs an AppRun beside a stand-in executable that reports what it was started with, under `work`, with the search paths
 * unset, empty and set: its problems, and which runs added --no-sandbox (AppRun does where `unshare -Ur true` fails).
 */
export function appRunProblems(appRun, work) {
  const executable = appRunExecutable(appRun), appDir = join(realpathSync(work), 'appdir')
  mkdirSync(appDir)
  writeFileSync(join(appDir, 'AppRun'), appRun, { mode: 0o755 })
  writeFileSync(join(appDir, executable), standIn, { mode: 0o755 })
  // PATH stays set: AppRun finds its own directory with dirname and readlink, and every real launch has one.
  const base = { HOME: process.env.HOME ?? work, PATH: '/usr/bin:/bin' }
  const cases = {
    unset: {},
    empty: Object.fromEntries(searchPaths.filter(name => name !== 'PATH').map(name => [name, ''])),
    set: { LD_LIBRARY_PATH: '/opt/varia-check/lib', XDG_DATA_DIRS: '/usr/share/varia-check', GSETTINGS_SCHEMA_DIR: '/opt/varia-check/schemas' }
  }
  const problems = [], noSandbox = []
  for (const [label, given] of Object.entries(cases)) {
    const run = spawnSync(join(appDir, 'AppRun'), ['--varia-check'], { env: { ...base, ...given }, encoding: 'utf8' })
    if (run.status !== 0) { problems.push(`${label}: AppRun exited ${run.status}: ${run.stderr}`); continue }
    const { env, args } = parseReport(run.stdout)
    if (!args.includes('--varia-check')) problems.push(`${label}: AppRun dropped the arguments it was given`)
    if (args.includes('--no-sandbox')) noSandbox.push(label)
    problems.push(...searchPathProblems(env, { ...base, ...given }, appDir).map(problem => `${label}: ${problem}`))
  }
  return { problems, noSandbox }
}

async function inspect(appImage) {
  const work = mkdtempSync(join(tmpdir(), 'varia-appimage-'))
  try {
    // --appimage-extract needs no FUSE: the runtime unpacks its own squashfs.
    const extract = spawnSync(appImage, ['--appimage-extract'], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] })
    if (extract.status !== 0) throw new Error(`The AppImage did not extract (exit ${extract.status}).`)
    const root = join(work, 'squashfs-root'), appRun = readFileSync(join(root, 'AppRun'), 'utf8'), executable = appRunExecutable(appRun)
    for (const file of [executable, 'resources/app.asar', 'resources/backend/Varia.Backend', 'chrome-sandbox']) {
      if (!existsSync(join(root, file))) throw new Error(`The AppImage lacks ${file}.`)
    }
    // The bundled executable carries the same fuses as linux-unpacked's (packaged-smoke.mjs reads those).
    const { fuseMismatches } = createRequire(import.meta.url)('../build/fuses.cjs')
    const wrong = fuseMismatches(await getCurrentFuseWire(join(root, executable)))
    if (wrong.length) throw new Error(`The AppImage's executable lacks its fuses: ${wrong.join(', ')}`)
    const { problems, noSandbox } = appRunProblems(appRun, work)
    if (problems.length) throw new Error(`AppRun's search paths:\n${problems.join('\n')}`)
    console.log(`AppImage inspected: ${executable}, its fuses and AppRun's search paths are as expected (AppRun ${noSandbox.length ? 'adds' : 'does not add'} --no-sandbox here).`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Main prints its refusal before it shows the dialog (src/main/index.ts), so the check need not wait out a timer. */
export const refusalText = 'will not run without it'

async function refusal(appImage, limitMs = 120000) {
  // APPIMAGE_EXTRACT_AND_RUN: the runtime unpacks to a temporary directory instead of mounting with FUSE.
  const child = spawn(appImage, [], { env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let output = ''
  const outcome = await new Promise(resolveOutcome => {
    const timer = setTimeout(() => resolveOutcome({ kind: 'timeout' }), limitMs)
    const read = chunk => { output += chunk; if (output.includes(refusalText)) { clearTimeout(timer); resolveOutcome({ kind: 'refused' }) } }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.once('exit', code => { clearTimeout(timer); resolveOutcome(output.includes(refusalText) ? { kind: 'refused' } : { kind: 'exit', code }) })
  })
  // Main waits in its error dialog; end the whole group (runtime, AppRun's exec of Electron, and Chromium's helpers).
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(-child.pid, signal) } catch { /* Already gone. */ }
    if (signal === 'SIGTERM') await new Promise(resolveWait => setTimeout(resolveWait, 3000))
  }
  if (outcome.kind !== 'refused') throw new Error(`The AppImage did not refuse to run without the sandbox (${outcome.kind === 'exit' ? `exit ${outcome.code}` : `no refusal in ${limitMs / 1000} s`}):\n${output.slice(-4000)}`)
  console.log('The AppImage refused to run without the Chromium sandbox.')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [mode, file] = process.argv.slice(2)
  if (!['inspect', 'refusal'].includes(mode) || !file) {
    console.error('Usage: node scripts/appimage-check.mjs inspect|refusal <AppImage>')
    process.exit(2)
  }
  if (process.platform !== 'linux') throw new Error('The AppImage checks run on Linux.')
  await (mode === 'inspect' ? inspect(resolve(file)) : refusal(resolve(file)))
}
