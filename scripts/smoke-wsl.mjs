// Runs smoke suites on Linux from a Windows checkout through WSL, so a Linux-only failure turns up before a push instead
// of in CI. docs/testing.md's "Linux smoke through WSL" has the detail.
//
//   npm run test:smoke:wsl -- --setup                 once: Node 24 and the .NET SDK from global.json, inside WSL
//   npm run test:smoke:wsl -- options [menus ...]     sync, build, then run those suites under xvfb-run
//   npm run test:smoke:wsl -- --all                   every suite in package.json's test:smoke
//
// Flags: --no-build (the suites only, on the last build), --committed (HEAD only, without uncommitted changes),
// --distro <name> (else VARIA_WSL_DISTRO or WSL's default). The Linux half is scripts/smoke-wsl.sh.
//
// The snapshot is HEAD plus every uncommitted change and untracked, unignored file, written as an unreferenced commit
// through a temporary index (the worktree, the index and the stash are untouched) and fetched into one Linux-filesystem
// clone. Runs from every worktree share that clone, so they queue on their own lock; the build then takes the machine
// lock's shared tier and the suites its exclusive tier, as npm run build:smoke and the suites do on Windows. The Linux
// side skips its own lock (VARIA_LOCK_HELD), since only the Windows lock spans the sessions on this machine.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquire, defaultDir } from './machine-lock.mjs'
import { smokeSuites } from './smoke-shards.mjs'

const usage = 'usage: npm run test:smoke:wsl -- [--setup] [--all | <suite>...] [--no-build] [--committed] [--distro <name>]'

/** The command line as options; throws on anything it does not know. */
export function parseArgs(argv) {
  const options = { setup: false, all: false, build: true, committed: false, distro: null, suites: [] }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--setup') options.setup = true
    else if (arg === '--all') options.all = true
    else if (arg === '--no-build') options.build = false
    else if (arg === '--committed') options.committed = true
    else if (arg === '--distro') {
      options.distro = argv[++index]
      if (!options.distro || options.distro.startsWith('-')) throw new Error('--distro needs a name.')
    } else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}.`)
    else options.suites.push(arg)
  }
  if (options.all && options.suites.length) throw new Error('Give --all or suite names, not both.')
  if (!options.setup && !options.all && !options.suites.length) throw new Error('Name at least one suite, or --all.')
  return options
}

/** `options`, `options-smoke`, `options-smoke.mjs` and `scripts/options-smoke.mjs` all name scripts/options-smoke.mjs. */
export function suitePath(name) {
  const base = name.replace(/\\/g, '/').replace(/^(\.\/)?scripts\//, '').replace(/\.mjs$/, '')
  if (!/^[\w-]+$/.test(base)) throw new Error(`Not a suite name: ${name}`)
  return `scripts/${base.endsWith('-smoke') ? base : `${base}-smoke`}.mjs`
}

/**
 * WSLENV, which names the variables wsl.exe passes into Linux: the lock tier held here, this script's own settings, and
 * the test variables (docs/testing.md), whose values pass through without being printed.
 */
export function wslEnvNames(env) {
  const names = Object.keys(env).filter(name => /^VARIA_(TEST_|SMOKE_|WSL_HOME$|WSL_CLONE$|LOCK_HELD$)/.test(name))
  const existing = (env.WSLENV ?? '').split(':').filter(Boolean)
  return [...new Set([...existing, ...names])].join(':')
}

const git = (args, options = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options }).trim()

/** The commit to test: HEAD, or HEAD with the working tree's changes as an unreferenced commit on top. */
function snapshot(committed) {
  const head = git(['rev-parse', 'HEAD'])
  const ref = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (committed || !git(['status', '--porcelain'])) return { sha: head, label: ref }
  const dir = mkdtempSync(join(tmpdir(), 'varia-smoke-wsl-'))
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index'), GIT_AUTHOR_NAME: 'smoke-wsl', GIT_AUTHOR_EMAIL: 'smoke-wsl@localhost', GIT_COMMITTER_NAME: 'smoke-wsl', GIT_COMMITTER_EMAIL: 'smoke-wsl@localhost' }
    git(['read-tree', 'HEAD'], { env })
    git(['add', '-A'], { env })
    const tree = git(['write-tree'], { env })
    return { sha: git(['commit-tree', tree, '-p', head, '-m', 'smoke-wsl snapshot'], { env }), label: `${ref} with uncommitted changes` }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** Runs one phase of scripts/smoke-wsl.sh in WSL, from the checkout's root, streaming its output; resolves its exit code. */
function phase(root, distro, env, args) {
  const wsl = [...(distro ? ['-d', distro] : []), '--cd', root, '-e', 'bash', 'scripts/smoke-wsl.sh', ...args]
  return new Promise(done => {
    const child = spawn('wsl.exe', wsl, { stdio: 'inherit', env: { ...env, WSLENV: wslEnvNames(env) } })
    child.on('error', error => { console.error(`[smoke-wsl] Could not start wsl.exe: ${error.message}`); done(1) })
    child.on('exit', (code, signal) => done(code ?? (signal ? 1 : 0)))
  })
}

/** Holds `tier` of the machine lock (or of the clone's own lock, in `dir`) while `run` goes, and hands `run` its environment. */
async function holding(tier, label, run, dir) {
  const env = { ...process.env }
  const lock = await acquire(tier, { label, env, ...(dir ? { dir } : {}) })
  try { return await run(env) } finally { lock.release() }
}

async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch (error) {
    console.error(`${error.message}\n${usage}`)
    return 2
  }
  if (process.platform !== 'win32') {
    console.error('smoke-wsl runs Linux suites from Windows. On Linux run them directly: xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/<suite>-smoke.mjs')
    return 2
  }
  const root = git(['rev-parse', '--show-toplevel'])
  const suites = options.all ? smokeSuites() : options.suites.map(suitePath)
  const absent = suites.filter(suite => !existsSync(join(root, suite)))
  if (absent.length) {
    console.error(`No such suite: ${absent.join(', ')}`)
    return 2
  }
  const distro = options.distro || process.env.VARIA_WSL_DISTRO || null
  const cloneLock = join(process.env.VARIA_LOCK_DIR || defaultDir(), 'wsl-clone')
  return holding('exclusive', 'smoke-wsl clone', async () => {
    if (options.setup) {
      const code = await phase(root, distro, process.env, ['setup'])
      if (code || !suites.length) return code
    }
    if (options.build) {
      const { sha, label } = snapshot(options.committed)
      const commonDir = resolve(root, git(['rev-parse', '--git-common-dir'])).replace(/\\/g, '/')
      const code = await holding('shared', 'smoke-wsl build', env => phase(root, distro, env, ['prepare', commonDir, sha, label]))
      if (code) return code
    }
    return holding('exclusive', `smoke-wsl ${suites.length === 1 ? suites[0] : `${suites.length} suites`}`, env => phase(root, distro, env, ['suites', ...suites]))
  }, cloneLock)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main()
