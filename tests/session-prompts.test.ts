import { describe, expect, it } from 'vitest'
import { needsSessionPrompt, sessionActions, sessionPrompt, sessionPromptLimits, sessionPromptRequestSchema, type SessionAction, type SessionTab } from '../src/shared/sessions'

const open = (name: string, transactions = 1): SessionTab => ({ name, transactions, running: false })
const running = (name: string, transactions = 0): SessionTab => ({ name, transactions, running: true })
const unchecked = (name: string, transactions = 0): SessionTab => ({ name, transactions, running: false, unchecked: true })
const answers = (action: SessionAction, tabs: SessionTab[]) => sessionPrompt({ action, tabs })?.buttons.map(button => `${button.label}=${button.answer}`)
const ssms = ['Yes=commit', 'No=rollback', 'Cancel=cancel']
const executing = (one: boolean) => [one ? 'Cancel Query and Close=proceed' : 'Cancel Queries and Close=proceed', 'Keep Running=cancel']

// What each situation asks, for every action that ends sessions: the buttons and their answers, or nothing to ask.
const matrix: readonly [situation: string, tabs: SessionTab[], expected: string[] | undefined][] = [
  ['nothing open or running', [{ name: 'a.sql', transactions: 0, running: false }], undefined],
  ['one open transaction', [open('a.sql')], ssms],
  ['one nested transaction', [open('a.sql', 3)], ssms],
  ['two open transactions', [open('a.sql'), open('b.sql')], ssms],
  ['one query executing', [running('a.sql')], executing(true)],
  ['two queries executing', [running('a.sql'), running('b.sql')], executing(false)],
  // An executing query is never committed, even with a transaction it opened earlier: only the idle one is asked about.
  ['an executing query with a transaction', [running('a.sql', 1)], executing(true)],
  ['one open and one executing', [open('a.sql'), running('b.sql')], ssms],
  // A session whose transaction could not be read may hold one, so it is asked about as one.
  ['one unchecked session', [unchecked('a.sql')], ssms],
  ['one unchecked and one open', [unchecked('a.sql'), open('b.sql')], ssms]
]

describe('session prompts', () => {
  for (const action of sessionActions) {
    it.each(matrix)(`${action}: %s`, (_situation, tabs, expected) => {
      expect(needsSessionPrompt(tabs)).toBe(expected !== undefined)
      expect(answers(action, tabs)).toEqual(expected)
      const prompt = sessionPrompt({ action, tabs })
      if (!prompt) return
      // Escape is Cancel (Keep Running). As in SSMS, Enter commits an open transaction (Yes); with only executing queries
      // it keeps them running.
      expect(prompt.buttons[prompt.cancelId].answer).toBe('cancel')
      expect(prompt.buttons[prompt.defaultId].answer).toBe(prompt.title === 'Uncommitted transactions' ? 'commit' : 'cancel')
    })
  }
  it('asks SSMS\'s question, naming the queries and what is about to happen', () => {
    expect(sessionPrompt({ action: 'close', tabs: [open('Orders.sql')] })).toEqual({
      title: 'Uncommitted transactions', message: 'There are uncommitted transactions. Do you wish to commit these transactions before closing the window?',
      detail: '• Orders.sql\n\nYes commits every nesting level; No rolls back.',
      buttons: [{ label: 'Yes', answer: 'commit' }, { label: 'No', answer: 'rollback' }, { label: 'Cancel', answer: 'cancel' }], defaultId: 0, cancelId: 2
    })
    expect(sessionPrompt({ action: 'changeConnection', tabs: [open('Orders.sql', 2)] })).toMatchObject({
      message: 'There are uncommitted transactions. Do you wish to commit these transactions before changing the connection?', detail: '• Orders.sql (2 nested levels)\n\nYes commits every nesting level; No rolls back.'
    })
    expect(sessionPrompt({ action: 'disconnectQuery', tabs: [open('Orders.sql')] })?.message).toBe('There are uncommitted transactions. Do you wish to commit these transactions before disconnecting?')
    expect(sessionPrompt({ action: 'closeAll', tabs: [open('a.sql'), open('b.sql')] })).toMatchObject({
      message: 'There are uncommitted transactions in 2 queries. Do you wish to commit these transactions before closing the windows?', detail: '• a.sql\n• b.sql\n\nYes commits every nesting level; No rolls back.'
    })
    const notChecked = 'A query marked "not checked" could not be checked: SET SHOWPLAN, NOEXEC, PARSEONLY or FMTONLY may be ON in its session, or it did not answer.'
    expect(sessionPrompt({ action: 'close', tabs: [unchecked('Orders.sql')] })).toMatchObject({
      message: 'There may be uncommitted transactions. Do you wish to commit these transactions before closing the window?',
      detail: `• Orders.sql (not checked)\n\n${notChecked}\n\nYes commits every nesting level; No rolls back.`
    })
    expect(sessionPrompt({ action: 'exit', tabs: [unchecked('a.sql'), open('b.sql', 2)] })).toMatchObject({
      message: 'There may be uncommitted transactions in 2 queries. Do you wish to commit these transactions before closing Varia SQL Manager?',
      detail: `• a.sql (not checked)\n• b.sql (2 nested levels)\n\n${notChecked}\n\nYes commits every nesting level; No rolls back.`
    })
    expect(sessionPrompt({ action: 'disconnect', tabs: [open('a.sql'), open('b.sql', 2)] })?.message).toBe('There are uncommitted transactions in 2 queries. Do you wish to commit these transactions before disconnecting the server?')
    expect(sessionPrompt({ action: 'exit', tabs: [open('a.sql'), running('b.sql')] })?.detail).toBe('• a.sql\n\nYes commits every nesting level; No rolls back.\n\n'
      + 'Still executing:\n• b.sql\nThe executing query is cancelled, and anything it left uncommitted is rolled back.')
    expect(sessionPrompt({ action: 'close', tabs: [running('a.sql')] })).toMatchObject({
      title: 'Query executing', message: 'a.sql is still executing.', detail: 'Cancel it and close the query? Anything it left uncommitted is rolled back.', defaultId: 1, cancelId: 1
    })
    expect(sessionPrompt({ action: 'exit', tabs: [running('a.sql'), running('b.sql')] })).toMatchObject({
      message: '2 queries are still executing.', detail: '• a.sql\n• b.sql\n\nCancel them and close Varia SQL Manager? Anything they left uncommitted is rolled back.'
    })
  })
  it('lists ten queries of each kind and counts the rest', () => {
    const tabs = Array.from({ length: 13 }, (_, index) => open(`q${index + 1}.sql`))
    const detail = sessionPrompt({ action: 'exit', tabs })!.detail
    expect(detail.split('\n').filter(line => line.startsWith('• '))).toHaveLength(sessionPromptLimits.listed)
    expect(detail).toContain('• q10.sql\n… and 3 more\n\nYes commits every nesting level')
  })
  it('accepts only bounded facts about queries that need asking', () => {
    const valid = { action: 'close', tabs: [open('a.sql')] }
    expect(sessionPromptRequestSchema.parse(valid)).toEqual(valid)
    expect(sessionPromptRequestSchema.parse({ ...valid, tabs: [unchecked('a.sql')] })).toEqual({ ...valid, tabs: [unchecked('a.sql')] })
    for (const invalid of [
      { ...valid, action: 'save' }, { ...valid, tabs: [] }, { ...valid, tabs: [{ name: 'a.sql', transactions: 0, running: false }] },
      { ...valid, tabs: [open('x'.repeat(sessionPromptLimits.name + 1))] }, { ...valid, tabs: [{ ...open('a.sql'), transactions: -1 }] },
      { ...valid, tabs: [{ ...open('a.sql'), transactions: 1.5 }] }, { ...valid, tabs: [{ ...open('a.sql'), extra: true }] }, { ...valid, extra: true },
      { ...valid, tabs: [{ ...unchecked('a.sql'), unchecked: false }] },
      { ...valid, tabs: Array.from({ length: sessionPromptLimits.tabs + 1 }, () => open('a.sql')) }
    ]) expect(sessionPromptRequestSchema.safeParse(invalid).success, JSON.stringify(invalid).slice(0, 120)).toBe(false)
  })
})
