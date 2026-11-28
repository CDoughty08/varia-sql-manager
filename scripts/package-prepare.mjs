// Prepares all independent packaging inputs concurrently for package.yml:
// electron-vite build, self-contained ReadyToRun backend publish,
// and (on Windows) NativeAOT update helper publish. Each lane holds its output until completion so CI logs stay grouped.
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export function packagePrepareSteps({ rid, updater = false }) {
  const steps = [
    { name: 'Build application', command: 'npx electron-vite build' },
    { name: 'Publish self-contained backend', command: `dotnet publish backend/Varia.Backend/Varia.Backend.csproj -c Release -r ${rid} --self-contained true -p:RestoreLockedMode=true -o artifacts/release-backend` }
  ]
  if (updater) {
    steps.push({ name: 'Publish update helper', command: `dotnet publish backend/Varia.Updater/Varia.Updater.csproj -c Release -r ${rid} -o artifacts/updater` })
  }
  return steps
}

function runStep({ name, command }) {
  return new Promise(resolve => {
    const started = performance.now(), chunks = []
    const child = spawn(command, { shell: true, env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' } })
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stderr.on('data', chunk => chunks.push(chunk))
    child.on('close', code => {
      const seconds = ((performance.now() - started) / 1000).toFixed(1)
      process.stdout.write(`\n::group::${name} (${seconds} s${code ? `, exit ${code}` : ''})\n${Buffer.concat(chunks).toString()}\n::endgroup::\n`)
      resolve({ name, code: code ?? 1, seconds })
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { rid: { type: 'string' }, updater: { type: 'boolean', default: false } } })
  if (!values.rid) {
    console.error('Usage: node scripts/package-prepare.mjs --rid <rid> [--updater]')
    process.exit(2)
  }
  const started = performance.now()
  const results = await Promise.all(packagePrepareSteps({ rid: values.rid, updater: values.updater }).map(runStep))
  const failed = results.filter(result => result.code !== 0)
  console.log(`\nPackage prepare ${failed.length ? 'failed' : 'passed'} in ${((performance.now() - started) / 1000).toFixed(1)} s: ` + results.map(r => `${r.name} ${r.seconds} s${r.code ? ' FAILED' : ''}`).join(', '))
  if (failed.length) process.exitCode = 1
}
