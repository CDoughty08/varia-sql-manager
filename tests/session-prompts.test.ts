import { describe, expect, it } from 'vitest'
import { bigQueryCommitTimeout, needsSessionPrompt, quitStoppingNotes, sessionActions, sessionCloseNoteText, sessionPrompt, sessionPromptLimits, sessionPromptRequestSchema, type SessionAction, type SessionCloseNoteCode, type SessionTab } from '../src/shared/sessions'

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
      const labels = action === 'disconnect' ? expected?.map(answer => answer.replace('and Close=', 'and Disconnect='))
        : action === 'switchLocation' ? expected?.map(answer => answer.replace('and Close=', 'and Switch=').replace('Keep Running=', "Don't Switch=")) : expected
      expect(answers(action, tabs)).toEqual(labels)
      const prompt = sessionPrompt({ action, tabs })
      if (!prompt) return
      // Escape is Cancel (Keep Running). As in SSMS, Enter commits an open transaction (Yes); with an executing query among
      // the tabs it keeps everything as it is, so Enter never cancels a running query.
      expect(prompt.buttons[prompt.cancelId].answer).toBe('cancel')
      expect(prompt.buttons[prompt.defaultId].answer).toBe(prompt.title === 'Uncommitted transactions' && !tabs.some(tab => tab.running) && action !== 'disconnect' ? 'commit' : 'cancel')
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
    expect(sessionPrompt({ action: 'exit', tabs: [open('a.sql'), running('b.sql')] })).toMatchObject({ detail: '• a.sql\n\nYes commits every nesting level; No rolls back.\n\n'
      + 'Still executing:\n• b.sql\nThe executing query is cancelled, and anything it left uncommitted is rolled back.', defaultId: 2, cancelId: 2 })
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
  it('names disconnect rather than close when cancelling executions and explains an unknown outcome', () => {
    const prompt = sessionPrompt({ action: 'disconnect', tabs: [running('report.sql')] })!
    expect(prompt.detail).toContain('disconnect the server')
    expect(prompt.detail).toContain('does not undo work already committed')
    expect(prompt.detail).toContain('outcome may be unknown')
    expect(prompt.buttons[prompt.defaultId].answer).toBe('cancel')
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
  it('gives each provider its own "not checked" causes, and a mixed box both', () => {
    const detail = (tabs: SessionTab[]) => { const prompt = sessionPrompt({ action: 'close', tabs })!; return `${prompt.message} ${prompt.detail}` }
    const bigQuery = detail([{ ...unchecked('b.sql'), provider: 'bigquery' }])
    expect(bigQuery).toContain('For a BigQuery query marked "not checked"')
    expect(bigQuery).not.toContain('SHOWPLAN')
    expect(detail([unchecked('a.sql')])).toContain('SHOWPLAN')
    expect(detail([unchecked('a.sql')])).not.toContain('BigQuery')
    const mixed = detail([unchecked('a.sql'), { ...unchecked('b.sql'), provider: 'bigquery' }])
    expect(mixed).toContain('SHOWPLAN')
    expect(mixed).toContain('For a BigQuery query marked "not checked"')
  })
  it('asks before a BigQuery query switches its session to another location (decision 18)', () => {
    const location = { dataset: 'sales_eu', from: 'US', to: 'EU' }
    const prompt = sessionPrompt({ action: 'switchLocation', tabs: [{ name: 'q.sql', transactions: 0, running: false, provider: 'bigquery' }], location })!
    expect(prompt.title).toBe('Switch this tab to EU?')
    expect(prompt.message).toContain('sales_eu is in EU')
    expect(prompt.message).toContain('q.sql is in US')
    expect(prompt.buttons.map(button => `${button.label}=${button.answer}`)).toEqual(['Switch=proceed', "Don't Switch=cancel"])
    expect(prompt.buttons[prompt.cancelId].answer).toBe('cancel')
    // The request carries the location only for a switch, with one query, which need not have anything open.
    const valid = { action: 'switchLocation', tabs: [{ name: 'q.sql', transactions: 0, running: false, provider: 'bigquery' }], location }
    expect(sessionPromptRequestSchema.parse(valid)).toEqual(valid)
    for (const invalid of [
      { ...valid, action: 'close' }, { ...valid, tabs: [valid.tabs[0], valid.tabs[0]] }, { ...valid, location: { ...location, dataset: 'a;b' } },
      { ...valid, location: { ...location, to: 'x'.repeat(65) } }, { ...valid, location: { ...location, extra: 1 } }, { ...valid, tabs: [{ ...valid.tabs[0], provider: 'oracle' }] },
      { action: 'switchLocation', tabs: valid.tabs }
    ]) expect(sessionPromptRequestSchema.safeParse(invalid).success, JSON.stringify(invalid).slice(0, 120)).toBe(false)
    // provider is accepted on any tab the box asks about.
    expect(sessionPromptRequestSchema.safeParse({ action: 'close', tabs: [{ ...open('a.sql'), provider: 'sqlserver' }] }).success).toBe(true)
  })
  it('words every close note, naming the query, and stops quit for the ones that matter', () => {
    const codes: SessionCloseNoteCode[] = ['commitNotApplied', 'committedBeforeCancel', 'outcomeUnknown', 'abortFailed', 'sessionExpired']
    for (const code of codes) expect(sessionCloseNoteText('q.sql', { code, message: 'Boom', jobId: 'job_1' })).toMatch(/^q\.sql: /)
    expect(sessionCloseNoteText('q.sql', { code: 'commitNotApplied', message: 'Boom' })).toContain('(Boom)')
    expect(sessionCloseNoteText('q.sql', { code: 'outcomeUnknown', jobId: 'job_1' })).toContain('job job_1')
    expect([...quitStoppingNotes].sort()).toEqual(['abortFailed', 'committedBeforeCancel', 'outcomeUnknown'])
    expect(bigQueryCommitTimeout).toContain('could not learn whether the commit took effect')
  })
})
