import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ActivityRequests, activityRequestLimits } from '../src/main/backend/activity-requests'
import { cancellableRequests } from '../src/main/backend/renderer-requests'
import { requestSchemas, validateRequest } from '../src/main/validation'
import { activityCatalogJson, activityLimits, detailsSections, detailsTexts, killOutcomes } from '../src/shared/activity/catalog'
import { activityCancelSchema, loginTimePattern } from '../src/shared/activity/schema'
import { liveErrorCodes } from '../src/shared/live/schema'
import { deadlineFor, methodPolicies } from '../src/shared/ipc/methods'
import { cancelReasons, type CancelReason } from '../src/shared/ipc/wire/protocol'

const details = { requestId: crypto.randomUUID(), connectionId: crypto.randomUUID(), sessionId: 69, loginTime: '2026-10-22T06:50:12.347' }
const kill = { connectionId: crypto.randomUUID(), sessions: [{ sessionId: 69, loginTime: '2026-10-22T06:50:12.347', hostProcessId: 4242 }, { sessionId: 70, loginTime: '2026-10-22T06:50:13', hostProcessId: null }] }

describe('Activity Monitor session actions', () => {
  it('accepts a Details read of one session by id and login time, with one text or with locks', () => {
    for (const patch of [{}, { text: 'statement' }, { text: 'batch' }, { text: 'inputBuffer' }, { locks: true }, { locks: false }, { sessionId: 1 }, { sessionId: activityLimits.sessionId },
      { loginTime: '2026-10-22T06:50:12' }, { loginTime: '2026-10-22T06:50:12.1234567' }]) expect(validateRequest('activity.details', { ...details, ...patch })).toEqual({ ...details, ...patch })
  })
  it('refuses a Details read with a bad id, session id, login time or text, locks with a text, or an unknown member', () => {
    for (const patch of [{ requestId: 'x' }, { connectionId: 'x' }, { sessionId: 0 }, { sessionId: 32_768 }, { sessionId: 1.5 }, { sessionId: '69' }, { loginTime: '2026-10-22 06:50:12' },
      { loginTime: '2026-10-22T06:50:12Z' }, { loginTime: '2026-10-22T06:50:12+02:00' }, { loginTime: '2026-10-22T06:50:12.12345678' }, { loginTime: '' }, { loginTime: '2026-10-22T06:50:12\n' },
      { text: 'plan' }, { text: 'batch', locks: true }, { locks: 'yes' }, { extra: 1 }]) expect(() => validateRequest('activity.details', { ...details, ...patch }), JSON.stringify(patch)).toThrow('Invalid request')
    const { loginTime: _, ...missing } = details
    expect(() => validateRequest('activity.details', missing)).toThrow('Invalid request')
    // The login time stays within the 40-character string bound the backend re-checks.
    expect(loginTimePattern.test('2026-10-22T06:50:12.1234567')).toBe(true)
    expect('2026-10-22T06:50:12.1234567'.length).toBeLessThanOrEqual(40)
  })
  it('accepts a Kill of 1 to 64 distinct sessions, each with the login time and host process id its row showed', () => {
    expect(validateRequest('activity.kill', kill)).toEqual(kill)
    const many = { ...kill, sessions: Array.from({ length: activityLimits.killSessions }, (_, index) => ({ sessionId: index + 1, loginTime: '2026-10-22T06:50:12', hostProcessId: null })) }
    expect(validateRequest('activity.kill', many)).toEqual(many)
  })
  it('refuses a Kill of no sessions, of more than 64, of one session twice, or without a host process id', () => {
    const session = kill.sessions[0]
    for (const sessions of [[], Array.from({ length: 65 }, (_, index) => ({ ...session, sessionId: index + 1 })), [session, { ...session, loginTime: '2026-10-22T06:50:13' }],
      [{ sessionId: 69, loginTime: session.loginTime }], [{ ...session, hostProcessId: '4242' }], [{ ...session, hostProcessId: 2 ** 31 }], [{ ...session, sessionId: 0 }],
      [{ ...session, loginTime: 'yesterday' }], [{ ...session, extra: 1 }], [null]]) expect(() => validateRequest('activity.kill', { ...kill, sessions }), JSON.stringify(sessions).slice(0, 80)).toThrow('Invalid request')
    for (const patch of [{ connectionId: 'x' }, { requestId: crypto.randomUUID() }]) expect(() => validateRequest('activity.kill', { ...kill, ...patch })).toThrow('Invalid request')
  })
  it('runs Details on lane live and Kill on lane actions, each answering its own budget inside its deadline', () => {
    expect(methodPolicies['activity.details']).toEqual({ kind: 'unary', lane: 'live', deadlineMs: 15_000 })
    expect(methodPolicies['activity.kill']).toEqual({ kind: 'unary', lane: 'actions', deadlineMs: 30_000 })
    expect(deadlineFor('activity.details', details)).toEqual({ deadlineMs: 15_000, backstopMs: 20_000 })
    expect(deadlineFor('activity.kill', kill)).toEqual({ deadlineMs: 30_000, backstopMs: 35_000 })
    expect(activityLimits.detailsBudgetMs).toBeLessThan(15_000)
    expect(activityLimits.killBudgetMs).toBeLessThan(30_000)
    expect(Object.keys(requestSchemas)).toEqual(expect.arrayContaining(['activity.details', 'activity.kill']))
  })
  it('routes only Details to varia:activity-cancel: Kill carries no requestId and is never cancelled', () => {
    const channels = { explorer: 'explorer', scripting: 'scripting', actions: 'actions', activity: 'activity', connections: 'connections' }
    expect(cancellableRequests('activity.details', channels)).toBe('activity')
    expect(cancellableRequests('activity.kill', channels)).toBeUndefined()
    const main = readFileSync(join('src', 'main', 'index.ts'), 'utf8')
    expect(main).toContain("handle('varia:activity-cancel', value => ({ cancelled: activityRequests.cancel(activityCancelSchema.parse(value).requestIds) }))")
    const preload = readFileSync(join('src', 'preload', 'index.ts'), 'utf8')
    for (const line of ["activityDetails: params => request('activity.details', params)", "activityKill: params => request('activity.kill', params)",
      "cancelActivity: requestIds => ipcRenderer.invoke('varia:activity-cancel', { requestIds })"]) expect(preload).toContain(line)
  })
  it('turns closing Details into one user CANCEL frame, and remembers a cancel that came first', () => {
    const cancels: [number, number, CancelReason][] = []
    let now = 0
    const requests = new ActivityRequests({ cancel: (generation, id, reason) => { cancels.push([generation, id, reason]) } }, () => now)
    const read = requests.begin('a')
    read.sent(4, 2)
    expect(() => requests.begin('a')).toThrow(expect.objectContaining({ code: 'DUPLICATE_REQUEST', message: 'This Activity Monitor details request is already running.' }))
    expect(requests.cancel(['a'])).toBe(1)
    expect(cancels).toEqual([[2, 4, cancelReasons.user]])
    read.end()
    requests.cancel(['early'])
    expect(() => requests.begin('early')).toThrow(expect.objectContaining({ code: 'CANCELLED' }))
    requests.cancel(['late'])
    now += activityRequestLimits.tombstoneMs + 1
    expect(() => requests.begin('late').end()).not.toThrow()
    expect(activityRequestLimits).toEqual({ tombstones: 64, tombstoneMs: 60_000, running: 32, cancelBatch: 16 })
    for (let index = 0; index < 32; index++) requests.begin(`r${index}`)
    expect(() => requests.begin('one more')).toThrow(expect.objectContaining({ code: 'TOO_MANY_REQUESTS' }))
    expect(activityCancelSchema.safeParse({ requestIds: [crypto.randomUUID()] }).success).toBe(true)
    for (const requestIds of [[], Array.from({ length: 17 }, () => crypto.randomUUID()), ['x']]) expect(activityCancelSchema.safeParse({ requestIds }).success).toBe(false)
  })
  it('declares Details\' sections and Kill\'s outcomes once, for the docs, the answers and the backend', () => {
    expect(detailsSections.map(section => section.id)).toEqual(['session', 'statement', 'batch', 'inputBuffer', 'waits', 'transactions', 'tempdb', 'locks'])
    for (const text of detailsTexts) expect(detailsSections.map(section => section.id)).toContain(text)
    expect(Object.keys(killOutcomes)).toEqual(['killed', 'ended', 'changed', 'own', 'system', 'varia', 'denied', 'failed'])
    const json = JSON.parse(activityCatalogJson())
    expect([json.detailsSections, json.detailsTexts, json.killOutcomes, json.unavailableMessage]).toEqual([detailsSections.map(section => section.id), [...detailsTexts], Object.keys(killOutcomes),
      'Activity Monitor isn\'t available for this kind of server.'])
    // Failure values use the live layer's codes, which the renderer already words.
    for (const code of ['BLOCKED', 'TIMEOUT', 'PERMISSION_DENIED', 'CONNECTION_LOST', 'SQL_ERROR', 'NOT_SUPPORTED', 'AUTH_KERBEROS', 'AUTH_ENTRA', 'LOGIN_FAILED']) expect(liveErrorCodes).toContain(code)
  })
})
