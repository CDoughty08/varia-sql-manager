// Runs several copies of the offline .NET checks at once, pinned to a few CPUs, to starve them the way CI's 3 and 4 vCPU
// runners do when the offline lanes share them with vitest and a build (docs/ci.md). A timing check that passes here survives
// CI; before this existed, three copies on three CPUs failed every run. Needs the Release backend tests built (npm run check,
// or npm run backend:test).
//
//   node scripts/offline-stress.mjs [--copies 5] [--cpus 3] [--rounds 2] [--deadline 300]
//
// A copy still running after --deadline seconds is killed and reported with the suites that never finished: a hang.
//
// Pinning sets each process's affinity through PowerShell on Windows and uses taskset on Linux; macOS cannot pin, so there
// it oversubscribes every CPU.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? Number(args[index + 1]) : fallback }
const cpus = Math.min(option('--cpus', 3), availableParallelism()), copies = option('--copies', 5), rounds = option('--rounds', 2)
const deadline = option('--deadline', 300) * 1000
const block = /offlineSuites =([\s\S]*?)\];/.exec(readFileSync('backend/Varia.Backend.Tests/Program.cs', 'utf8'))?.[1] ?? ''
const suites = [...block.matchAll(/\("([\w.]+)", /g)].map(match => match[1])
const dll = resolve('backend/Varia.Backend.Tests/bin/Release/net11.0/Varia.Backend.Tests.dll')
if (!existsSync(dll)) { console.error('Build the Release checks first: npm run backend:test'); process.exit(2) }

const taskset = process.platform === 'linux' && spawnSync('taskset', ['--version']).status === 0
const command = () => {
  if (taskset) return ['taskset', ['-c', `0-${cpus - 1}`, 'dotnet', dll]]
  return ['dotnet', [dll]]
}
if (process.platform !== 'win32' && !taskset) console.log(`Cannot pin here: ${copies} copies share all ${availableParallelism()} CPUs.`)

// Without --live-group the checks run every live suite when these are set: five copies at once against one server, killed at
// the deadline before their finally blocks drop their scratch databases and logins. The copies run offline only.
const offlineEnv = (env = process.env) => {
  const copy = { ...env, DOTNET_PROCESSOR_COUNT: String(cpus) }
  for (const name of Object.keys(copy)) if (/^VARIA_TEST_(SQL|ENTRA|SSIS)/.test(name)) delete copy[name]
  return copy
}

const run = () => new Promise(done => {
  const [file, argv] = command(), child = spawn(file, argv, { env: offlineEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  if (process.platform === 'win32') spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).ProcessorAffinity = ${2 ** cpus - 1}`])
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  let hung = false
  const timer = setTimeout(() => { hung = true; child.kill() }, deadline)
  child.on('close', code => {
    clearTimeout(timer)
    const finished = new Set([...output.matchAll(/^Offline suite ([\w.]+): /gm)].map(match => match[1]))
    const unfinished = suites.filter(name => !finished.has(name))
    if (hung) return done({ code: 'hung', summary: '', failures: [`HUNG after ${deadline / 1000} s; suites that never finished: ${unfinished.join(', ')}`] })
    const lines = output.split('\n'), crash = lines.findIndex(line => line.startsWith('Unhandled exception'))
    // A crash shows its first frames in Varia's own code, which name the check that threw.
    const frames = crash < 0 ? [] : lines.slice(crash + 1).filter(line => /^\s+at Varia\./.test(line)).slice(0, 6)
    const failures = [...lines.filter(line => line.includes('FAIL:') || line.startsWith('Unhandled exception')), ...frames].map(line => line.trim().slice(0, 400))
    // An exit without a FAIL line is a crash: show where it stopped.
    if (code !== 0 && !failures.length) failures.push(`exit ${code}; suites that never finished: ${unfinished.join(', ')}`, ...output.trimEnd().split('\n').slice(-12).map(line => line.trim().slice(0, 300)))
    done({ code, summary: /Offline suites: .*/.exec(output)?.[0] ?? '', failures })
  })
})

let failed = 0
for (let round = 1; round <= rounds; round++) {
  const results = await Promise.all(Array.from({ length: copies }, run))
  results.forEach(({ code, summary, failures }, index) => {
    if (code !== 0 || failures.length) failed++
    console.log(`round ${round} copy ${index + 1}: ${code === 0 && !failures.length ? 'passed' : 'FAILED'} ${summary}`)
    for (const failure of failures) console.log('   ' + failure)
  })
}
console.log(`${rounds * copies - failed} of ${rounds * copies} runs passed (${copies} copies on ${cpus} CPUs at a time).`)
process.exit(failed ? 1 : 0)
