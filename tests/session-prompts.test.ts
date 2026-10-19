import { describe, expect, it } from 'vitest'
import { needsSessionPrompt, sessionActions, sessionPrompt, sessionPromptLimits, sessionPromptRequestSchema, type SessionAction, type SessionTab } from '../src/shared/sessions'

const open = (name: string, transactions = 1): SessionTab => ({ name, transactions, running: false })
const running = (name: string, transactions = 0): SessionTab => ({ name, transactions, running: true })
const unchecked = (name: string, transactions = 0): SessionTab => ({ name, transactions, running: false, unchecked: true })
const answers = (action: SessionAction, tabs: SessionTab[]) => sessionPrompt({ action, tabs })?.buttons.map(button => `${button.label}=${button.answer}`)

// What each situation asks, for every action that ends sessions: the buttons and their answers, or nothing to ask.
const matrix: readonly [situation: string, tabs: SessionTab[], expected: string[] | undefined][] = [
  ['nothing open or running', [{ name: 'a.sql', transactions: 0, running: false }], undefined],
  ['one open transaction', [open('a.sql')], ['Commit=commit', 'Roll Back=rollback', 'Cancel=cancel']],
  ['one nested transaction', [open('a.sql', 3)], ['Commit=commit', 'Roll Back=rollback', 'Cancel=cancel']],
  ['two open transactions', [open('a.sql'), open('b.sql')], ['Commit All=commit', 'Roll Back All=rollback', 'Cancel=cancel']],
  ['one query executing', [running('a.sql')], ['Cancel Query and Close=proceed', 'Keep Running=cancel']],
  ['two queries executing', [running('a.sql'), running('b.sql')], ['Cancel Queries and Close=proceed', 'Keep Running=cancel']],
  // An executing query is never committed, even with a transaction it opened earlier: only the idle one is asked about.
  ['an executing query with a transaction', [running('a.sql', 1)], ['Cancel Query and Close=proceed', 'Keep Running=cancel']],
  ['one open and one executing', [open('a.sql'), running('b.sql')], ['Commit=commit', 'Roll Back=rollback', 'Cancel=cancel']],
  // A session whose last execution could not be checked may hold a transaction, so it is asked about as one.
  ['one unchecked session', [unchecked('a.sql')], ['Commit=commit', 'Roll Back=rollback', 'Cancel=cancel']],
  ['one unchecked and one open', [unchecked('a.sql'), open('b.sql')], ['Commit All=commit', 'Roll Back All=rollback', 'Cancel=cancel']]
]

describe('session prompts', () => {
  for (const action of sessionActions) {
    it.each(matrix)(`${action}: %s`, (_situation, tabs, expected) => {
      expect(needsSessionPrompt(tabs)).toBe(expected !== undefined)
      expect(answers(action, tabs)).toEqual(expected)
      const prompt = sessionPrompt({ action, tabs })
      if (!prompt) return
      // Cancel (Keep Running) is the default and the Escape answer, so Enter alone never commits or discards work.
      expect(prompt.defaultId).toBe(prompt.cancelId)
      expect(prompt.buttons[prompt.cancelId].answer).toBe('cancel')
    })
  }
  it('names the query, the nesting, and what is about to happen', () => {
    expect(sessionPrompt({ action: 'close', tabs: [open('Orders.sql')] })).toMatchObject({
      title: 'Uncommitted transactions', message: 'Orders.sql has an uncommitted transaction.', detail: 'Commit it before the query closes, or roll it back.'
    })
    expect(sessionPrompt({ action: 'changeConnection', tabs: [open('Orders.sql', 2)] })?.detail).toBe('Its transaction is nested 2 levels deep; Commit commits every level. Commit it before the query changes connection, or roll it back.')
    expect(sessionPrompt({ action: 'disconnectQuery', tabs: [open('Orders.sql')] })?.detail).toBe('Commit it before the query disconnects, or roll it back.')
    expect(sessionPrompt({ action: 'disconnectQuery', tabs: [open('a.sql'), open('b.sql')] })?.detail).toBe('• a.sql\n• b.sql\n\nCommit them before the queries disconnect, or roll them all back.')
    expect(sessionPrompt({ action: 'close', tabs: [unchecked('Orders.sql', 2)] })).toMatchObject({
      message: 'Orders.sql may have an uncommitted transaction.',
      detail: 'Its last execution could not check for one (SET SHOWPLAN, NOEXEC, PARSEONLY or FMTONLY may be ON). Commit it before the query closes, or roll it back.'
    })
    expect(sessionPrompt({ action: 'exit', tabs: [unchecked('a.sql'), open('b.sql', 2)] })).toMatchObject({
      message: '2 queries may have uncommitted transactions.', detail: '• a.sql (not checked)\n• b.sql (2 nested levels)\n\nCommit them before Varia SQL Manager closes, or roll them all back.'
    })
    expect(sessionPrompt({ action: 'disconnect', tabs: [open('a.sql'), open('b.sql', 2)] })).toMatchObject({
      message: '2 queries have uncommitted transactions.', detail: '• a.sql\n• b.sql (2 nested levels)\n\nCommit them before the server disconnects, or roll them all back.'
    })
    expect(sessionPrompt({ action: 'exit', tabs: [open('a.sql'), running('b.sql')] })?.detail).toBe('Commit it before Varia SQL Manager closes, or roll it back.\n\n'
      + 'Still executing:\n• b.sql\nThe executing query is cancelled, and anything it left uncommitted is rolled back.')
    expect(sessionPrompt({ action: 'close', tabs: [running('a.sql')] })).toMatchObject({
      title: 'Query executing', message: 'a.sql is still executing.', detail: 'Cancel it and close the query? Anything it left uncommitted is rolled back.'
    })
    expect(sessionPrompt({ action: 'exit', tabs: [running('a.sql'), running('b.sql')] })).toMatchObject({
      message: '2 queries are still executing.', detail: '• a.sql\n• b.sql\n\nCancel them and close Varia SQL Manager? Anything they left uncommitted is rolled back.'
    })
  })
  it('lists ten queries of each kind and counts the rest', () => {
    const tabs = Array.from({ length: 13 }, (_, index) => open(`q${index + 1}.sql`))
    const detail = sessionPrompt({ action: 'exit', tabs })!.detail
    expect(detail.split('\n').filter(line => line.startsWith('• '))).toHaveLength(sessionPromptLimits.listed)
    expect(detail).toContain('• q10.sql\n… and 3 more\n\nCommit them before Varia SQL Manager closes')
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
