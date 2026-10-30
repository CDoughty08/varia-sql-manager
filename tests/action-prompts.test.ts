import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { actionMessageBox, actionPromptAnswer, confirmActionBox, noLongRuns, parseLongRuns, reloadDetail } from '../src/main/action-prompts'
import { actionPromptRequestSchema, promptLimits, type ActionPromptRequest } from '../src/shared/actions/prompts'
import { longRunKinds, longRunLimits, longRunMessages, longRunStateSchema, longRunSubjects } from '../src/shared/long-runs'

const rename = (facts: Partial<Extract<ActionPromptRequest, { prompt: 'renameDatabase' }>['facts']> = {}): ActionPromptRequest =>
  ({ prompt: 'renameDatabase', facts: { database: 'Sales', sessions: 3, transactions: 0, tabs: 2, tabsWithTransactions: [], canClose: true, ...facts } })
const disable = (facts: Partial<Extract<ActionPromptRequest, { prompt: 'disableLogin' }>['facts']> = {}): ActionPromptRequest =>
  ({ prompt: 'disableLogin', facts: { login: 'app_user', sysadmin: false, ...facts } })

describe('object action prompts (varia:confirm-action)', () => {
  it('words Rename Database\'s prompt from the facts, with closing the connections the default where Varia may close them', () => {
    const box = confirmActionBox(rename())
    expect(box).toEqual({
      title: 'Rename Database', message: '3 connections are using Sales (2 query windows in Varia). Close them and rename the database?',
      detail: 'Rename When Free waits until they disconnect; Stop in the status bar ends the wait.',
      buttons: ['Close Connections and Rename', 'Rename When Free', 'Cancel'], answers: ['closeAndRename', 'renameWhenFree', 'cancel'], defaultId: 0, cancelId: 2
    })
    const busy = confirmActionBox(rename({ sessions: 1, tabs: 0, transactions: 2, tabsWithTransactions: ['Query1.sql', 'Load.sql'], canClose: false }))
    expect(busy.message).toBe('1 connection is using Sales. Close them and rename the database?')
    expect(busy.detail.split('\n\n')).toEqual([
      '2 sessions have open transactions, which closing rolls back.', "Varia's query windows with open transactions: Query1.sql, Load.sql.",
      'This server does not let Varia close them.', 'Rename When Free waits until they disconnect; Stop in the status bar ends the wait.'
    ])
    expect(busy).toMatchObject({ buttons: ['Rename When Free', 'Cancel'], defaultId: 0, cancelId: 1 })
    expect(confirmActionBox(rename({ sessions: undefined })).message).toBe('Other connections may be using Sales. Close them and rename the database?')
  })
  it('words Disable Login\'s prompt, with Cancel the default for a login a service runs as', () => {
    expect(confirmActionBox(disable())).toEqual({
      title: 'Disable Login', message: 'Disable the login app_user?', detail: 'New connections will be refused.',
      buttons: ['Disable', 'Cancel'], answers: ['disable', 'cancel'], defaultId: 0, cancelId: 1
    })
    const service = confirmActionBox(disable({ sessions: 4, service: 'SQL Server Agent (MSSQLSERVER)', sysadmin: true }))
    expect(service.detail.split('\n\n')).toEqual([
      'New connections will be refused. 4 sessions connected as this login stay connected until they end; Activity Monitor can end them.',
      'SQL Server Agent (MSSQLSERVER) runs as this account, and cannot connect while it is disabled.', 'This login is a member of sysadmin.'
    ])
    expect(service.defaultId).toBe(1)
  })
  it('shows names through displayText, so a name cannot add lines or hide characters in the box', () => {
    const box = confirmActionBox(disable({ login: 'evil\nDisable everything?‮' }))
    expect(box.message).not.toContain('\n')
    expect(box.message).not.toContain('‮')
  })
  it('answers with the button chosen, and the cancel answer for Escape, a closed box or a page that went away', () => {
    const box = confirmActionBox(rename())
    expect([0, 1, 2, -1, 7].map(response => actionPromptAnswer(box, response))).toEqual(['closeAndRename', 'renameWhenFree', 'cancel', 'cancel', 'cancel'])
    const signal = new AbortController().signal
    expect(actionMessageBox(box, signal)).toEqual({ type: 'warning', title: 'Rename Database', message: box.message, detail: box.detail, buttons: box.buttons, defaultId: 0, cancelId: 2, noLink: true, signal })
  })
  it('refuses facts past their bounds, unknown members and unknown prompts', () => {
    const long = 'x'.repeat(promptLimits.name + 1)
    for (const value of [
      rename({ database: long }), rename({ database: '' }), rename({ sessions: -1 }), rename({ sessions: promptLimits.count + 1 }), rename({ transactions: 1.5 }),
      rename({ tabsWithTransactions: Array.from({ length: promptLimits.tabs + 1 }, (_, index) => `Query${index}.sql`) }), rename({ tabsWithTransactions: ['x'.repeat(promptLimits.tabName + 1)] }),
      disable({ login: long }), disable({ service: 'x'.repeat(promptLimits.service + 1) }),
      { ...rename(), extra: 1 }, { prompt: 'renameDatabase', facts: { ...rename().facts, message: 'Delete?' } }, { prompt: 'dropDatabase', facts: {} }, undefined, 'renameDatabase'
    ]) {
      expect(actionPromptRequestSchema.safeParse(value).success, JSON.stringify(value)?.slice(0, 80)).toBe(false)
      expect(() => confirmActionBox(value)).toThrow()
    }
    expect(actionPromptRequestSchema.safeParse(rename({ database: 'x'.repeat(promptLimits.name), sessions: promptLimits.count })).success).toBe(true)
  })
  it('runs only for a trusted sender, as the page\'s abortable box, and answers the cancel answer when the page goes away', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    const handler = main.slice(main.indexOf("handle('varia:confirm-action'"), main.indexOf("handle('varia:long-runs'"))
    // handle() checks trusted(event) before the action runs.
    expect(handler).toContain('const box = confirmActionBox(value)')
    expect(handler).toContain('pageDialog((window, signal) => dialog.showMessageBox(window, actionMessageBox(box, signal)), { response: box.cancelId, checkboxChecked: false }, true)')
    expect(handler).toContain('return actionPromptAnswer(box, response)')
    expect(main.match(/varia:confirm-action/g)).toHaveLength(1)
    expect(readFileSync('src/preload/index.ts', 'utf8')).toContain("confirmAction: request => ipcRenderer.invoke('varia:confirm-action', request),")
  })
})

describe('long runs in main (varia:long-runs)', () => {
  const restore = { kind: 'restore', server: 'sql-prod-01' } as const
  it('names every kind of run', () => {
    expect(Object.keys(longRunSubjects)).toEqual([...longRunKinds])
    expect(longRunMessages.close(restore)).toBe('A restore is running on sql-prod-01, and closing the window would stop it part way. Stop it, or wait for it to finish, then close the window.')
    expect(longRunMessages.stop(restore)).toBe('A restore is running on sql-prod-01. Stop it first.')
    expect(longRunMessages.stop({ kind: 'createCatalog', server: 'a\nb' })).toBe('Create Catalog is running on a⟨U+000A⟩b. Stop it first.')
  })
  it('puts the runs first in the reload prompt\'s detail, then what AutoRecover keeps', () => {
    expect(reloadDetail(noLongRuns, 'Unsaved queries are kept.')).toBe('Unsaved queries are kept.')
    expect(reloadDetail({ runs: [restore], total: 1 }, 'Unsaved queries are kept.')).toBe('A restore is running on sql-prod-01: reloading stops it part way.\n\nUnsaved queries are kept.')
    expect(reloadDetail({ runs: [restore, { kind: 'backup', server: 'b' }], total: 2 }, '')).toBe('A restore is running on sql-prod-01, with 1 more run: reloading stops them part way.')
    expect(reloadDetail({ runs: [restore], total: 40 }, '')).toBe('A restore is running on sql-prod-01, with 39 more runs: reloading stops them part way.')
  })
  it('accepts only bounded, well-formed states', () => {
    expect(parseLongRuns({ runs: [restore], total: 1 })).toEqual({ runs: [restore], total: 1 })
    const many = Array.from({ length: longRunLimits.runs + 1 }, () => restore)
    for (const value of [
      { runs: many, total: many.length }, { runs: [restore], total: 0 }, { runs: [{ ...restore, server: 'x'.repeat(longRunLimits.server + 1) }], total: 1 },
      { runs: [{ ...restore, server: '' }], total: 1 }, { runs: [{ kind: 'dropDatabase', server: 'a' }], total: 1 }, { runs: [{ ...restore, detail: 'x' }], total: 1 },
      { runs: [], total: 0, extra: true }, { runs: [], total: -1 }, { runs: [], total: 1.5 }, undefined, []
    ]) expect(longRunStateSchema.safeParse(value).success, JSON.stringify(value)?.slice(0, 80)).toBe(false)
  })
  it('names the current page\'s runs in its reload prompt and forgets them when the page resets', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    expect(main).toContain("handle('varia:long-runs', value => { longRuns = parseLongRuns(value) })")
    expect(main).toContain('detail: reloadDetail(longRuns, lossDetailsFor(pageGeneration).reload)')
    const reset = main.slice(main.indexOf('function resetRendererState('), main.indexOf('function resetRendererState(') + 2000)
    expect(reset).toContain('longRuns = noLongRuns')
    expect(readFileSync('src/preload/index.ts', 'utf8')).toContain("setLongRuns: state => ipcRenderer.invoke('varia:long-runs', state),")
  })
})
