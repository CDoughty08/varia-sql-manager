// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import {
  alertsCheck, failedCheck, historyCheck, historyShortfalls, mailCheck, detailParts, namesText, needsAttention, notifyCheck, overviewChecks, overviewStatus, overviewTiles, ownerCheck, schedulesCheck,
  serviceCheck, serviceWords, spanText, stampMs, unreadText, overviewTruncatedText, type OverviewFacts, type OverviewJob, type OverviewReadState
} from '../src/shared/agent/overview'
import { recommendedAlerts } from '../src/shared/actions/agent-alert'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { liveArgsSchemas } from '../src/shared/live/schema'
import { liveProbes, liveSources } from '../src/shared/live/catalog'
import { limits } from '../src/shared/ipc/wire/protocol'
import AgentOverview from '../src/renderer/src/agent/AgentOverview'
import { factsOfRows } from '../src/renderer/src/agent/AgentOverviewService'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { LiveTable } from '../src/renderer/src/live/LiveService'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'
import type { FakeLiveHandle } from './fixtures/live-handle'
import { agentOverviewFixText, createAgentOverviewFixes } from '../src/renderer/src/agent/agent-overview-fixes'
import { jobSections } from '../src/renderer/src/agent/JobDocumentService'
import { selectSection } from '../src/renderer/src/kit/document-frame'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const ok: OverviewReadState = { state: 'ok' }
const allRead = { facts: ok, state: ok, clock: ok, jobs: ok, properties: ok, alerts: ok, profiles: ok, owners: ok, history: ok, schedules: ok, mail: ok, service: ok }
const job = (name: string, patch: Partial<OverviewJob> = {}): OverviewJob => ({
  id: `00000000-0000-0000-0000-${String(name.length).padStart(12, '0')}`, name, enabled: true, owner: 'sa', category: '[Uncategorized]', notifyEmail: 2, notifyPage: 0, notifyNetsend: 0, scheduled: true,
  outcome: 1, lastRun: '2026-11-23T03:00:00', status: 4, ownerState: 0, historyRows: 10, historyRuns: 5, historyOldest: '2026-10-01T00:00:00', ...patch
})
const facts = (patch: Partial<OverviewFacts> = {}): OverviewFacts => ({
  platform: 'windows', sysadmin: true, agentXps: 1, serviceState: 4, startupType: 2, serverNow: '2026-11-23T12:00:00', historyMaxRows: 1000, historyMaxRowsPerJob: 100,
  mailXps: 1, mailProfiles: 1, useDatabaseMail: 1, agentProfile: 'AgentMail', agentProfileFound: 1, jobs: [job('Nightly')],
  alerts: recommendedAlerts.map(alert => ({ name: alert.name, enabled: true, messageId: alert.messageId, severity: alert.severity, notifies: true })),
  schedules: [{ id: 1, name: 'Nightly 02:30', enabled: true, jobs: 1 }], reads: allRead, ...patch
})

describe("the Agent overview's helpers", () => {
  it("links each name where a check's detail says it, as a whole word, longest first, and keeps the rest", () => {
    const purge = { kind: 'job' as const, name: 'Purge' }, audit = { kind: 'job' as const, name: 'Purge audit rows' }, a = { kind: 'job' as const, name: 'a' }, late = { kind: 'job' as const, name: 'Late' }
    expect(detailParts('Purge audit rows and Purge failed.', [purge, audit])).toEqual({ parts: [audit, ' and ', purge, ' failed.'], rest: [] })
    expect(detailParts('Backup is owned by a disabled login.', [a])).toEqual({ parts: ['Backup is owned by ', a, ' disabled login.'], rest: [] })
    expect(detailParts('Ab and 2 more.', [a, late])).toEqual({ parts: ['Ab and 2 more.'], rest: [a, late] })
    expect(detailParts('', [])).toEqual({ parts: [], rest: [] })
  })

  it('reads server-local stamps and says spans and names in words', () => {
    expect(stampMs('2026-11-23T12:00:00')! - stampMs('2026-11-23T00:00:00')!).toBe(12 * 3_600_000)
    expect(stampMs('23/11/2026')).toBeUndefined()
    expect(stampMs(undefined)).toBeUndefined()
    expect(spanText(20 * 60_000)).toBe('less than an hour')
    expect(spanText(12 * 3_600_000)).toBe('about 12 hours')
    expect(spanText(1 * 3_600_000)).toBe('about 1 hour')
    expect(spanText(3 * 24 * 3_600_000)).toBe('about 3 days')
    expect(namesText(['A'])).toBe('A')
    expect(namesText(['A', 'B'])).toBe('A and B')
    expect(namesText(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C and 2 more')
  })

  it('says why a check could not be read, by its read', () => {
    expect(unreadText({ state: 'role' }, 'the job owners\' logins')).toMatch(/^Only sysadmin can read the job owners' logins/)
    expect(unreadText({ state: 'platform' }, 'alerts')).toBe('SQL Server Agent on this server has no alerts.')
    expect(unreadText({ state: 'AGENT_DISABLED', message: 'x' }, 'the jobs')).toMatch(/^The jobs cannot be read while SQL Server Agent's extended procedures are off/)
    expect(unreadText({ state: 'PERMISSION_DENIED', message: 'This login may not read this part of SQL Server Agent.' }, 'the alerts')).toBe('This login may not read this part of SQL Server Agent.')
    expect(unreadText(undefined, 'the jobs')).toBe('Varia has not read the jobs yet.')
  })
})

describe("the Agent overview's checks", () => {
  it('passes every check on a healthy server, with no service check while Agent runs', () => {
    const checks = overviewChecks(facts())
    expect(checks.map(check => check.id)).toEqual(['failedJobs', 'owners', 'notify', 'history', 'alerts', 'mail', 'schedules'])
    expect(checks.every(check => check.severity === 'ok')).toBe(true)
    expect(needsAttention(checks)).toBe(0)
  })

  it('flags a stopped Agent, offering Start only to sysadmin on Windows and never for a Disabled service', () => {
    expect(serviceCheck(facts())).toBeUndefined()
    const stopped = serviceCheck(facts({ serviceState: 1, agentXps: 0 }))!
    expect(stopped).toMatchObject({ id: 'service', severity: 'error', title: 'SQL Server Agent is not running', fix: { action: { kind: 'startAgent' } } })
    expect(serviceCheck(facts({ serviceState: 1, agentXps: 0, startupType: 4 }))!.fix).toBeUndefined()
    expect(serviceCheck(facts({ serviceState: 1, agentXps: 0, sysadmin: false }))!.fix).toBeUndefined()
    expect(serviceCheck(facts({ serviceState: 1, agentXps: 0, platform: 'linux' }))!.fix).toBeUndefined()
    expect(serviceCheck(facts({ agentXps: 0, serviceState: undefined }))).toMatchObject({ severity: 'error', title: 'SQL Server Agent cannot run jobs now' })
    expect(serviceCheck(facts({ reads: {} }))).toBeUndefined()
    // A failed state read is not a stopped Agent: the check says it was not read.
    expect(serviceCheck(facts({ agentXps: undefined, serviceState: undefined, reads: { ...allRead, state: { state: 'SQL_ERROR', message: 'The read failed.' } } }))).toMatchObject({ severity: 'unread', detail: 'The read failed.' })
  })

  it('counts jobs whose last run failed within a day of the server clock, saying which are retrying', () => {
    const check = failedCheck(facts({
      jobs: [job('ETL', { outcome: 0, lastRun: '2026-11-23T02:00:00' }), job('Log backup', { outcome: 0, lastRun: '2026-11-23T11:45:00', status: 3 }),
        job('Old failure', { outcome: 0, lastRun: '2026-11-20T02:00:00' }), job('Fine')]
    }))
    expect(check).toMatchObject({ severity: 'error', title: '2 jobs failed in the last 24 hours', fix: { label: 'Show them', action: { kind: 'failedJobs' } } })
    expect(check.detail).toBe('ETL and Log backup (retrying). Counted by when the failed run started; Show them lists every job whose last run failed.')
    expect(check.objects).toEqual([{ kind: 'job', name: 'ETL' }, { kind: 'job', name: 'Log backup' }])
    // Without the server's clock every failed last run counts, said without a window.
    expect(failedCheck(facts({ serverNow: undefined, jobs: [job('Old failure', { outcome: 0, lastRun: '2026-11-20T02:00:00' })] })).title).toBe('1 job failed')
    expect(failedCheck(facts()).severity).toBe('ok')
    expect(failedCheck(facts({ reads: { ...allRead, jobs: { state: 'PERMISSION_DENIED', message: 'refused' } } }))).toMatchObject({ severity: 'unread', detail: 'refused' })
  })

  it('flags jobs whose owner cannot log in, with Change owner for exactly those jobs, and only for sysadmin', () => {
    const check = ownerCheck(facts({ jobs: [job('Purge audit rows', { owner: 'CONTOSO\\jsmith', ownerState: 1 }), job('Nightly')] }))
    expect(check).toMatchObject({ severity: 'warning', title: '1 job is owned by a disabled login' })
    expect(check.detail).toBe('Purge audit rows is owned by CONTOSO\\jsmith. A job whose owner cannot log in fails when it starts.')
    expect(check.fix?.action).toEqual({ kind: 'changeOwner', jobs: [{ id: job('Purge audit rows').id, name: 'Purge audit rows', owner: 'CONTOSO\\jsmith' }] })
    const mixed = ownerCheck(facts({ jobs: [job('A', { ownerState: 1 }), job('BB', { ownerState: 2 }), job('CCC', { ownerState: 3 })] }))
    expect(mixed.title).toBe('3 jobs are owned by logins that cannot log in')
    expect(mixed.detail).toContain('BB is owned by sa (login that no longer exists)')
    expect(ownerCheck(facts({ jobs: [job('A', { ownerState: 1 }), job('BB', { ownerState: 1 })] })).title).toBe('2 jobs are owned by disabled logins')
    expect(ownerCheck(facts({ jobs: [job('A', { ownerState: 2 }), job('BB', { ownerState: 2 })] })).title).toBe('2 jobs are owned by logins that no longer exist')
    expect(ownerCheck(facts({ jobs: [job('A', { ownerState: 3 }), job('BB', { ownerState: 3 })] })).title).toBe('2 jobs are owned by logins denied CONNECT SQL')
    // Below sysadmin the owners read never ran: the check says so rather than guessing.
    expect(ownerCheck(facts({ sysadmin: false, reads: { ...allRead, owners: { state: 'role' } } }))).toMatchObject({ severity: 'unread' })
    expect(ownerCheck(facts()).severity).toBe('ok')
  })

  it('flags enabled jobs that notify no operator on failure; the event log and success-only notifications are no one', () => {
    const check = notifyCheck(facts({
      jobs: [job('Index maintenance', { notifyEmail: 0 }), job('Purge', { notifyEmail: 1, notifyPage: 1 }), job('Paged', { notifyEmail: 0, notifyPage: 3 }), job('Off', { enabled: false, notifyEmail: 0 })]
    }))
    expect(check).toMatchObject({ severity: 'warning', title: '2 jobs notify no one when they fail', detail: 'Index maintenance and Purge.', fix: { label: 'Set notifications…', action: { kind: 'notifications', job: 'Index maintenance' } } })
    expect(notifyCheck(facts({ jobs: [job('One', { notifyEmail: 0 })] })).title).toBe('1 job notifies no one when it fails')
    expect(notifyCheck(facts()).severity).toBe('ok')
  })

  it('flags history that covers less than a week for a job at its cap, and nothing for unlimited history', () => {
    // 100 rows per job, a job writing 2 rows a run every 15 minutes: its 100 rows cover about 12 hours.
    const busy = job('Log backup – Sales', { historyRows: 100, historyRuns: 50, historyOldest: '2026-11-23T00:00:00' })
    const check = historyCheck(facts({ jobs: [busy, job('Nightly')] }))
    expect(check).toMatchObject({ severity: 'warning', title: 'History keeps only about 12 hours for Log backup – Sales', fix: { label: 'History settings…', action: { kind: 'agentProperties' } } })
    expect(check.detail).toBe('History is capped at 1,000 rows, 100 per job. Log backup – Sales writes about 2 rows a run, so its history covers about 12 hours.')
    // Under the per-job cap and the total cap, a short history is just a young job.
    expect(historyShortfalls(facts({ jobs: [job('New', { historyRows: 4, historyRuns: 2, historyOldest: '2026-11-23T10:00:00' })] }))).toEqual([])
    // A job created inside the window has short history because it is new, even at its cap: not flagged.
    expect(historyShortfalls(facts({ jobs: [{ ...busy, created: '2026-11-22T23:00:00' }] }))).toEqual([])
    expect(historyShortfalls(facts({ jobs: [{ ...busy, created: '2026-01-01T00:00:00' }] }))).toHaveLength(1)
    // The jobs' rows together at the total cap, each well under its own: Agent purges the oldest across jobs, so a short history is flagged.
    const crowded = Array.from({ length: 10 }, (_, at) => job(`Job ${at}`.padEnd(6 + at, 'x'), { historyRows: 100, historyRuns: 50, historyOldest: '2026-11-22T00:00:00' }))
    expect(historyShortfalls(facts({ historyMaxRowsPerJob: 500, jobs: crowded }))).toHaveLength(10)
    expect(historyCheck(facts({ historyMaxRowsPerJob: 500, jobs: crowded })).title).toBe('History keeps less than a week for 10 jobs')
    expect(historyShortfalls(facts({ historyMaxRowsPerJob: 500, jobs: crowded.slice(1) }))).toEqual([])
    expect(historyCheck(facts({ historyMaxRows: -1, jobs: [busy] }))).toMatchObject({ severity: 'ok', title: 'History is not limited by size' })
    expect(historyCheck(facts({ reads: { ...allRead, history: { state: 'role' } } })).severity).toBe('unread')
    expect(historyCheck(facts({ historyMaxRows: undefined, reads: { ...allRead, properties: { state: 'AGENT_DISABLED' } } }))).toMatchObject({ severity: 'unread' })
  })

  it('lists the missing recommended alerts, offers Add recommended alerts only to sysadmin, and is not checked off Windows', () => {
    const present = facts().alerts.filter(alert => [17, 24].includes(alert.severity) || alert.messageId === 823)
    const check = alertsCheck(facts({ alerts: present }))
    expect(check).toMatchObject({ severity: 'warning', title: 'Recommended alerts are missing', fix: { label: 'Add recommended alerts…', action: { kind: 'recommendedAlerts' } } })
    expect(check.detail).toBe('Missing: severity 019, 020, 021, 022, 023 and 025, and errors 824 and 825. Severity 017 and 024, and error 823 exist.')
    // An alert on the same severity under another name counts, as Add recommended alerts' own dialog counts it.
    expect(alertsCheck(facts({ alerts: [...facts().alerts.slice(1), { name: 'Sev 17 renamed', enabled: true, messageId: 0, severity: 17, notifies: false }] })).severity).toBe('ok')
    expect(alertsCheck(facts({ sysadmin: false, alerts: present })).fix).toBeUndefined()
    // A recommended alert that exists but is disabled never fires: named, and a warning even when none is missing.
    const disabled = facts().alerts.map(alert => alert.severity === 24 || alert.messageId === 823 ? { ...alert, enabled: false } : alert)
    expect(alertsCheck(facts({ alerts: disabled }))).toMatchObject({ severity: 'warning', title: '2 recommended alerts are disabled' })
    expect(alertsCheck(facts({ alerts: disabled })).detail).toContain('Disabled, so never raised: severity 024, and error 823.')
    expect(alertsCheck(facts({ alerts: present.map(alert => alert.messageId === 823 ? { ...alert, enabled: false } : alert) })).detail).toContain('Disabled, so never raised: error 823.')
    expect(alertsCheck(facts({ platform: 'linux', reads: { ...allRead, alerts: { state: 'platform' } } }))).toMatchObject({ severity: 'unread', detail: 'SQL Server Agent on this server has no alerts.' })
    expect(alertsCheck(facts({ reads: { ...allRead, alerts: { state: 'PERMISSION_DENIED', message: 'This login may not read this part of SQL Server Agent.' } } })).severity).toBe('unread')
  })

  it('checks Agent mail as the job document does, warning only while a job or alert notifies someone', () => {
    expect(mailCheck(facts())).toMatchObject({ severity: 'ok', title: 'Agent mail is set up', detail: 'Database Mail profile AgentMail.' })
    const off = mailCheck(facts({ mailXps: 0 }))
    expect(off).toMatchObject({ severity: 'warning', title: 'Agent mail is not set up' })
    expect(mailCheck(facts({ useDatabaseMail: 0, agentProfile: undefined, agentProfileFound: undefined })).severity).toBe('warning')
    expect(mailCheck(facts({ agentProfileFound: 0 })).detail).toMatch(/^SQL Server Agent's mail profile AgentMail is not a Database Mail profile any more/)
    expect(mailCheck(facts({ mailProfiles: 0, alerts: [], jobs: [job('Quiet', { notifyEmail: 0 })] })).severity).toBe('info')
    expect(mailCheck(facts({ reads: { ...allRead, mail: { state: 'role' } } })).severity).toBe('unread')
    // Agent's own mail settings unread (a shape error): Database Mail XPs and the profiles still decide, and the detail says what was not read.
    const shapeError = { ...allRead, mail: { state: 'BACKEND_ERROR', message: 'The Agent read agentMail returned other columns.' } }
    expect(mailCheck(facts({ reads: shapeError, useDatabaseMail: undefined, agentProfile: undefined, agentProfileFound: undefined }))).toMatchObject({ severity: 'ok', title: 'Database Mail is set up' })
    expect(mailCheck(facts({ reads: shapeError, mailXps: 0, useDatabaseMail: undefined, agentProfile: undefined, agentProfileFound: undefined })).severity).toBe('warning')
    expect(mailCheck(facts({ reads: { ...shapeError, profiles: { state: 'PERMISSION_DENIED' } }, useDatabaseMail: undefined, agentProfile: undefined })).severity).toBe('unread')
  })

  it('names unused schedules (sysadmin) with Open Schedules', () => {
    const check = schedulesCheck(facts({ schedules: [{ id: 1, name: 'Nightly 02:30', enabled: true, jobs: 1 }, { id: 2, name: 'Quarter end', enabled: true, jobs: 0 }] }))
    expect(check).toMatchObject({ severity: 'info', title: '1 schedule is unused', detail: 'Quarter end.', objects: [{ kind: 'schedule', name: 'Quarter end' }], fix: { action: { kind: 'schedules' } } })
    // Schedule names need not be unique (msdb's 14371): two unused schedules of one name are two objects, keyed apart by position in the view.
    expect(schedulesCheck(facts({ schedules: [{ id: 2, name: 'Daily', enabled: true, jobs: 0 }, { id: 3, name: 'Daily', enabled: true, jobs: 0 }] })).objects).toEqual([{ kind: 'schedule', name: 'Daily' }, { kind: 'schedule', name: 'Daily' }])
    expect(schedulesCheck(facts({ reads: { ...allRead, schedules: { state: 'role' } } })).severity).toBe('unread')
  })

  it('never passes a check over the jobs when the jobs read failed, and keeps a mail problem a warning while usage is unknown', () => {
    const noJobs = { ...allRead, jobs: { state: 'AGENT_DISABLED' } }
    const bad = facts({ reads: noJobs, jobs: [] })
    expect([ownerCheck(bad), historyCheck(bad), notifyCheck(bad), failedCheck(bad)].map(check => check.severity)).toEqual(['unread', 'unread', 'unread', 'unread'])
    expect(ownerCheck(bad).detail).toMatch(/^The jobs cannot be read while SQL Server Agent's extended procedures are off/)
    expect(mailCheck(facts({ reads: noJobs, jobs: [], alerts: [], mailXps: 0 })).severity).toBe('warning')
    expect(mailCheck(facts({ reads: { ...allRead, alerts: { state: 'platform' } }, alerts: [], jobs: [job('Quiet', { notifyEmail: 0 })], mailXps: 0 })).severity).toBe('info')
  })

  it('says a check over a list Agent cut at its cap checked only part of it, and a pass there is a note', () => {
    const cut = facts({ reads: { ...allRead, jobs: { state: 'ok', truncated: true } } })
    const checks = overviewChecks(cut)
    expect(checks.find(check => check.id === 'failedJobs')).toMatchObject({ severity: 'info' })
    expect(checks.filter(check => check.detail.endsWith(overviewTruncatedText)).map(check => check.id)).toEqual(['failedJobs', 'owners', 'notify', 'history', 'mail'])
    expect(checks.find(check => check.id === 'alerts')!.severity).toBe('ok')
    expect(overviewTiles(cut)[0]!.value).toBe('1+')
  })

  it('shows what a login below sysadmin can read and says the rest is sysadmin\'s', () => {
    const role = { ...allRead, owners: { state: 'role' }, history: { state: 'role' }, schedules: { state: 'role' }, mail: { state: 'role' }, service: { state: 'role' } }
    const checks = overviewChecks(facts({ sysadmin: false, reads: role, jobs: [job('Mine', { ownerState: undefined, historyRows: undefined, historyRuns: undefined, historyOldest: undefined, notifyEmail: 0 })] }))
    expect(checks.map(check => [check.id, check.severity])).toEqual([['failedJobs', 'ok'], ['owners', 'unread'], ['notify', 'warning'], ['history', 'unread'], ['alerts', 'ok'], ['mail', 'unread'], ['schedules', 'unread']])
  })
})

describe("the Agent overview's tiles and header", () => {
  it('counts jobs, failed, running and alerts, with — for what was not read', () => {
    const tiles = overviewTiles(facts({
      jobs: [job('ETL', { outcome: 0, lastRun: '2026-11-23T02:00:00' }), job('Index', { status: 1 }), job('Off', { enabled: false })],
      alerts: [{ name: 'Severity 017', enabled: true, messageId: 0, severity: 17, notifies: true, lastOccurred: '2026-11-20T10:00:00' }, { name: 'Old', enabled: true, messageId: 823, severity: 0, notifies: true, lastOccurred: '2026-10-01T00:00:00' }]
    }))
    expect(tiles).toEqual([
      { id: 'jobs', label: 'Total jobs', value: '3', detail: '2 enabled' },
      { id: 'failed', label: 'Failed (24 h)', value: '1', detail: 'ETL', tone: 'error' },
      { id: 'running', label: 'Running now', value: '1', detail: 'Index', tone: 'accent' },
      { id: 'alerts', label: 'Alerts (7 d)', value: '2', detail: '1 fired this week' }
    ])
    const unreadTiles = overviewTiles(facts({ reads: { ...allRead, jobs: { state: 'PERMISSION_DENIED' }, alerts: { state: 'platform' } } }))
    expect(unreadTiles.map(tile => tile.value)).toEqual(['—', '—', '—', '—'])
  })

  it('words the service state and startup type', () => {
    expect(serviceWords(facts())).toEqual({ state: 'Running', tone: 'ok', startup: 'Starts automatically' })
    expect(serviceWords(facts({ serviceState: 1, agentXps: 0, startupType: 4 }))).toEqual({ state: 'Stopped', tone: 'error', startup: 'Disabled' })
    expect(serviceWords(facts({ reads: {} })).state).toBe('Reading…')
  })
})

describe('the agent.overview source', () => {
  it('is in the live catalogue with no args, four tables and at most the protocol\'s status values', () => {
    expect(liveSources['agent.overview'].probes).toEqual(['agent.overview.read'])
    const spec = liveProbes['agent.overview.read']
    expect(spec.tables!.map(table => table.id)).toEqual(['jobs', 'alerts', 'schedules', 'reads'])
    expect(spec.status!.length).toBeLessThanOrEqual(limits.live.statuses)
    expect(liveArgsSchemas['agent.overview'].safeParse({}).success).toBe(false)
  })

  it('reads a sample\'s status values and rows back as facts', () => {
    const status = overviewStatus([{ id: 'platform', value: 'linux' }, { id: 'isSysadmin', value: 0 }, { id: 'agentXps', value: 1 }, { id: 'serverNow', value: '2026-11-23T12:00:00' }, { id: 'agentProfile', value: '' }, { id: 'unknown', value: 3 }])
    expect(status).toEqual({ platform: 'linux', sysadmin: false, agentXps: 1, serverNow: '2026-11-23T12:00:00' })
    const cells = (values: Record<string, string | undefined>) => (column: string) => values[column]
    const read = factsOfRows([], [cells({ jobId: 'A', jobName: 'Nightly', jobEnabled: '1', jobOwner: 'sa', jobOutcome: '0', jobLastRun: '2026-11-23T03:00:00', jobNotifyEmail: '2', jobOwnerState: '1', jobHistoryRows: '98', jobCreated: '2026-01-02T03:04:05' })],
      [cells({ alertName: 'Sev 17', alertEnabled: '1', alertMessageId: '0', alertSeverity: '17', alertNotifies: '1' })], [cells({ scheduleId: '7', scheduleName: 'Quarter end', scheduleEnabled: '1', scheduleJobs: '0' })],
      [cells({ readId: 'jobs', readState: 'ok' }), cells({ readId: 'owners', readState: 'role' }), cells({ readId: 'alerts', readState: 'PERMISSION_DENIED', readMessage: 'refused', readTruncated: '0' }), cells({ readId: 'bogus', readState: 'ok' })])
    expect(read.jobs).toEqual([{ id: 'A', name: 'Nightly', enabled: true, owner: 'sa', category: '', notifyEmail: 2, notifyPage: 0, notifyNetsend: 0, scheduled: false, outcome: 0, lastRun: '2026-11-23T03:00:00', ownerState: 1, historyRows: 98, created: '2026-01-02T03:04:05' }])
    expect(read.alerts).toEqual([{ name: 'Sev 17', enabled: true, messageId: 0, severity: 17, notifies: true }])
    expect(read.schedules).toEqual([{ id: 7, name: 'Quarter end', enabled: true, jobs: 0 }])
    expect(read.reads).toEqual({ jobs: { state: 'ok' }, owners: { state: 'role' }, alerts: { state: 'PERMISSION_DENIED', message: 'refused' } })
  })
})

describe('the Agent overview document', () => {
  function overview() {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))
    const handle = () => (fixture.live.handles as FakeLiveHandle[]).find(item => item.spec.source === 'agent.overview')!
    return { ...fixture, handle }
  }
  const table = (rows: string[][]): LiveTable => ({
    handle: { getWindow: async (first: number, count: number) => { const slice = rows.slice(first, first + count); const columns = slice[0]?.length ?? 0; return { first, count: slice.length, colStart: 0, colEnd: columns, text: slice.flat(), flags: new Uint8Array(slice.length * columns) } } },
    descriptor: { rowsAvailable: rows.length }
  }) as unknown as LiveTable

  it("says why Job Activity Monitor opened no Change owner form for the overview's jobs", async () => {
    const fixture = overview()
    const id = fixture.jobActivity.open('c1')
    const many = Array.from({ length: 101 }, (_, at) => ({ id: `J${at}`, name: `Job ${at}`, status: '', lastRun: '', owner: 'old' }))
    expect(await fixture.jobActivity.openForm(id, 'changeOwner', many)).toBe('Select at most 100 jobs: each one is its own request.')
    expect(fixture.jobActivity.get(id)!.form).toBeUndefined()
  })

  it("retries a failed Change owner form for the overview's jobs, not the monitor's selection", async () => {
    const fixture = overview()
    const id = fixture.jobActivity.open('c1')
    const given = [{ id: 'J1', name: 'Purge', status: '', lastRun: '', owner: 'old' }]
    fixture.api.describeObject.mockResolvedValueOnce({ ok: false, error: 'The read timed out.' } as never)
    await fixture.jobActivity.openForm(id, 'changeOwner', given)
    expect(fixture.jobActivity.get(id)!.form).toMatchObject({ state: 'failed', jobs: given })
    fixture.api.describeObject.mockResolvedValueOnce({ ok: true, value: { agentJobDocument: { sysadmin: true, owners: ['sa'] }, elapsedMs: 1 } } as never)
    await fixture.jobActivity.retryForm(id)
    expect(fixture.jobActivity.get(id)!.form).toMatchObject({ state: 'ready', jobs: given })
    expect(fixture.api.describeObject).toHaveBeenCalledTimes(2)
  })

  it('opens one document per connection from its command, reads each sample into checks and runs a fix through its owner', async () => {
    const fixture = overview()
    expect(commandDescriptor('agent.overview').menus?.[0]).toMatchObject({ menu: 'explorer.context', group: '1_monitor' })
    await fixture.commands.execute('agent.overview', undefined, 'palette')
    expect(fixture.documents.active).toMatchObject({ kind: 'agentOverview', name: 'Agent Overview - c1.example', connectionId: 'c1', database: 'msdb' })
    expect(fixture.context.getState().activeDocumentIsAgentOverview).toBe(true)
    const id = fixture.documents.active!.id
    await fixture.commands.execute('agent.overview', undefined, 'palette')
    expect(fixture.documents.getSnapshot().documents.filter(document => document.kind === 'agentOverview')).toHaveLength(1)
    const handle = fixture.handle()
    expect(handle.spec.probes).toEqual([{ probe: 'agent.overview.read', intervalMs: 60_000 }])
    // jobs: jobId … jobHistoryOldest (16 columns); reads: readId, readState, readMessage, readTruncated.
    handle.tables.set('agent.overview.read:0', table([['J1', 'Purge', '1', 'CONTOSO\\jsmith', '', '1', '2026-11-23T03:00:00', '4', '0', '0', '0', '1', '1', '10', '5', '2026-10-01T00:00:00', '2026-01-02T03:04:05']]))
    handle.tables.set('agent.overview.read:1', table([]))
    handle.tables.set('agent.overview.read:2', table([]))
    handle.tables.set('agent.overview.read:3', table([['jobs', 'ok', '', '0'], ['owners', 'ok', '', '0'], ['alerts', 'platform', '', '0']]))
    handle.deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'agent.overview.read', status: [{ id: 'isSysadmin', value: 1 }, { id: 'agentXps', value: 1 }, { id: 'serverNow', value: '2026-11-23T12:00:00' }] }] } as never)
    await settled()
    const state = fixture.agentOverview.get(id)!
    expect(state.checks!.find(check => check.id === 'owners')).toMatchObject({ severity: 'warning', title: '1 job is owned by a disabled login' })
    expect(state.checks!.find(check => check.id === 'notify')).toMatchObject({ severity: 'warning', title: '1 job notifies no one when it fails' })
    expect(state.checks!.find(check => check.id === 'alerts')!.severity).toBe('unread')
    await fixture.agentOverview.fix(id, state.checks!.find(check => check.id === 'owners')!.fix!.action)
    expect(fixture.overviewFixes.changeOwner).toHaveBeenCalledWith('c1', [{ id: 'J1', name: 'Purge', owner: 'CONTOSO\\jsmith' }])
    await fixture.agentOverview.fix(id, { kind: 'notifications', job: 'Purge' })
    expect(fixture.overviewFixes.openJob).toHaveBeenCalledWith('c1', 'Purge', 'notifications')
    fixture.overviewFixes.agentProperties.mockImplementationOnce(() => { throw new Error('Expand the server in Object Explorer until its SQL Server Agent node shows, then try again.') })
    await fixture.agentOverview.fix(id, { kind: 'agentProperties' })
    expect(fixture.agentOverview.get(id)!.notice).toMatch(/^Expand the server/)
    // Check again asks for a sample now.
    const before = handle.refreshes
    await fixture.commands.execute('agent.refreshOverview', { tabId: id }, 'toolbar')
    expect(handle.refreshes).toBe(before + 1)
  })
})

describe("the Agent overview's fixes", () => {
  function fixes(commands?: Parameters<typeof createAgentOverviewFixes>[0]['commands'], node = false) {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))
    const explorer = { agentNodeOf: (connectionId: string) => node && connectionId === 'c1' ? { id: 'agent-node', kind: 'agent', connectionId } as never : fixture.explorer.agentNodeOf(connectionId) }
    return { fixture, fixes: createAgentOverviewFixes({ ...fixture, explorer, commands: commands ?? (() => fixture.commands) }) }
  }

  it('opens Job Activity Monitor on All, Running, Failed, and Operators and Notifications for Alerts', async () => {
    const { fixture, fixes: run } = fixes()
    run.jobsView!('c1', 'all')
    const id = fixture.documents.active!.id
    expect(fixture.jobActivity.get(id)!.view).toBe('all')
    run.jobsView!('c1', 'running')
    expect(fixture.jobActivity.get(id)!.view).toBe('running')
    run.failedJobs('c1')
    expect(fixture.jobActivity.get(id)!.view).toBe('failed')
    run.alerts!('c1')
    expect(fixture.documents.active).toMatchObject({ connectionId: 'c1', kind: 'agentOperators' })
  })

  it('opens Job Activity Monitor on Failed, and Change owner for at most the bulk limit, saying so', async () => {
    const { fixture, fixes: run } = fixes()
    run.failedJobs('c1')
    const id = fixture.documents.active!.id
    expect(fixture.jobActivity.get(id)!.view).toBe('failed')
    const many = Array.from({ length: 101 }, (_, at) => ({ id: `J${at}`, name: `Job ${at}`, owner: 'old' }))
    await expect(run.changeOwner('c1', many)).rejects.toThrow(agentOverviewFixText.firstJobs(100, 101))
    expect(fixture.jobActivity.get(id)!.form).toMatchObject({ verb: 'changeOwner' })
    expect(fixture.jobActivity.get(id)!.form!.jobs).toHaveLength(100)
  })

  it("opens the job's Notifications section, Add recommended alerts and the Schedules document", () => {
    const { fixture, fixes: run } = fixes()
    run.openJob('c1', 'Nightly', 'notifications')
    const job = fixture.documents.active!.id
    const frame = fixture.jobDocuments.get(job)!.frame
    expect(selectSection(frame, jobSections, 'notifications')).toEqual(frame)
    run.recommendedAlerts('c1')
    expect(fixture.operatorsDocuments.get(fixture.documents.active!.id)).toMatchObject({ ask: 'recommended' })
    run.schedules('c1')
    expect(fixture.documents.active).toMatchObject({ connectionId: 'c1' })
    expect(fixture.documents.active!.id).not.toBe(job)
  })

  it('says why Agent Properties and Start cannot open, and Start says why its command is refused', async () => {
    const { fixes: run } = fixes()
    expect(() => run.agentProperties('c1', 'history')).toThrow(agentOverviewFixText.noAgentNode)
    await expect(run.startAgent('c1')).rejects.toThrow(agentOverviewFixText.noAgentNode)
    const refused = { isEnabled: () => false, unavailableReason: () => 'Varia starts SQL Server Agent only from Windows.', execute: vi.fn(async () => true) }
    const { fixes: greyed } = fixes(() => refused, true)
    await expect(greyed.startAgent('c1')).rejects.toThrow('Varia starts SQL Server Agent only from Windows.')
    expect(refused.execute).not.toHaveBeenCalled()
    const failed = { isEnabled: () => true, unavailableReason: () => undefined, execute: vi.fn(async () => false) }
    await expect(fixes(() => failed, true).fixes.startAgent('c1')).rejects.toThrow(agentOverviewFixText.cannotStart)
    const started = { isEnabled: () => true, unavailableReason: () => undefined, execute: vi.fn(async () => true) }
    await fixes(() => started, true).fixes.startAgent('c1')
    expect(started.execute).toHaveBeenCalledWith('explorer.startAgent', { target: { kind: 'explorer', node: expect.objectContaining({ kind: 'agent' }) } }, 'toolbar')
  })
})

describe('AgentOverview UI (AP-3)', () => {
  it('hoists service StatusPill and Properties into DocumentHeader, renders FactLine, clickable KPI tiles, grouped checks, and object chips', async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))
    const id = fixture.agentOverview.open('c1')
    const handle = (fixture.live.handles as FakeLiveHandle[]).find(item => item.spec.source === 'agent.overview')!
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(WorkbenchProvider, { workbench: fixture as unknown as Workbench, children: createElement(AgentOverview, { documentId: id }) })) })
    cleanups.unshift(() => { act(() => root.unmount()); host.remove() })

    const makeTable = (rows: string[][]): LiveTable => ({
      handle: { getWindow: async (first: number, count: number) => { const slice = rows.slice(first, first + count); const columns = slice[0]?.length ?? 0; return { first, count: slice.length, colStart: 0, colEnd: columns, text: slice.flat(), flags: new Uint8Array(slice.length * columns) } } },
      descriptor: { rowsAvailable: rows.length }
    }) as unknown as LiveTable
    handle.tables.set('agent.overview.read:0', makeTable([
      ['J1', 'Nightly', '1', 'sa', '', '0', '2026-11-23T11:00:00', '4', '2', '0', '0', '1', '0', '10', '5', '2026-10-01T00:00:00', '2026-01-02T03:04:05'],
      ['J2', 'Backup', '1', 'sa', '', '1', '2026-11-23T03:00:00', '4', '0', '0', '0', '1', '0', '10', '5', '2026-10-01T00:00:00', '2026-01-02T03:04:05']
    ]))
    handle.tables.set('agent.overview.read:1', makeTable([]))
    handle.tables.set('agent.overview.read:2', makeTable([['9', 'Quarter end', '1', '0']]))
    handle.tables.set('agent.overview.read:3', makeTable([
      ['facts', 'ok', '', '0'], ['state', 'ok', '', '0'], ['clock', 'ok', '', '0'],
      ['jobs', 'ok', '', '0'], ['properties', 'ok', '', '0'], ['owners', 'ok', '', '0'], ['alerts', 'platform', '', '0'],
      ['profiles', 'ok', '', '0'], ['history', 'ok', '', '0'], ['schedules', 'ok', '', '0'], ['mail', 'ok', '', '0'], ['service', 'ok', '', '0']
    ]))
    await act(async () => {
      handle.deliver({
        type: 'live.tick', seq: 1, sampledAt: Date.UTC(2026, 10, 23, 12, 0, 0),
        samples: [{
          probe: 'agent.overview.read',
          status: [
            { id: 'platform', value: 'windows' }, { id: 'productVersion', value: '17.0.1000.7' },
            { id: 'isSysadmin', value: 1 }, { id: 'agentXps', value: 1 }, { id: 'serviceState', value: 4 }, { id: 'startupType', value: 2 },
            { id: 'serverNow', value: '2026-11-23T12:00:00' }, { id: 'serviceAccount', value: 'NT SERVICE\\SQLSERVERAGENT' },
            { id: 'mailXps', value: 1 }, { id: 'mailProfiles', value: 1 }, { id: 'useDatabaseMail', value: 1 }, { id: 'agentProfile', value: 'Ops' }, { id: 'agentProfileFound', value: 1 },
            { id: 'historyMaxRows', value: 1000 }, { id: 'historyMaxRowsPerJob', value: 100 }
          ]
        }]
      } as never)
      await settled()
    })

    // No legacy .agent-overview-head; StatusPill + Properties hoisted into DocumentHeader; FactLine rendered.
    expect(host.querySelector('.agent-overview-head')).toBeNull()
    const status = host.querySelector('[role="status"][aria-label="SQL Server Agent: Running"]')!
    expect(status.textContent).toContain('Running · Automatic')
    const propsBtn = Array.from(host.querySelectorAll<HTMLButtonElement>('.document-actions button')).find(btn => btn.textContent?.includes('Properties'))!
    expect(propsBtn.classList.contains('document-verb')).toBe(true)
    expect(propsBtn.querySelector(':scope > .codicon[data-icon="settings-gear"]')).not.toBeNull()
    const factsText = host.querySelector('.document-facts')!.textContent!
    expect(factsText).toContain('Service Account')
    expect(factsText).toContain('NT SERVICE\\SQLSERVERAGENT')
    expect(factsText).toContain('17.0.1000.7')
    expect(factsText).toContain('Checked')

    // Clickable KPI tiles open filtered JAM / Operators & Notifications.
    const tileButtons = Array.from(host.querySelectorAll<HTMLButtonElement>('.agent-overview-tile'))
    expect(tileButtons).toHaveLength(4)
    expect(tileButtons.map(b => b.getAttribute('aria-label'))).toEqual([
      expect.stringContaining('Total jobs: 2'),
      expect.stringContaining('Failed (24 h): 1'),
      expect.stringContaining('Running now: 0'),
      expect.stringContaining('Alerts (7 d): —')
    ])
    const openSpy = vi.spyOn(fixture.agentOverview, 'openTile')
    await act(async () => { tileButtons[0]!.click(); tileButtons[1]!.click(); tileButtons[2]!.click(); tileButtons[3]!.click() })
    expect(openSpy.mock.calls.map(c => c[1])).toEqual(['jobs', 'failed', 'running', 'alerts'])
    expect(fixture.overviewFixes.jobsView).toHaveBeenNthCalledWith(1, 'c1', 'all')
    expect(fixture.overviewFixes.failedJobs).toHaveBeenCalledWith('c1')
    expect(fixture.overviewFixes.jobsView).toHaveBeenNthCalledWith(2, 'c1', 'running')
    expect(fixture.overviewFixes.alerts).toHaveBeenCalledWith('c1')

    // Grouped sections: Needs attention, Notes, Passing (compact), Not checked.
    const headings = Array.from(host.querySelectorAll('.ov-group-head h3')).map(h => h.textContent)
    expect(headings).toEqual(['Needs attention', 'Notes', 'Passing', 'Not checked'])
    expect(host.querySelector('.ov-check-list.is-compact')).not.toBeNull()

    // Object chips navigate to job / schedules.
    const jobChip = Array.from(host.querySelectorAll<HTMLButtonElement>('.ov-obj-chip')).find(btn => btn.textContent === 'Nightly')!
    await act(async () => { jobChip.click() })
    expect(fixture.overviewFixes.openJob).toHaveBeenCalledWith('c1', 'Nightly')
  })

  it('restores focus in priority order: check action button, KPI tile, header Properties, and Retry on error', async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))
    const id = fixture.agentOverview.open('c1')
    const handle = (fixture.live.handles as FakeLiveHandle[]).find(item => item.spec.source === 'agent.overview')!
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(WorkbenchProvider, { workbench: fixture as unknown as Workbench, children: createElement(AgentOverview, { documentId: id }) })) })
    cleanups.unshift(() => { act(() => root.unmount()); host.remove() })

    const makeTable = (rows: string[][]): LiveTable => ({
      handle: { getWindow: async (first: number, count: number) => { const slice = rows.slice(first, first + count); const columns = slice[0]?.length ?? 0; return { first, count: slice.length, colStart: 0, colEnd: columns, text: slice.flat(), flags: new Uint8Array(slice.length * columns) } } },
      descriptor: { rowsAvailable: rows.length }
    }) as unknown as LiveTable
    const deliverSample = async (jobsRows: string[][], alertRows: string[][], scheduleRows: string[][]) => {
      handle.tables.set('agent.overview.read:0', makeTable(jobsRows))
      handle.tables.set('agent.overview.read:1', makeTable(alertRows))
      handle.tables.set('agent.overview.read:2', makeTable(scheduleRows))
      handle.tables.set('agent.overview.read:3', makeTable([
        ['facts', 'ok', '', '0'], ['state', 'ok', '', '0'], ['clock', 'ok', '', '0'],
        ['jobs', 'ok', '', '0'], ['properties', 'ok', '', '0'], ['owners', 'ok', '', '0'], ['alerts', 'ok', '', '0'],
        ['profiles', 'ok', '', '0'], ['history', 'ok', '', '0'], ['schedules', 'ok', '', '0'], ['mail', 'ok', '', '0'], ['service', 'ok', '', '0']
      ]))
      await act(async () => {
        handle.deliver({
          type: 'live.tick', seq: 1, sampledAt: Date.UTC(2026, 10, 23, 12, 0, 0),
          samples: [{
            probe: 'agent.overview.read',
            status: [
              { id: 'platform', value: 'windows' }, { id: 'productVersion', value: '17.0.1000.7' },
              { id: 'isSysadmin', value: 1 }, { id: 'agentXps', value: 1 }, { id: 'serviceState', value: 4 }, { id: 'startupType', value: 2 },
              { id: 'serverNow', value: '2026-11-23T12:00:00' }, { id: 'serviceAccount', value: 'NT SERVICE\\SQLSERVERAGENT' },
              { id: 'mailXps', value: 1 }, { id: 'mailProfiles', value: 1 }, { id: 'useDatabaseMail', value: 1 }, { id: 'agentProfile', value: 'Ops' }, { id: 'agentProfileFound', value: 1 },
              { id: 'historyMaxRows', value: 1000 }, { id: 'historyMaxRowsPerJob', value: 100 }
            ]
          }]
        } as never)
        await settled()
      })
    }

    // 1. Loading state (!facts): falls back to .document-actions button (Properties).
    fixture.agentOverview.focus(id)
    expect(document.activeElement?.closest('.document-actions')).not.toBeNull()

    // 2. Problem state (.ov-check button present): focuses .ov-check button ahead of .document-actions and KPI tiles.
    await deliverSample(
      [['J1', 'Nightly', '1', 'sa', '', '0', '2026-11-23T11:00:00', '4', '2', '0', '0', '1', '0', '10', '5', '2026-10-01T00:00:00', '2026-01-02T03:04:05']],
      [],
      []
    )
    fixture.agentOverview.focus(id)
    expect(document.activeElement?.closest('.ov-check')).not.toBeNull()

    // 3. Passing-only state (0 .ov-check buttons, 4 KPI tiles): focuses first .agent-overview-tile ahead of .document-actions.
    await deliverSample(
      [['J1', 'Nightly', '1', 'sa', '', '1', '2026-11-23T03:00:00', '4', '2', '0', '0', '1', '0', '10', '5', '2026-10-01T00:00:00', '2026-01-02T03:04:05']],
      recommendedAlerts.map(alert => [alert.name, '1', String(alert.messageId), String(alert.severity), '', '1']),
      [['1', 'Nightly 02:30', '1', '1']]
    )
    expect(host.querySelectorAll('.ov-check button')).toHaveLength(0)
    fixture.agentOverview.focus(id)
    expect(document.activeElement?.classList.contains('agent-overview-tile')).toBe(true)

    // 4. Error state (ended: 'failed'): falls back to .document-actions button.
    await act(async () => {
      handle.set({ status: 'ended', ended: { ended: 'failed', code: 'TIMEOUT', message: 'Timed out.', ticks: 1, elapsedMs: 10 }, probes: {} } as never)
      await settled()
    })
    fixture.agentOverview.focus(id)
    expect(document.activeElement?.closest('.document-actions')).not.toBeNull()
  })
})
