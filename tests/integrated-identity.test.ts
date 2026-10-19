import { describe, expect, it } from 'vitest'
import type { ApiResult, IntegratedIdentity } from '../src/shared/contracts'
import { IntegratedIdentityLookup } from '../src/renderer/src/services/integrated-identity'

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function fixture(platform = 'linux') {
  const answers: ((result: ApiResult<IntegratedIdentity>) => void)[] = []
  const failures: ((reason: unknown) => void)[] = []
  const shown: (string | undefined)[] = []
  const lookup = new IntegratedIdentityLookup(platform, () => new Promise((resolve, reject) => { answers.push(resolve); failures.push(reject) }), principal => shown.push(principal))
  return { lookup, answers, failures, shown, latest: () => shown.at(-1) }
}

describe('integrated identity lookup', () => {
  it('never asks on Windows, where DOMAIN\\user comes with the connection library', () => {
    const { lookup, answers, shown } = fixture('win32')
    lookup.authenticationChanged('sql')
    lookup.authenticationChanged('windows')
    expect(answers).toHaveLength(0)
    expect(shown).toEqual([])
  })

  it('asks when the dialog opens on SQL Server Authentication, as SSMS reads the identity on open, so saved Windows rows show the principal', async () => {
    const { lookup, answers, latest } = fixture()
    lookup.authenticationChanged('sql')
    // StrictMode replays the open; choosing SQL Server Authentication again asks nothing new either.
    lookup.authenticationChanged('sql')
    expect(answers).toHaveLength(1)
    answers[0]({ ok: true, value: { principal: 'alice@CONTOSO.COM' } })
    await settle()
    expect(latest()).toBe('alice@CONTOSO.COM')
    lookup.authenticationChanged('sql')
    expect(answers).toHaveLength(1)
  })

  it('asks again each time Windows Authentication is chosen, and never shows the last principal while the new answer is pending', async () => {
    const { lookup, answers, latest } = fixture()
    lookup.authenticationChanged('sql')
    answers[0]({ ok: true, value: { principal: 'alice@CONTOSO.COM' } })
    await settle()
    // kdestroy, then Windows Authentication: the pending question shows the OS user name, not alice.
    lookup.authenticationChanged('windows')
    expect(answers).toHaveLength(2)
    expect(latest()).toBeUndefined()
    answers[1]({ ok: true, value: {} })
    await settle()
    expect(latest()).toBeUndefined()
    lookup.authenticationChanged('sql')
    lookup.authenticationChanged('windows')
    expect(answers).toHaveLength(3)
    answers[2]({ ok: true, value: { principal: 'bob@CONTOSO.COM' } })
    await settle()
    expect(latest()).toBe('bob@CONTOSO.COM')
  })

  it('shows only the newest answer, and none after a failure', async () => {
    const { lookup, answers, failures, latest } = fixture()
    lookup.authenticationChanged('windows')
    lookup.authenticationChanged('sql')
    lookup.authenticationChanged('windows')
    answers[1]({ ok: true, value: { principal: 'bob@CONTOSO.COM' } })
    answers[0]({ ok: true, value: { principal: 'alice@CONTOSO.COM' } })
    await settle()
    expect(latest()).toBe('bob@CONTOSO.COM')
    lookup.authenticationChanged('sql')
    lookup.authenticationChanged('windows')
    answers[2]({ ok: false, error: 'The request timed out.', code: 'TIMEOUT' })
    await settle()
    expect(latest()).toBeUndefined()
    lookup.authenticationChanged('sql')
    lookup.authenticationChanged('windows')
    failures[3](new Error('The backend stopped.'))
    await settle()
    expect(latest()).toBeUndefined()
  })
})
