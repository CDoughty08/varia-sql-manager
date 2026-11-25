// Starts and waits on CI's disposable Docker containers with pull retries, so SQL Server boots while setup and builds run
// instead of blocking the job in GitHub Actions' serial "Initialize containers" step.
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const sqlImage = 'mcr.microsoft.com/mssql/server:2022-latest'
export const bigQueryImage = 'ghcr.io/goccy/bigquery-emulator@sha256:f4e428d265a93dc5ce36c294e1c584c7c9b384117d47ab8ddbb63d8d50b7f393'

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

async function waitForSql(names, password, timeoutSeconds = 180) {
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
    if (!names.length || names.length !== ports.length) { console.error('Usage: ci-docker.mjs start-sql --name <n> --port <p> [--name <n2> --port <p2>] [--agent] [--memory-mb <mb>]'); process.exit(2) }
    const agent = has('--agent'), memoryMb = values('--memory-mb')[0]
    await pullWithRetry(sqlImage)
    for (let i = 0; i < names.length; i++) startSqlContainer({ name: names[i], port: ports[i], password, agent, memoryMb })
  } else if (command === 'wait-sql') {
    const password = process.env.VARIA_TEST_SQL_PASSWORD || process.env.MSSQL_SA_PASSWORD
    if (!password) { console.error('Missing VARIA_TEST_SQL_PASSWORD.'); process.exit(2) }
    const names = values('--name')
    if (!names.length) { console.error('Usage: ci-docker.mjs wait-sql --name <n> [--name <n2>]'); process.exit(2) }
    await waitForSql(names, password)
  } else if (command === 'start-bigquery') {
    await pullWithRetry(bigQueryImage)
    execFileSync('docker', ['run', '-d', '--name', 'varia-bigquery', '-p', '9050:9050', '-p', '9060:9060', bigQueryImage, '--project=varia-emulator', '--dataset=varia_fixture'], { stdio: 'inherit' })
  } else {
    console.error('Unknown command:', command)
    process.exit(2)
  }
}
