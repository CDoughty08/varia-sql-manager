import { describe, expect, it } from 'vitest'
import { agentJobIdFromHex, agentJobText, parseAgentProgram } from '../src/shared/activity/agent-program'
import { detailsText, jobUnavailable, sessionFromRow, sessionJob } from '../src/renderer/src/activity/session-actions'
import type { ActivityDetailsResult } from '../src/shared/activity/schema'

// The job id 8A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9 as SQL Server stores it: the first three groups little-endian.
const stored = '3D2C1B8A5F4E7160' + '8293A4B5C6D7E8F9'
const jobId = '8A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9'

describe('SQL Server Agent program names', () => {
  it('reads a job step\'s job id in SQL Server\'s byte order and its step', () => {
    expect(agentJobIdFromHex(stored)).toBe(jobId)
    expect(agentJobIdFromHex(stored.toLowerCase())).toBe(jobId)
    expect(parseAgentProgram(`SQLAgent - TSQL JobStep (Job 0x${stored} : Step 2)`)).toEqual({ kind: 'jobStep', task: 'TSQL JobStep', jobId, step: 2 })
    // Other subsystems' steps and lower-case hex read the same way.
    expect(parseAgentProgram(`SQLAgent - CmdExec JobStep (Job 0x${stored.toLowerCase()} : Step 14)`)).toEqual({ kind: 'jobStep', task: 'CmdExec JobStep', jobId, step: 14 })
    expect(parseAgentProgram(`SQLAgent - PowerShell JobStep (Job 0x${stored} : Step 999999999)`)).toMatchObject({ step: 999_999_999 })
  })
  it('knows Agent\'s own threads, which run no job', () => {
    for (const task of ['Generic Refresher', 'Email Logger', 'Job invocation engine', 'Alert Engine', 'Schedule Saver'])
      expect(parseAgentProgram(`SQLAgent - ${task}`)).toEqual({ kind: 'agent', task })
  })
  it('refuses malformed names and every other program', () => {
    const bad = [
      undefined, null, '', 'Microsoft SQL Server Management Studio', 'SQLAgent', 'SQLAgent - ', 'sqlagent - TSQL JobStep',
      `SQLAgent - TSQL JobStep (Job 0x${stored.slice(2)} : Step 2)`, `SQLAgent - TSQL JobStep (Job 0x${stored}00 : Step 2)`,
      `SQLAgent - TSQL JobStep (Job 0x${stored.slice(0, 31)}G : Step 2)`, `SQLAgent - TSQL JobStep (Job 0x${stored} : Step 0)`,
      `SQLAgent - TSQL JobStep (Job 0x${stored} : Step 2147483648)`, `SQLAgent - TSQL JobStep (Job 0x${stored} : Step 2`,
      `SQLAgent - TSQL JobStep (Job 0x${stored} : Step 2) `, `SQLAgent - TSQL JobStep (Job 0x${stored} : Step 2)\n`,`SQLAgent - TSQL JobStep (Job ${stored} : Step 2)`, `SQLAgent - (Job 0x${stored} : Step 2)`,
      `SQLAgent - TSQL JobStep (Job 0x${stored} : Step -1)`, `SQLAgent - Odd (thread)`, `SQLAgent - ${'x'.repeat(120)}`
    ]
    for (const program of bad) expect(parseAgentProgram(program), String(program)).toBeUndefined()
    expect(parseAgentProgram(42 as unknown as string)).toBeUndefined()
    expect(agentJobIdFromHex('xyz')).toBeUndefined()
  })
  it('words a job link with its names, or the decoded id where msdb named none', () => {
    expect(agentJobText({ jobId, step: 2, name: 'Nightly', stepName: 'Load' })).toBe('Nightly, step 2 (Load)')
    expect(agentJobText({ jobId, step: 2, name: 'Nightly' })).toBe('Nightly, step 2')
    expect(agentJobText({ jobId, step: 2, name: null, stepName: 'Load' })).toBe(`Job ${jobId}, step 2`)
  })
})

describe('session rows that run a job step', () => {
  const program = `SQLAgent - TSQL JobStep (Job 0x${stored} : Step 2)`
  const cells = { sessionId: '61', loginTime: '2026-11-09 08:00:00.000', hostProcessId: '4100', login: 'NT SERVICE\\SQLSERVERAGENT', hostName: 'DB-01', openTransactions: '0', varia: null, application: program, job: 'Nightly, step 2 (Load)', jobName: 'Nightly' }
  it('carries the job, its link words and name for Open Job and Stop Job', () => {
    expect(sessionFromRow('sessions', cells)?.job).toEqual({ jobId, step: 2, text: 'Nightly, step 2 (Load)', name: 'Nightly' })
    expect(jobUnavailable(sessionFromRow('sessions', cells), 'open')).toBeUndefined()
    // Without msdb's names the row still shows the decoded id and step, and Open Job says why it cannot.
    const unnamed = sessionFromRow('sessions', { ...cells, job: `Job ${jobId}, step 2`, jobName: null })
    expect(unnamed?.job).toEqual({ jobId, step: 2, text: `Job ${jobId}, step 2` })
    expect(jobUnavailable(unnamed, 'stop')).toContain('msdb did not name')
    expect(sessionFromRow('sessions', { ...cells, application: 'SSMS' })?.job).toBeUndefined()
    expect(jobUnavailable(sessionFromRow('sessions', { ...cells, application: 'SSMS' }), 'open')).toContain('Select a session')
    expect(sessionJob(program, undefined, undefined)).toEqual({ jobId, step: 2, text: `Job ${jobId}, step 2` })
  })
  it('copies the job with Details', () => {
    const job = sessionJob(program, 'Nightly, step 2 (Load)', 'Nightly')
    const result = { sessionId: 61, state: 'present' as const, elapsedMs: 1, session: { sessionId: 61, loginTime: '2026-11-09T08:00:00.000', isUserProcess: true, application: program } as ActivityDetailsResult['session'] }
    expect(detailsText(result, job)).toContain('Job: Nightly, step 2 (Load)')
    // A row whose job no longer matches the session's program is not trusted.
    expect(detailsText(result, { ...job!, step: 3 })).toContain(`Job: Job ${jobId}, step 2`)  })
})
