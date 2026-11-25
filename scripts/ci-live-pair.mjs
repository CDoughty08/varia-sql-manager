// Runs two CI live .NET groups concurrently against two isolated SQL Server containers (ports 1433 and 1434) after one
// shared Release build, holding each group's output until it finishes so CI logs stay cleanly grouped.
import { spawn } from 'node:child_process'

const project = 'backend/Varia.Backend.Tests/Varia.Backend.Tests.csproj'
const pairs = process.argv.slice(2).map(spec => {
  const [group, port] = spec.split('@')
  if (!group || !port) { console.error('Usage: node scripts/ci-live-pair.mjs 2/3@1433 3/3@1434'); process.exit(2) }
  return { group, port }
})
if (!pairs.length) { console.error('Usage: node scripts/ci-live-pair.mjs 2/3@1433 3/3@1434'); process.exit(2) }

function runGroup({ group, port }) {
  return new Promise(resolve => {
    const started = performance.now(), chunks = []
    const child = spawn('dotnet', ['run', '--no-build', '--project', project, '--configuration', 'Release', '--', '--live-group', group], {
      env: { ...process.env, VARIA_TEST_SQL_SERVER: `localhost,${port}` },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stderr.on('data', chunk => chunks.push(chunk))
    child.on('close', code => {
      const seconds = ((performance.now() - started) / 1000).toFixed(1)
      process.stdout.write(`\n::group::Live group ${group} (port ${port}, ${seconds} s${code ? `, exit ${code}` : ''})\n${Buffer.concat(chunks).toString()}\n::endgroup::\n`)
      resolve({ group, code: code ?? 1, seconds })
    })
  })
}

const results = await Promise.all(pairs.map(runGroup))
console.log('Live groups summary: ' + results.map(r => `${r.group} ${r.seconds} s${r.code ? ` FAILED (${r.code})` : ''}`).join(', '))
if (results.some(r => r.code !== 0)) process.exitCode = 1
