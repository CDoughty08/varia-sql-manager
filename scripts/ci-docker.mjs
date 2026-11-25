// Starts and waits on CI's disposable Docker containers with pull retries, so SQL Server image pull and boot both run
// concurrently with setup and builds instead of blocking the job in GitHub Actions' serial "Initialize containers" step.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const sqlImage = 'mcr.microsoft.com/mssql/server:2022-latest'
export const bigQueryImage = 'ghcr.io/goccy/bigquery-emulator@sha256:f4e428d265a93dc5ce36c294e1c584c7c9b384117d47ab8ddbb63d8d50b7f393'

const stateDir = join(tmpdir(), 'varia-ci-docker')
const statusPath = key => join(stateDir, `${key}.status`)
const logPath = key => join(stateDir, `${key}.log`)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Pulls `image` with transient network retries (GitHub's ghcr.io and mcr.microsoft.com tokens occasionally time out). */
export async function pullWithRetry(image, { attempts = 3, delayMs = 5000, run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' }) } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      run('docker', ['pull', image])
      return
    } catch (error) {
      if (attempt >= attempts) throw error
      console.warn(`docker pull ${image} failed on attempt ${attempt}/${attempts}; retrying in ${delayMs / 1000} s...`)
      await sleep(delayMs)
    }
  }
}

function startSqlContainer({ name, port, password, agent, memoryMb }) {
  const args = [
    'run', '-d', '--name', name,
    '-e', 'ACCEPT_EULA=Y',
    '-e', `MSSQL_SA_PASSWORD=${password}`,
    ...(agent ? ['-e', 'MSSQL_AGENT_ENABLED=true'] : []),
    ...(memoryMb ? ['-e', `MSSQL_MEMORY_LIMIT_MB=${memoryMb}`] : []),
    '-p', `${port}:1433`,
    sqlImage
  ]
  execFileSync('docker', args, { stdio: 'inherit' })
}

function spawnDetached(key, subcommand, extraArgs) {
  mkdirSync(stateDir, { recursive: true })
  rmSync(statusPath(key), { force: true })
  const log = openSync(logPath(key), 'w')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), subcommand, '--state-key', key, ...extraArgs], {
    detached: true,
    stdio: ['ignore', log, log]
  })
  child.unref()
  console.log(`Started background Docker task ${key} (pid ${child.pid}).`)
}

async function waitForDetached(key, timeoutSeconds = 240) {
  const status = statusPath(key), log = logPath(key)
  if (!existsSync(log) && !existsSync(status)) return
  const deadline = Date.now() + timeoutSeconds * 1000
  while (!existsSync(status)) {
    if (Date.now() >= deadline) {
      if (existsSync(log)) process.stderr.write(readFileSync(log, 'utf8'))
      throw new Error(`Background Docker task ${key} did not finish within ${timeoutSeconds} s.`)
    }
    await sleep(500)
  }
  const code = Number(readFileSync(status, 'utf8').trim())
  if (code !== 0) {
    if (existsSync(log)) process.stderr.write(readFileSync(log, 'utf8'))
    throw new Error(`Background Docker task ${key} failed with exit code ${code}.`)
  }
}

async function waitForSql(names, password, timeoutSeconds = 240) {
  await waitForDetached('sql', timeoutSeconds)
  const deadline = Date.now() + timeoutSeconds * 1000
  const pending = new Set(names)
  while (pending.size > 0) {
    for (const name of [...pending]) {
      const probe = spawnSync('docker', ['exec', name, '/opt/mssql-tools18/bin/sqlcmd', '-C', '-S', 'localhost', '-U', 'sa', '-P', password, '-Q', 'SELECT 1', '-b', '-o', '/dev/null'], { stdio: 'ignore' })
      if (probe.status === 0) {
        console.log(`SQL Server container ${name} is ready.`)
        pending.delete(name)
      }
    }
    if (pending.size === 0) return
    if (Date.now() >= deadline) {
      for (const name of pending) spawnSync('docker', ['logs', '--tail', '40', name], { stdio: 'inherit' })
      throw new Error(`SQL Server container(s) did not become ready within ${timeoutSeconds} s: ${[...pending].join(', ')}`)
    }
    await sleep(2000)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...args] = process.argv.slice(2)
  const values = flag => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : [])
  const has = flag => args.includes(flag)
  if (command === 'start-sql') {
    const password = process.env.VARIA_TEST_SQL_PASSWORD || process.env.MSSQL_SA_PASSWORD
    if (!password) { console.error('Missing VARIA_TEST_SQL_PASSWORD.'); process.exit(2) }
    const names = values('--name'), ports = values('--port')
    if (!names.length || names.length !== ports.length) { console.error('Usage: ci-docker.mjs start-sql --name <n> --port <p> [--name <n2> --port <p2>] [--agent] [--memory-mb <mb>] [--detach]'); process.exit(2) }
    if (has('--detach')) {
      spawnDetached('sql', '_start-sql', args.filter(arg => arg !== '--detach'))
    } else {
      const agent = has('--agent'), memoryMb = values('--memory-mb')[0]
      await pullWithRetry(sqlImage)
      for (let i = 0; i < names.length; i++) startSqlContainer({ name: names[i], port: ports[i], password, agent, memoryMb })
    }
  } else if (command === '_start-sql') {
    const key = values('--state-key')[0]
    let code = 0
    try {
      const password = process.env.VARIA_TEST_SQL_PASSWORD || process.env.MSSQL_SA_PASSWORD
      const names = values('--name'), ports = values('--port'), agent = has('--agent'), memoryMb = values('--memory-mb')[0]
      await pullWithRetry(sqlImage)
      for (let i = 0; i < names.length; i++) startSqlContainer({ name: names[i], port: ports[i], password, agent, memoryMb })
    } catch (error) {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error))
      code = 1
    } finally {
      if (key) writeFileSync(statusPath(key), String(code))
    }
    process.exit(code)
  } else if (command === 'wait-sql') {
    const password = process.env.VARIA_TEST_SQL_PASSWORD || process.env.MSSQL_SA_PASSWORD
    if (!password) { console.error('Missing VARIA_TEST_SQL_PASSWORD.'); process.exit(2) }
    const names = values('--name')
    if (!names.length) { console.error('Usage: ci-docker.mjs wait-sql --name <n> [--name <n2>]'); process.exit(2) }
    await waitForSql(names, password)
  } else if (command === 'start-bigquery') {
    if (has('--detach')) {
      spawnDetached('bigquery', '_start-bigquery', [])
    } else {
      await pullWithRetry(bigQueryImage)
      execFileSync('docker', ['run', '-d', '--name', 'varia-bigquery', '-p', '9050:9050', '-p', '9060:9060', bigQueryImage, '--project=varia-emulator', '--dataset=varia_fixture'], { stdio: 'inherit' })
    }
  } else if (command === '_start-bigquery') {
    const key = values('--state-key')[0]
    let code = 0
    try {
      await pullWithRetry(bigQueryImage)
      execFileSync('docker', ['run', '-d', '--name', 'varia-bigquery', '-p', '9050:9050', '-p', '9060:9060', bigQueryImage, '--project=varia-emulator', '--dataset=varia_fixture'], { stdio: 'inherit' })
    } catch (error) {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error))
      code = 1
    } finally {
      if (key) writeFileSync(statusPath(key), String(code))
    }
    process.exit(code)
  } else if (command === 'wait-bigquery') {
    await waitForDetached('bigquery', 180)
  } else {
    console.error('Unknown command:', command)
    process.exit(2)
  }
}
