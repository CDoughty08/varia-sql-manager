import { z } from 'zod'

/**
 * What ends query sessions, and so asks first about their open transactions and running queries: closing a query (or
 * several), moving it to another server or to Disconnected, disconnecting a server or every query, and closing the window
 * or quitting.
 */
export const sessionActions = ['close', 'closeAll', 'changeConnection', 'disconnect', 'disconnectAll', 'exit'] as const
export type SessionAction = typeof sessionActions[number]
/** A query whose session ends: its last known open-transaction count (@@TRANCOUNT after its last execution), and whether
 *  a query is still executing in it. Only queries with one or the other are sent. */
export interface SessionTab { readonly name: string; readonly transactions: number; readonly running: boolean }
export interface SessionPromptRequest { readonly action: SessionAction; readonly tabs: readonly SessionTab[] }
/** `commit` and `rollback` end the listed transactions that way; `proceed` cancels the executing queries (the prompt had
 *  no transactions to ask about); `cancel` keeps everything as it is. */
export type SessionAnswer = 'commit' | 'rollback' | 'proceed' | 'cancel'
/** How a session ends when its query closes: its transaction committed or rolled back first. */
export type SessionEnd = 'commit' | 'rollback'
export interface SessionPrompt {
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly buttons: readonly { readonly label: string; readonly answer: SessionAnswer }[]
  readonly defaultId: number
  readonly cancelId: number
}

/** At most this many queries per prompt; the dialog names the first `listed` of each kind and counts the rest. */
export const sessionPromptLimits = { tabs: 1024, name: 512, listed: 10 } as const
const tabSchema = z.object({ name: z.string().min(1).max(sessionPromptLimits.name), transactions: z.number().int().min(0).max(2 ** 31 - 1), running: z.boolean() }).strict()
  .refine(tab => tab.running || tab.transactions > 0, 'Only queries with an open transaction or a running query are asked about.')
/** varia:confirm-sessions, from the renderer: main composes the dialog's text itself. */
export const sessionPromptRequestSchema = z.object({ action: z.enum(sessionActions), tabs: z.array(tabSchema).min(1).max(sessionPromptLimits.tabs) }).strict()

/** Whether ending these sessions needs the user's answer first. */
export const needsSessionPrompt = (tabs: readonly SessionTab[]): boolean => tabs.some(tab => tab.running || tab.transactions > 0)

// What happens, as the end of "… before <phrase>": one query, or several.
const phrases: Readonly<Record<SessionAction, readonly [one: string, many: string]>> = {
  close: ['the query closes', 'the queries close'],
  closeAll: ['the query closes', 'the queries close'],
  changeConnection: ['the query changes connection', 'the queries change connection'],
  disconnect: ['the server disconnects', 'the server disconnects'],
  disconnectAll: ['the query disconnects', 'the queries disconnect'],
  exit: ['Varia SQL Manager closes', 'Varia SQL Manager closes']
}
const closes = (action: SessionAction) => action === 'exit' ? 'Varia SQL Manager' : 'the query'

function listed(tabs: readonly SessionTab[], note: (tab: SessionTab) => string): string {
  const shown = tabs.slice(0, sessionPromptLimits.listed).map(tab => `• ${tab.name}${note(tab)}`)
  if (tabs.length > shown.length) shown.push(`… and ${tabs.length - shown.length} more`)
  return shown.join('\n')
}
const nested = (tab: SessionTab) => tab.transactions > 1 ? ` (${tab.transactions} nested levels)` : ''
const queries = (count: number) => count === 1 ? '1 query' : `${count} queries`

/**
 * The prompt for ending these sessions, or undefined when nothing needs asking. Open transactions ask Commit, Roll Back,
 * or Cancel (one decision for every listed query when there are several, as SSMS asks once on exit). A query still
 * executing is cancelled, never committed: what it left uncommitted rolls back when its session closes, so a query that
 * is only executing asks to cancel it or keep it running. Cancel is the default and the Escape answer, so Enter alone
 * never commits or discards work.
 */
export function sessionPrompt({ action, tabs }: SessionPromptRequest): SessionPrompt | undefined {
  const open = tabs.filter(tab => !tab.running && tab.transactions > 0), running = tabs.filter(tab => tab.running)
  if (!open.length && !running.length) return undefined
  const runningNote = running.length === 1 ? 'The executing query is cancelled, and anything it left uncommitted is rolled back.'
    : running.length ? 'The executing queries are cancelled, and anything they left uncommitted is rolled back.' : ''
  if (open.length) {
    const one = open.length === 1, phrase = phrases[action][one ? 0 : 1]
    const message = one ? `${open[0].name} has an uncommitted transaction.` : `${open.length} queries have uncommitted transactions.`
    const detail = [
      one ? (open[0].transactions > 1 ? `Its transaction is nested ${open[0].transactions} levels deep; Commit commits every level. ` : '') + `Commit it before ${phrase}, or roll it back.`
        : `${listed(open, nested)}\n\nCommit them before ${phrase}, or roll them all back.`,
      running.length ? `Still executing:\n${listed(running, () => '')}\n${runningNote}` : ''
    ].filter(Boolean).join('\n\n')
    return {
      title: 'Uncommitted transactions', message, detail, defaultId: 2, cancelId: 2,
      buttons: [{ label: one ? 'Commit' : 'Commit All', answer: 'commit' }, { label: one ? 'Roll Back' : 'Roll Back All', answer: 'rollback' }, { label: 'Cancel', answer: 'cancel' }]
    }
  }
  const one = running.length === 1
  return {
    title: 'Query executing',
    message: one ? `${running[0].name} is still executing.` : `${queries(running.length)} are still executing.`,
    detail: [one ? '' : listed(running, () => ''), `Cancel ${one ? 'it' : 'them'} and close ${closes(action)}? Anything ${one ? 'it' : 'they'} left uncommitted is rolled back.`].filter(Boolean).join('\n\n'),
    defaultId: 1, cancelId: 1,
    buttons: [{ label: one ? 'Cancel Query and Close' : 'Cancel Queries and Close', answer: 'proceed' }, { label: 'Keep Running', answer: 'cancel' }]
  }
}
