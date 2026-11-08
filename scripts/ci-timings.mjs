// Measures CI from GitHub's own records: per job, its median and 90th percentile run time and queue wait (started_at minus
// created_at), and per run, its wall time, longest job and runner-minutes by OS. Queueing for GitHub's 20 concurrent jobs
// (5 macOS) is most of a busy run's wall time, so read a change's effect in slot-minutes and queue, not only job seconds
// (docs/ci.md). Needs the gh CLI, signed in.
//
//   node scripts/ci-timings.mjs [--runs 25] [--workflow ci.yml] [--workflow release.yml] [--branch main] [--steps]
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback }
const options = name => args.flatMap((arg, index) => arg === name ? [args[index + 1]] : [])
const runs = Number(option('--runs', '25')), branch = option('--branch'), steps = args.includes('--steps')
const workflows = options('--workflow').length ? options('--workflow') : ['ci.yml', 'release.yml']
const gh = (...command) => JSON.parse(execFileSync('gh', command, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
const repo = gh('repo', 'view', '--json', 'nameWithOwner').nameWithOwner

const seconds = (from, to) => from && to ? (new Date(to) - new Date(from)) / 1000 : 0
const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0 }
const minutes = value => (value / 60).toFixed(1)
const os = labels => labels.some(label => /macos/i.test(label)) ? 'macos' : labels.some(label => /windows/i.test(label)) ? 'windows' : 'linux'

for (const workflow of workflows) {
  const list = gh('run', 'list', '--repo', repo, '--workflow', workflow, '--status', 'success', '--limit', String(runs), '--json', 'databaseId,event', ...(branch ? ['--branch', branch] : []))
  const jobs = new Map(), stepTimes = new Map(), perRun = []
  for (const { databaseId, event } of list) {
    const found = gh('api', `repos/${repo}/actions/runs/${databaseId}/jobs?per_page=100`).jobs.filter(job => job.started_at && job.completed_at && job.conclusion !== 'skipped')
    if (!found.length) continue
    const run = { id: databaseId, event, created: found[0].created_at, ended: found[0].completed_at, longest: 0, byOs: { linux: 0, windows: 0, macos: 0 } }
    for (const job of found) {
      const ran = seconds(job.started_at, job.completed_at), queued = seconds(job.created_at, job.started_at)
      const key = `${event} | ${job.name.replace(/\d+\/(\d+)\)/, 'k/$1)')}`
      if (!jobs.has(key)) jobs.set(key, { ran: [], queued: [] })
      jobs.get(key).ran.push(ran); jobs.get(key).queued.push(queued)
      if (job.created_at < run.created) run.created = job.created_at
      if (job.completed_at > run.ended) run.ended = job.completed_at
      run.longest = Math.max(run.longest, ran); run.byOs[os(job.labels ?? [])] += ran
      if (steps) for (const step of job.steps ?? []) if (step.conclusion !== 'skipped') {
        const stepKey = `${key} | ${step.name}`
        if (!stepTimes.has(stepKey)) stepTimes.set(stepKey, [])
        stepTimes.get(stepKey).push(seconds(step.started_at, step.completed_at))
      }
    }
    perRun.push(run)
  }
  console.log(`\n${workflow}: ${perRun.length} successful runs\n`)
  console.log('job (event | name)'.padEnd(71) + '  n  run p50  run p90  queue p50  queue p90 (minutes)')
  for (const [key, { ran, queued }] of [...jobs].sort()) console.log(key.padEnd(70), String(ran.length).padStart(3), minutes(quantile(ran, 0.5)).padStart(8), minutes(quantile(ran, 0.9)).padStart(8), minutes(quantile(queued, 0.5)).padStart(10), minutes(quantile(queued, 0.9)).padStart(10))
  if (steps) {
    console.log('\nsteps over 20 s (p50, p90 seconds)')
    for (const [key, values] of [...stepTimes].sort()) if (quantile(values, 0.5) > 20) console.log(key.padEnd(110), Math.round(quantile(values, 0.5)), Math.round(quantile(values, 0.9)))
  }
  const wall = perRun.map(run => seconds(run.created, run.ended)), longest = perRun.map(run => run.longest)
  const total = os => perRun.map(run => run.byOs[os] / 60)
  console.log(`\nper run (p50): wall ${minutes(quantile(wall, 0.5))} min, longest job ${minutes(quantile(longest, 0.5))} min, so about ${minutes(quantile(wall, 0.5) - quantile(longest, 0.5))} min waiting for runners`)
  console.log(`runner-minutes per run (p50): linux ${quantile(total('linux'), 0.5).toFixed(0)}, windows ${quantile(total('windows'), 0.5).toFixed(0)}, macos ${quantile(total('macos'), 0.5).toFixed(0)}`)
}
