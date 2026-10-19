import { z } from 'zod'

/**
 * What ends query sessions, and so asks first about their open transactions and running queries: closing a query (or
 * several), moving it to another server, disconnecting it (Disconnect, or Change Connection to Disconnected), disconnecting
 * a server or every query, and closing the window or quitting.
 */
export const sessionActions = ['close', 'closeAll', 'changeConnection', 'disconnectQuery', 'disconnect', 'disconnectAll', 'exit'] as const
export type SessionAction = typeof sessionActions[number]
/** A query whose session ends: its open-transaction count (@@TRANCOUNT, read from its idle session just before the
 *  prompt), whether that read could not tell (`unchecked`: SET SHOWPLAN_*, NOEXEC, PARSEONLY or FMTONLY ON, or a session
 *  that did not answer), and whether a query is still executing in it. Only queries with one of these are sent. */
export interface SessionTab { readonly name: string; readonly transactions: number; readonly running: boolean; readonly unchecked?: true }
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
const tabSchema = z.object({ name: z.string().min(1).max(sessionPromptLimits.name), transactions: z.number().int().min(0).max(2 ** 31 - 1), running: z.boolean(), unchecked: z.literal(true).optional() }).strict()
  .refine(tab => tab.running || tab.transactions > 0 || tab.unchecked, 'Only queries with an open (or unchecked) transaction or a running query are asked about.')
/** varia:confirm-sessions, from the renderer: main composes the dialog's text itself. */
export const sessionPromptRequestSchema = z.object({ action: z.enum(sessionActions), tabs: z.array(tabSchema).min(1).max(sessionPromptLimits.tabs) }).strict()

/** Whether ending these sessions needs the user's answer first. */
export const needsSessionPrompt = (tabs: readonly SessionTab[]): boolean => tabs.some(tab => tab.running || tab.transactions > 0 || !!tab.unchecked)
/** Whether a session may hold a transaction to commit or roll back. */
const mayBeOpen = (tab: SessionTab): boolean => tab.transactions > 0 || !!tab.unchecked

// What happens, as the end of SSMS's "… before <phrase>?": one query, or several.
const phrases: Readonly<Record<SessionAction, readonly [one: string, many: string]>> = {
  close: ['closing the window', 'closing the windows'],
  closeAll: ['closing the window', 'closing the windows'],
  changeConnection: ['changing the connection', 'changing the connections'],
  disconnectQuery: ['disconnecting', 'disconnecting'],
  disconnect: ['disconnecting the server', 'disconnecting the server'],
  disconnectAll: ['disconnecting', 'disconnecting'],
  exit: ['closing Varia SQL Manager', 'closing Varia SQL Manager']
}
const closes = (action: SessionAction) => action === 'exit' ? 'Varia SQL Manager' : 'the query'

function listed(tabs: readonly SessionTab[], note: (tab: SessionTab) => string): string {
  const shown = tabs.slice(0, sessionPromptLimits.listed).map(tab => `• ${tab.name}${note(tab)}`)
  if (tabs.length > shown.length) shown.push(`… and ${tabs.length - shown.length} more`)
  return shown.join('\n')
}
const nested = (tab: SessionTab) => tab.unchecked ? ' (not checked)' : tab.transactions > 1 ? ` (${tab.transactions} nested levels)` : ''
const notChecked = 'A query marked "not checked" could not be checked: SET SHOWPLAN, NOEXEC, PARSEONLY or FMTONLY may be ON in its session, or it did not answer.'
const queries = (count: number) => count === 1 ? '1 query' : `${count} queries`

/**
 * The prompt for ending these sessions, or undefined when nothing needs asking. Open transactions ask SSMS's question,
 * "There are uncommitted transactions. Do you wish to commit these transactions before closing the window?", with Yes
 * (commit), No (roll back) and Cancel, and Yes as the default, as in SSMS; Escape is Cancel. Several queries are asked
 * about once (SSMS asks per window). A query still executing is cancelled, never committed: what it left uncommitted
 * rolls back when its session closes, so a query that is only executing asks to cancel it or keep it running, and Keep
 * Running is the default. The renderer asks about executing queries and open transactions in separate prompts, as SSMS
 * asks each window; a request that mixes them defaults to Cancel, so Enter never cancels a running query.
 */
export function sessionPrompt({ action, tabs }: SessionPromptRequest): SessionPrompt | undefined {
  const open = tabs.filter(tab => !tab.running && mayBeOpen(tab)), running = tabs.filter(tab => tab.running)
  if (!open.length && !running.length) return undefined
  const runningNote = running.length === 1 ? 'The executing query is cancelled, and anything it left uncommitted is rolled back.'
    : running.length ? 'The executing queries are cancelled, and anything they left uncommitted is rolled back.' : ''
  if (open.length) {
    const one = open.length === 1, phrase = phrases[action][one ? 0 : 1]
    // A session that could not be checked may have one: asking costs a click, not asking could lose work.
    const unsure = open.some(tab => tab.unchecked)
    const message = `There ${unsure ? 'may be' : 'are'} uncommitted transactions${one ? '' : ` in ${open.length} queries`}. Do you wish to commit these transactions before ${phrase}?`
    const detail = [
      listed(open, nested),
      unsure ? notChecked : '',
      'Yes commits every nesting level; No rolls back.',
      running.length ? `Still executing:\n${listed(running, () => '')}\n${runningNote}` : ''
    ].filter(Boolean).join('\n\n')
    return {
      title: 'Uncommitted transactions', message, detail, defaultId: running.length ? 2 : 0, cancelId: 2,
      buttons: [{ label: 'Yes', answer: 'commit' }, { label: 'No', answer: 'rollback' }, { label: 'Cancel', answer: 'cancel' }]
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
