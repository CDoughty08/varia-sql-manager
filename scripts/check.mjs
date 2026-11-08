// npm run check: the type check, the offline .NET checks, vitest and the production build, as concurrent lanes.
// They used to run one after another (about 205 s in CI, 137 s on a 24-core desktop); only the vitest files that start the
// Release backend wait for its build, and nothing reads out/. Each lane's output is held and printed whole when it ends, so
// logs stay readable, and the summary's per-lane seconds show which lane to look at when the check grows (docs/ci.md).
//
//   node scripts/check.mjs          the whole check
//   node scripts/check.mjs --build  npm run build:smoke: the Release backend and electron-vite build, side by side
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'

// The vitest files that start backend/Varia.Backend/bin/Release: tests/backend-sidecar.test.ts, and the live files when
// VARIA_TEST_SQL_SERVER is set. A new file that spawns the Release backend belongs here.
export const needsBackend = readdirSync('tests').filter(name => name === 'backend-sidecar.test.ts' || name.endsWith('-live.test.ts')).map(name => `tests/${name}`)

const run = (name, command) => new Promise(resolve => {
  const started = performance.now(), output = []
  const child = spawn(command, { shell: true, env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' } })
  child.stdout.on('data', chunk => output.push(chunk))
  child.stderr.on('data', chunk => output.push(chunk))
  child.on('close', code => {
    const seconds = (performance.now() - started) / 1000
    process.stdout.write(`\n::group::${name} (${seconds.toFixed(1)} s${code ? `, exit ${code}` : ''})\n${Buffer.concat(output).toString()}\n::endgroup::\n`)
    resolve({ name, code: code ?? 1, seconds })
  })
})
// Runs `then` only when every lane in `first` passed.
const after = async (first, then) => {
  const results = await Promise.all(first)
  return results.some(result => result.code) ? results : [...results, ...await Promise.all(then())]
}

const dotnet = 'dotnet build backend/Varia.Backend.Tests/Varia.Backend.Tests.csproj --configuration Release --nologo -v q'
const lanes = process.argv.includes('--build')
  ? [
      run('Release backend', 'dotnet build backend/Varia.Backend/Varia.Backend.csproj --configuration Release --nologo -v q'),
      run('electron-vite build', 'npx electron-vite build'),
    ]
  : [
      run('Type check', 'npx tsc --noEmit'),
      run('electron-vite build', 'npx electron-vite build'),
      run('vitest', `npx vitest run ${needsBackend.map(file => `--exclude ${file}`).join(' ')}`),
      after([run('Release build (.NET)', dotnet)], () => [
        run('Offline .NET checks', 'dotnet run --no-build --project backend/Varia.Backend.Tests/Varia.Backend.Tests.csproj --configuration Release'),
        run('vitest (Release backend)', `npx vitest run ${needsBackend.join(' ')}`),
      ]),
    ]

const started = performance.now()
const results = (await Promise.all(lanes)).flat()
const failed = results.filter(result => result.code)
console.log(`\n${failed.length ? 'Check failed' : 'Check passed'} in ${((performance.now() - started) / 1000).toFixed(1)} s: ` + results.map(({ name, seconds, code }) => `${name} ${seconds.toFixed(1)} s${code ? ' FAILED' : ''}`).join(', '))
process.exitCode = failed.length ? 1 : 0
