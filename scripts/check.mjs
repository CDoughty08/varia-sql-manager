// npm run check: the type check, the offline .NET checks, vitest and the production build, as concurrent lanes.
// They used to run one after another (about 205 s in CI, 137 s on a 24-core desktop); only the vitest files that start the
// Release backend wait for its build, and nothing reads out/. Each lane's output is held and printed whole when it ends, so
// logs stay readable, and the summary's per-lane seconds show which lane to look at when the check grows (docs/ci.md).
//
// With 8 or more CPUs every lane runs at once. CI's runners have 3 or 4, where that starved the time-bounded tests (tsc took
// 66 s instead of 5 on macOS, and polls of 1 to 3 s missed), so there the lanes run as two chains side by side: tsc, vitest,
// then the electron-vite build; and the .NET build, the offline checks, then the vitest files that need the Release backend.
// VARIA_CHECK_CPUS=<n> overrides the CPU count, to try either layout.
//
//   node scripts/check.mjs          the whole check
//   node scripts/check.mjs --build  npm run build:smoke: the Release backend and electron-vite build, side by side
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
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
const cpus = Number(process.env.VARIA_CHECK_CPUS) || availableParallelism()
export const wide = cpus >= 8
// One lane after another, each whatever the last one's outcome, so one failure hides nothing.
const chain = async steps => { const results = []; for (const step of steps) results.push(await step()); return results }

const typecheck = () => run('Type check', 'npx tsc --noEmit')
const vite = () => run('electron-vite build', 'npx electron-vite build')
const vitest = () => run('vitest', `npx vitest run ${needsBackend.map(file => `--exclude ${file}`).join(' ')}`)
const offline = () => run('Offline .NET checks', 'dotnet run --no-build --project backend/Varia.Backend.Tests/Varia.Backend.Tests.csproj --configuration Release')
const sidecar = () => run('vitest (Release backend)', `npx vitest run ${needsBackend.join(' ')}`)
// The .NET lanes need the build; nothing runs on a failed one.
const dotnet = async () => {
  const build = await run('Release build (.NET)', 'dotnet build backend/Varia.Backend.Tests/Varia.Backend.Tests.csproj --configuration Release --nologo -v q')
  if (build.code) return [build]
  return [build, ...await (wide ? Promise.all([offline(), sidecar()]) : chain([offline, sidecar]))]
}

const lanes = process.argv.includes('--build')
  ? [run('Release backend', 'dotnet build backend/Varia.Backend/Varia.Backend.csproj --configuration Release --nologo -v q'), vite()]
  : wide ? [typecheck(), vite(), vitest(), dotnet()] : [chain([typecheck, vitest, vite]), dotnet()]

const started = performance.now()
const results = (await Promise.all(lanes)).flat()
const failed = results.filter(result => result.code)
console.log(`
${failed.length ? 'Check failed' : 'Check passed'} in ${((performance.now() - started) / 1000).toFixed(1)} s (${cpus} CPUs, ${wide ? 'every lane at once' : 'two chains'}): ` + results.map(({ name, seconds, code }) => `${name} ${seconds.toFixed(1)} s${code ? ' FAILED' : ''}`).join(', '))
process.exitCode = failed.length ? 1 : 0
