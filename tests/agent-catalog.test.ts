import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  agentCallIndexLimit, agentCatalogJson, agentEngineEditions, agentErrorNumbers, agentFeatures, agentGateOpen, agentJobSaveCalls, agentLimits, agentPlatform, agentPlatformGates, agentPlatforms,
  alertTypes, decodeAgentDate, decodeAgentDateTime, decodeAgentDuration, decodeAgentTime, executionStatuses, formatAgentDateTime, formatAgentDuration, frequencyTypes, lastRunOutcomes,
  masterReadShapes, notificationMethods, notifyLevels, platformSubsystems, readProcedures, relativeDays, relativeIntervals, runningExecutionStatuses, runStatuses, stepActions, stepFlagMask,
  stepFlags, subdayTypes, subsystems, weekDays, writeProcedures
} from '../src/shared/agent/catalog'
import { generatedMarker, renderAgentDocs } from '../src/shared/agent/docs'

const unique = (values: readonly unknown[]) => new Set(values).size === values.length
const docsPath = join('docs', 'sql-server-agent.md')

describe('Agent catalogue', () => {
  it('has unique codes in every code table, with msdb\'s values', () => {
    const tables = { runStatuses, lastRunOutcomes, executionStatuses, stepActions, frequencyTypes, subdayTypes, relativeIntervals, weekDays, relativeDays, notifyLevels, alertTypes, notificationMethods }
    for (const [name, rows] of Object.entries(tables)) {
      expect(unique(rows.map(row => row.code)), name).toBe(true)
      for (const row of rows) expect(row.label, name).toMatch(/^\S(.*\S)?$/)
    }
    expect(runStatuses.map(row => row.code)).toEqual([0, 1, 2, 3, 4])
    expect(lastRunOutcomes.map(row => row.code)).toEqual([0, 1, 3, 5])
    expect(executionStatuses.map(row => row.code)).toEqual([0, 1, 2, 3, 4, 5, 7])
    for (const status of runningExecutionStatuses) expect(executionStatuses.map(row => row.code)).toContain(status)
    expect(frequencyTypes.map(row => row.code)).toEqual([1, 4, 8, 16, 32, 64, 128])
    expect(subdayTypes.map(row => row.code)).toEqual([1, 2, 4, 8])
    expect(alertTypes.map(row => row.code)).toEqual([1, 2, 4])
    expect(relativeIntervals.map(row => row.code)).toEqual([1, 2, 4, 8, 16])
    expect(weekDays.reduce((bits, row) => bits | row.code, 0)).toBe(127)
    expect(relativeDays.map(row => row.code)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(notifyLevels.map(row => row.code)).toEqual([0, 1, 2, 3])
    expect(stepActions.map(row => row.code)).toEqual([1, 2, 3, 4])
  })
  it('encodes step flags as SSMS scripts them: Log to table alone 8, with Append 16, never 24', () => {
    expect(stepFlags).toEqual({ appendOutputFile: 2, includeStepOutputInHistory: 4, logToTable: 8, logToTableAppend: 16 })
    expect(stepFlagMask).toBe(30)
    // Bits Varia does not model survive a save: flags & ~mask.
    expect((32 | 64 | 8) & ~stepFlagMask).toBe(96)
  })
  it('names the step types the AG-0 server listed in syssubsystems, and only those per platform', () => {
    expect(subsystems.map(subsystem => subsystem.id).sort()).toEqual(['ANALYSISCOMMAND', 'ANALYSISQUERY', 'CmdExec', 'Distribution', 'LogReader', 'Merge', 'PowerShell', 'QueueReader', 'SSIS', 'Snapshot', 'TSQL'].sort())
    expect(unique(subsystems.map(subsystem => subsystem.label))).toBe(true)
    for (const platform of agentPlatforms) {
      expect(platformSubsystems[platform]).toContain('TSQL')
      for (const id of platformSubsystems[platform]) expect(subsystems.map(subsystem => subsystem.id), platform).toContain(id)
    }
    for (const id of ['CmdExec', 'PowerShell', 'QueueReader', 'SSIS', 'ANALYSISQUERY', 'ANALYSISCOMMAND', 'Merge']) expect(platformSubsystems.linux).not.toContain(id)
    for (const id of ['CmdExec', 'PowerShell', 'QueueReader', 'Merge', 'ANALYSISQUERY', 'ANALYSISCOMMAND']) expect(platformSubsystems.managedInstance).not.toContain(id)
  })
  it('gates features per platform as Microsoft documents them', () => {
    expect(Object.keys(agentPlatformGates)).toEqual([...agentFeatures])
    expect(agentFeatures.filter(feature => agentGateOpen(feature, 'linux'))).not.toContain('alerts')
    expect(agentFeatures.filter(feature => agentGateOpen(feature, 'managedInstance'))).toEqual(['emailNotifications', 'errorLogs'])
    for (const feature of ['alerts', 'proxies', 'eventLogNotifications', 'serviceControl'] as const) expect(agentGateOpen(feature, 'windows'), feature).toBe(true)
    expect(agentGateOpen('serviceControl', 'linux')).toBe(false)
    expect(agentGateOpen('proxies', 'linux')).toBe(true)
    expect(agentPlatformGates.multiServerTargets.platforms).toEqual([])
    expect([...agentEngineEditions]).toEqual([1, 2, 3, 8])
    expect([agentPlatform(3, false), agentPlatform(2, true), agentPlatform(8, false), agentPlatform(4, false), agentPlatform(5, false), agentPlatform(9, false)])
      .toEqual(['windows', 'linux', 'managedInstance', null, null, null])
  })
  it('decodes msdb\'s dates, times and durations, and refuses what is not one', () => {
    expect(decodeAgentDate(20261118)).toEqual({ year: 2026, month: 11, day: 18 })
    expect(decodeAgentDate(20240229)).toEqual({ year: 2024, month: 2, day: 29 })
    for (const value of [0, null, undefined, -1, 20230229, 20261301, 20261100, 20261131, 18991231, 2026111, 1.5, 100000000]) expect(decodeAgentDate(value), String(value)).toBeNull()
    expect([0, 5, 105, 10_000, 235_959].map(decodeAgentTime)).toEqual([0, 5, 65, 3600, 86_399])
    for (const value of [null, -1, 60, 6_000, 240_000, 1.5, 236_000]) expect(decodeAgentTime(value), String(value)).toBeNull()
    // run_duration's hours run past 99 as more leading digits.
    expect([0, 59, 100, 13_005, 990_000, 1_234_505].map(decodeAgentDuration)).toEqual([0, 59, 60, 5_405, 356_400, 123 * 3600 + 45 * 60 + 5])
    for (const value of [null, -5, 60, 6_000, 1.25]) expect(decodeAgentDuration(value), String(value)).toBeNull()
    expect(decodeAgentDateTime(20261118, 20_000)).toEqual({ year: 2026, month: 11, day: 18, hour: 2, minute: 0, second: 0 })
    expect([decodeAgentDateTime(0, 0), decodeAgentDateTime(20261118, 250_000), decodeAgentDateTime(null, 0)]).toEqual([null, null, null])
    expect(formatAgentDateTime(decodeAgentDateTime(20261118, 142_003)!)).toBe('2026-11-18 14:20:03')
    expect([0, 59, 3661, 123 * 3600 + 45 * 60 + 5, -3, 1.9].map(formatAgentDuration)).toEqual(['00:00:00', '00:00:59', '01:01:01', '123:45:05', '00:00:00', '00:00:01'])
  })
  it('keeps a job save under the 255 calls a THROW state can number, at every cap', () => {
    expect(agentJobSaveCalls).toBeLessThan(agentCallIndexLimit)
    expect(agentLimits.historyJobs + 4).toBeLessThan(agentCallIndexLimit)
    expect(agentLimits.scheduleJobChanges + 4).toBeLessThan(agentCallIndexLimit)
    for (const value of Object.values(agentLimits)) expect(Number.isSafeInteger(value) && value > 0).toBe(true)
    expect(agentLimits).toMatchObject({ nameChars: 128, messageChars: 4_000, serviceWaitMs: 60_000 })
  })
  it('lists each procedure once, reads and writes apart, every argument named and every constant constant', () => {
    const reads = readProcedures.map(procedure => procedure.name), writes = writeProcedures.map(procedure => procedure.name)
    expect(unique(reads)).toBe(true)
    expect(unique(writes)).toBe(true)
    // Database Mail's own procedures end in _sp (sysmail_help_profile_sp).
    for (const name of [...reads, ...writes]) expect(name).toMatch(/^(?:(?:sp|xp)_[a-z_]+|sysmail_[a-z_]+_sp)$/)
    // A read never writes: no msdb procedure is in both lists.
    expect(reads.filter(name => writes.includes(name))).toEqual([])
    for (const procedure of readProcedures) {
      expect(unique(procedure.arguments.map(argument => argument.name)), procedure.name).toBe(true)
      for (const argument of procedure.arguments) {
        expect(argument.name).toMatch(/^@[a-z_]+$/)
        for (const constant of argument.constants ?? []) expect(constant, `${procedure.name} ${argument.name}`).toMatch(/^(N'[A-Z]+'|\d+)$/)
      }
    }
    expect(readProcedures.find(procedure => procedure.name === 'sp_help_jobhistory')?.arguments.find(argument => argument.name === '@mode')?.constants).toEqual(["N'FULL'"])
    expect(readProcedures.find(procedure => procedure.name === 'sp_help_job')?.arguments.find(argument => argument.name === '@job_aspect')?.constants).toEqual(["N'JOB'"])
    // sp_purge_jobhistory without a job purges every job's history on the server: never a read, and only through a template that refuses a NULL job.
    expect(reads).not.toContain('sp_purge_jobhistory')
    // Writes are msdb's only: Start and Stop of the service go through the Service Control Manager (AgentServiceControl), never xp_servicecontrol.
    expect(writeProcedures.every(procedure => procedure.database === 'msdb' && procedure.name !== 'xp_servicecontrol')).toBe(true)
    // AG-2's writes name every argument their template passes; later lanes add theirs.
    expect(writeProcedures.filter(procedure => procedure.lane === 'AG-2').map(procedure => [procedure.name, procedure.arguments])).toEqual([
      ['sp_start_job', ['@job_id', '@step_name']], ['sp_stop_job', ['@job_id']],
      ['sp_update_job', ['@job_id', '@enabled', '@new_name', '@description', '@category_name', '@owner_login_name', '@notify_level_eventlog', '@notify_level_email', '@notify_level_netsend', '@notify_level_page',
        '@notify_email_operator_name', '@notify_netsend_operator_name', '@notify_page_operator_name', '@delete_level', '@start_step_id']],
      ['sp_delete_job', ['@job_id', '@delete_history', '@delete_unused_schedule']]
    ])
    // The job document (AG-6a): New Job's sp_add_job (the id its OUTPUT) and sp_add_jobserver, and the Alerts section's sp_update_alert detach.
    expect(writeProcedures.filter(procedure => procedure.lane === 'AG-6a').map(procedure => [procedure.name, procedure.arguments?.length])).toEqual([['sp_add_job', 14], ['sp_add_jobserver', 1], ['sp_update_alert', 15]])
    // The Steps section (AG-6b): a step's whole content (the proxy by id, or none by an empty name), and the delete by id.
    expect(writeProcedures.filter(procedure => procedure.lane === 'AG-6b').map(procedure => [procedure.name, procedure.arguments?.length])).toEqual([['sp_add_jobstep', 20], ['sp_update_jobstep', 20], ['sp_delete_jobstep', 2]])
    // Alerts and operators (AG-7): every procedure has its arguments, and Send test e-mail's sp_notify_operator names Agent's profile.
    expect(writeProcedures.filter(procedure => procedure.lane === 'AG-7').map(procedure => [procedure.name, procedure.arguments?.length])).toEqual([
      ['sp_add_operator', 12], ['sp_update_operator', 13], ['sp_delete_operator', 2], ['sp_add_alert', 11], ['sp_delete_alert', 1], ['sp_add_notification', 3], ['sp_update_notification', 3],
      ['sp_delete_notification', 2], ['sp_notify_operator', 4]
    ])
    for (const shape of masterReadShapes) {
      expect(shape.shape, shape.name).toMatch(new RegExp(`^EXEC (@rc = )?master\\.dbo\\.${shape.name} `))
      expect(shape.shape.endsWith(';'), shape.name).toBe(true)
    }
    // The service read is QueryState only, with both arguments constant.
    expect(masterReadShapes.find(shape => shape.name === 'xp_servicecontrol')?.shape).toBe("EXEC @rc = master.dbo.xp_servicecontrol N'QueryState', N'SQLServerAgent';")
    expect(unique(agentErrorNumbers.map(error => error.number))).toBe(true)
  })
  it('loads in plain Node 24, as the other catalogues do', () => {
    const files = ['catalog.ts', 'docs.ts'].map(name => join('src', 'shared', 'agent', name))
    for (const file of files) expect(() => stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' }), file).not.toThrow()
    const script = files.map(file => `await import(${JSON.stringify(pathToFileURL(file).href)})`).join(';')
    const result = spawnSync(process.execPath, ['--input-type=module', '--disable-warning=ExperimentalWarning', '-e', script], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})

// Regenerate both after changing the catalogue: npx vitest run tests/agent-catalog.test.ts -u
describe('generated Agent files', () => {
  it('keeps the backend\'s embedded copy in sync', async () => {
    await expect(agentCatalogJson()).toMatchFileSnapshot('../backend/Varia.Backend/Agent/agent-catalog.json')
  })
  it('exports sorted keys, every procedure, gate and limit', () => {
    const json = JSON.parse(agentCatalogJson()) as { version: number; limits: Record<string, number>; readProcedures: { name: string }[]; writeProcedures: { name: string }[]; masterReadShapes: { name: string; shape: string }[]; gates: { feature: string }[] }
    const sorted = (value: unknown, path: string): void => {
      if (Array.isArray(value)) { value.forEach((item, index) => sorted(item, `${path}[${index}]`)); return }
      if (!value || typeof value !== 'object') return
      const keys = Object.keys(value)
      expect(keys, path).toEqual([...keys].sort())
      for (const key of keys) sorted((value as Record<string, unknown>)[key], `${path}.${key}`)
    }
    sorted(json, '$')
    expect(json.version).toBe(1)
    expect(json.limits).toEqual(agentLimits)
    expect(json.readProcedures.map(procedure => procedure.name)).toEqual(readProcedures.map(procedure => procedure.name))
    expect(json.writeProcedures.map(procedure => procedure.name)).toEqual(writeProcedures.map(procedure => procedure.name))
    expect(json.masterReadShapes).toEqual(masterReadShapes.map(({ name, shape }) => ({ name, shape })))
    expect(json.gates.map(gate => gate.feature)).toEqual([...agentFeatures])
  })
  it('keeps the generated part of docs/sql-server-agent.md in sync, below its hand-written part', async () => {
    const current = readFileSync(docsPath, 'utf8')
    const at = current.indexOf(generatedMarker)
    expect(at, 'the marker line').toBeGreaterThan(0)
    expect(current.indexOf(generatedMarker, at + 1)).toBe(-1)
    await expect(current.slice(0, at) + renderAgentDocs()).toMatchFileSnapshot('../docs/sql-server-agent.md')
  })
  it('documents every procedure, gate and limit', () => {
    const docs = renderAgentDocs()
    for (const procedure of readProcedures) expect(docs).toContain('`msdb.dbo.' + procedure.name + '`')
    for (const procedure of writeProcedures) expect(docs).toContain('`' + procedure.database + '.dbo.' + procedure.name + '`')
    for (const shape of masterReadShapes) expect(docs).toContain('`' + shape.shape + '`')
    for (const feature of agentFeatures) expect(docs).toContain(agentPlatformGates[feature].title)
    for (const limit of Object.keys(agentLimits)) expect(docs).toContain('`' + limit + '`')
  })
})
