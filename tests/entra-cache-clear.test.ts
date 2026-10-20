import { describe, expect, it, vi } from 'vitest'
import { clearEntraPrompt, clearEntraTokenCache } from '../src/main/entra'
import { BackendError } from '../src/main/backend/errors'
import { CommandService } from '../src/renderer/src/core/commands'
import { helpContribution } from '../src/renderer/src/contributions/help'
import type { VariaApi } from '../src/shared/contracts'

describe('Help › Clear Entra ID Token Cache in main', () => {
  it('asks first, with Clear as the default and Cancel as Escape', () => {
    expect(clearEntraPrompt).toMatchObject({ type: 'question', title: 'Clear Entra ID Token Cache', message: 'Clear the Microsoft Entra ID token cache?', buttons: ['Clear', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true })
  })
  it('clears only after the user confirms, and reports a backend that cannot be reached as a failure', async () => {
    const clear = vi.fn(async () => ({ cleared: true }))
    expect(await clearEntraTokenCache({ confirm: async () => false, clear })).toBe(false)
    expect(clear).not.toHaveBeenCalled()
    expect(await clearEntraTokenCache({ confirm: async () => true, clear })).toBe(true)
    expect(clear).toHaveBeenCalledTimes(1)
    await expect(clearEntraTokenCache({ confirm: async () => true, clear: async () => { throw new BackendError('BACKEND_UNAVAILABLE', 'The SQL backend is restarting.') } })).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
  })
})

describe('Help › Clear Entra ID Token Cache in the workbench', () => {
  function harness(answer: Awaited<ReturnType<VariaApi['clearEntraTokenCache']>>) {
    const commands = new CommandService()
    const api = { clearEntraTokenCache: vi.fn(async () => answer) }
    const contribution = helpContribution({ commands }, api)
    return { commands, api, contribution }
  }
  it('says the cache was cleared, says nothing when the user cancelled, and shows a failure in the command banner', async () => {
    let { commands, api, contribution } = harness({ ok: true, value: true })
    expect(await commands.execute('help.clearEntraTokenCache', undefined, 'menu')).toBe(true)
    expect(api.clearEntraTokenCache).toHaveBeenCalledTimes(1)
    expect(commands.getSnapshot()).toMatchObject({ error: 'Entra ID token cache cleared.', kind: 'warning' })
    contribution.dispose()
    ;({ commands, contribution } = harness({ ok: true, value: false }))
    await commands.execute('help.clearEntraTokenCache', undefined, 'palette')
    expect(commands.getSnapshot().error).toBe('')
    contribution.dispose()
    ;({ commands, contribution } = harness({ ok: false, error: 'The SQL backend is restarting.' }))
    expect(await commands.execute('help.clearEntraTokenCache', undefined, 'menu')).toBe(false)
    expect(commands.getSnapshot()).toMatchObject({ error: expect.stringContaining('The SQL backend is restarting.') })
    expect(commands.getSnapshot().kind).toBeUndefined()
    contribution.dispose()
  })
})
