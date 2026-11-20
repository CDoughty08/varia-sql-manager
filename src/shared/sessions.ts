import { z } from 'zod'

/**
 * What ends query sessions, and so asks first about their open transactions and running queries: closing a query (or
 * several), moving it to another server, disconnecting it (Disconnect, or Change Connection to Disconnected), disconnecting
 * a server or every query, closing the window or quitting, and switching a BigQuery query to a dataset in another location
 * (decision 18), whose session lives in one location.
 */
export const sessionActions = ['close', 'closeAll', 'changeConnection', 'disconnectQuery', 'disconnect', 'disconnectAll', 'exit', 'switchLocation'] as const
export type SessionAction = typeof sessionActions[number]
/** A query whose session ends: its open-transaction count (@@TRANCOUNT, read from its idle session just before the
 *  prompt), whether that read could not tell (`unchecked`: SET SHOWPLAN_*, NOEXEC, PARSEONLY or FMTONLY ON, or a session
 *  that did not answer), and whether a query is still executing in it. Only queries with one of these are sent. */
export interface SessionTab { readonly name: string; readonly transactions: number; readonly running: boolean; readonly unchecked?: true; readonly provider?: SessionProvider }
/** The engine a query's session is on, which picks the "not checked" note's causes. */
export type SessionProvider = 'sqlserver' | 'bigquery'
/** A BigQuery query switching to `dataset` in location `to`, while its session is in `from` (decision 18). */
export interface SessionLocationSwitch { readonly dataset: string; readonly from: string; readonly to: string }
/** `location` asks the location question of a `switchLocation` (one query, before any transaction is asked about). */
export interface SessionPromptRequest { readonly action: SessionAction; readonly tabs: readonly SessionTab[]; readonly location?: SessionLocationSwitch }
/** `commit` and `rollback` end the listed transactions that way; `proceed` cancels the executing queries (the prompt had
 *  no transactions to ask about); `cancel` keeps everything as it is. */
export type SessionAnswer = 'commit' | 'rollback' | 'proceed' | 'cancel'
/** How a session ends when its query closes: its transaction committed or rolled back first. */
export type SessionEnd = 'commit' | 'rollback'
/** query.session.close's options: `abortOnRefusedCommit` (default true) lets a BigQuery commit refused on an unchecked
 *  session end the session anyway; quitting sets it false, since the closing app could show nothing. */
export interface SessionCloseOptions { readonly transaction?: SessionEnd; readonly abortOnRefusedCommit?: boolean }
/** What became of a BigQuery commit or session end (docs/bigquery.md, Sessions), with BigQuery's message or the job it names. */
export interface SessionCloseNote { readonly code: SessionCloseNoteCode; readonly message?: string; readonly jobId?: string }
export type SessionCloseNoteCode = 'commitNotApplied' | 'committedBeforeCancel' | 'outcomeUnknown' | 'abortFailed' | 'sessionExpired'
export interface SessionCloseResult { readonly closed: boolean; readonly note?: SessionCloseNote }
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
const tabSchema = z.object({
  name: z.string().min(1).max(sessionPromptLimits.name), transactions: z.number().int().min(0).max(2 ** 31 - 1), running: z.boolean(), unchecked: z.literal(true).optional(),
  provider: z.enum(['sqlserver', 'bigquery']).optional()
}).strict()
const locationId = z.string().min(1).max(64).regex(/^[A-Za-z\d-]+$/)
/** varia:confirm-sessions, from the renderer: main composes the dialog's text itself. Only queries with an open (or
 *  unchecked) transaction or a running query are asked about, except the one query a location switch asks about. */
export const sessionPromptRequestSchema = z.object({
  action: z.enum(sessionActions), tabs: z.array(tabSchema).min(1).max(sessionPromptLimits.tabs),
  location: z.object({ dataset: z.string().min(1).max(1024).regex(/^\w+$/), from: locationId, to: locationId }).strict().optional()
}).strict().refine(request => request.location
  ? request.action === 'switchLocation' && request.tabs.length === 1
  : request.tabs.every(tab => tab.running || tab.transactions > 0 || tab.unchecked), 'Only queries with an open (or unchecked) transaction or a running query are asked about.')

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
  exit: ['closing Varia SQL Manager', 'closing Varia SQL Manager'],
  switchLocation: ['switching the location', 'switching the location']
}
const closes = (action: SessionAction) => action === 'exit' ? 'Varia SQL Manager' : 'the query'

function listed(tabs: readonly SessionTab[], note: (tab: SessionTab) => string): string {
  const shown = tabs.slice(0, sessionPromptLimits.listed).map(tab => `• ${tab.name}${note(tab)}`)
  if (tabs.length > shown.length) shown.push(`… and ${tabs.length - shown.length} more`)
  return shown.join('\n')
}
const nested = (tab: SessionTab) => tab.unchecked ? ' (not checked)' : tab.transactions > 1 ? ` (${tab.transactions} nested levels)` : ''
const notChecked = 'A query marked "not checked" could not be checked: SET SHOWPLAN, NOEXEC, PARSEONLY or FMTONLY may be ON in its session, or it did not answer.'
const notCheckedBigQuery = 'For a BigQuery query marked "not checked", Varia could not tell whether its transaction is still open (a statement inside it failed, or the session did not answer).'
/** The "not checked" note for these queries: SQL Server's causes, BigQuery's, or both for a mixed box. */
const notCheckedNote = (tabs: readonly SessionTab[]): string => {
  const unsure = tabs.filter(tab => tab.unchecked)
  const bigQuery = unsure.some(tab => tab.provider === 'bigquery'), sqlServer = unsure.some(tab => tab.provider !== 'bigquery')
  return [sqlServer ? notChecked : '', bigQuery ? notCheckedBigQuery : ''].filter(Boolean).join(' ')
}
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
export function sessionPrompt({ action, tabs, location }: SessionPromptRequest): SessionPrompt | undefined {
  if (location) return locationPrompt(tabs[0], location)
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
      unsure ? notCheckedNote(open) : '',
      'Yes commits every nesting level; No rolls back.',
      running.length ? `Still executing:\n${listed(running, () => '')}\n${runningNote}` : ''
    ].filter(Boolean).join('\n\n')
    return {
      title: 'Uncommitted transactions', message, detail, defaultId: running.length || action === 'disconnect' ? 2 : 0, cancelId: 2,
      buttons: [{ label: 'Yes', answer: 'commit' }, { label: 'No', answer: 'rollback' }, { label: 'Cancel', answer: 'cancel' }]
    }
  }
  const one = running.length === 1
  return {
    title: 'Query executing',
    message: one ? `${running[0].name} is still executing.` : `${queries(running.length)} are still executing.`,
    detail: [one ? '' : listed(running, () => ''), action === 'disconnect'
      ? `Cancel ${one ? 'it' : 'them'} and disconnect the server? Cancellation does not undo work already committed. If completion cannot be confirmed, the outcome may be unknown and disconnect stops with every tab open.`
      : `Cancel ${one ? 'it' : 'them'} and close ${closes(action)}? Anything ${one ? 'it' : 'they'} left uncommitted is rolled back.`].filter(Boolean).join('\n\n'),
    defaultId: 1, cancelId: 1,
    buttons: [{ label: action === 'disconnect' ? one ? 'Cancel Query and Disconnect' : 'Cancel Queries and Disconnect' : action === 'switchLocation' ? one ? 'Cancel Query and Switch' : 'Cancel Queries and Switch' : one ? 'Cancel Query and Close' : 'Cancel Queries and Close', answer: 'proceed' },
      { label: action === 'switchLocation' ? "Don't Switch" : 'Keep Running', answer: 'cancel' }]
  }
}

/** Decision 18's question: a BigQuery session lives in one location, so a dataset in another ends it. Switch proceeds;
 *  Don't Switch (and Escape) keeps the tab's dataset and session. */
function locationPrompt(tab: SessionTab, { dataset, from, to }: SessionLocationSwitch): SessionPrompt {
  return {
    title: `Switch this tab to ${to}?`,
    message: `${dataset} is in ${to}; the BigQuery session of ${tab.name} is in ${from}.`,
    detail: `Switching ends the tab's session: its temp tables, variables and any open transaction are lost. The next Execute starts a session in ${to}.`,
    defaultId: 0, cancelId: 1,
    buttons: [{ label: 'Switch', answer: 'proceed' }, { label: "Don't Switch", answer: 'cancel' }]
  }
}

/** The text a BigQuery close's note becomes, naming the query: a Messages line when the tab stays, a notification when it
 *  closed (docs/bigquery.md, Sessions), so a commit that did not happen is never unseen. */
export function sessionCloseNoteText(name: string, note: SessionCloseNote): string {
  const job = note.jobId ? ` ${note.jobId}` : ''
  switch (note.code) {
    case 'commitNotApplied': return `${name}: the commit was not applied. BigQuery refused it${note.message ? ` (${note.message})` : ''}, so the session was ended and any open transaction was rolled back.`
    case 'committedBeforeCancel': return `${name}: the stopped job${job} committed a transaction before it stopped. Stopping does not undo work already committed.`
    case 'outcomeUnknown': return `${name}: Varia could not learn whether job${job} committed. Check the job in BigQuery's job history; the session ends once the job finishes.`
    case 'abortFailed': return `${name}: Varia could not end the BigQuery session${note.message ? ` (${note.message})` : ''}. Any transaction in it stays open until the session expires, other transactions on its tables fail meanwhile, and its temp tables are billed as storage.`
    case 'sessionExpired': return `${name}: the BigQuery session had expired (24 hours idle or 7 days), so BigQuery rolled back its open transaction.`
  }
}
/** Notes a quit stops for, since it could not show them once the window closes; quitting again proceeds. */
export const quitStoppingNotes: ReadonlySet<SessionCloseNoteCode> = new Set(['outcomeUnknown', 'committedBeforeCancel', 'abortFailed'])
/** Main's commit deadline won for a BigQuery query: the COMMIT may still run, and the session ends once it finishes. */
export const bigQueryCommitTimeout = "Varia could not learn whether the commit took effect: BigQuery did not answer in time. Check the COMMIT job in BigQuery's job history; the session ends once it finishes."
