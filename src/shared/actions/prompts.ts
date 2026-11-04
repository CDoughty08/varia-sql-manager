// Native confirmations of object actions (A13): one catalogue, one channel (`varia:confirm-action`). The renderer sends a
// prompt id and bounded facts; main validates them, writes the message box from this catalogue (names through
// displayText) and answers with a button id, so the page can neither word a prompt nor pick its default. Database
// Properties' Open Connections prompt keeps its own channel (src/main/open-connections.ts). Erasable TypeScript.
import { z } from 'zod'
import { displayText } from '../explorer/refs.ts'

/** Bounds of a prompt's facts: names as SQL Server allows them, counts, and the query tabs a prompt names. */
export const promptLimits = { name: 128, count: 1_000_000, tabs: 8, tabName: 260, service: 256, connections: 8, connectionName: 260 } as const
const name = z.string().min(1).max(promptLimits.name)
const count = z.number().int().min(0).max(promptLimits.count)

/** D3c: renaming a database other sessions are using. */
export const renameDatabaseFactsSchema = z.object({
  database: name,
  /** Sessions using the database, or absent when they could not be counted. */
  sessions: count.optional(),
  /** Of them, the sessions with an open transaction, which closing rolls back (A7), or absent when they could not be counted. */
  transactions: count.optional(),
  /** Varia's own query tabs connected to it, and the names of those with an open transaction (`promptTabFacts` bounds them). */
  tabs: count,
  tabsWithTransactions: z.array(z.string().min(1).max(promptLimits.tabName)).max(promptLimits.tabs),
  /** Varia's tabs with an open transaction past the named ones. */
  moreTabsWithTransactions: count.optional(),
  /** Whether Varia may close them (SINGLE_USER); not on Managed Instance. */
  canClose: z.boolean()
}).strict()
/**
 * The tab facts of a prompt from every tab name: the first `promptLimits.tabs` names, each clipped to `promptLimits.tabName`
 * characters (an empty one named by its position), and a count of the rest, so a prompt names what it can and counts the
 * others rather than failing validation.
 */
export function promptTabFacts(names: readonly string[]): { readonly tabsWithTransactions: string[]; readonly moreTabsWithTransactions?: number } {
  const named = names.slice(0, promptLimits.tabs).map((text, index) => {
    // zod counts UTF-16 units; a clip never leaves half of a surrogate pair.
    const clipped = text.slice(0, promptLimits.tabName)
    return (/[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped) || `Query ${index + 1}`
  })
  const more = Math.min(names.length - named.length, promptLimits.count)
  return more > 0 ? { tabsWithTransactions: named, moreTabsWithTransactions: more } : { tabsWithTransactions: named }
}
/** D4b: disabling a login. */
export const disableLoginFactsSchema = z.object({
  login: name,
  /** Sessions connected as the login, when counted. */
  sessions: count.optional(),
  /** The service that runs as this login (`sys.dm_server_services.servicename`). */
  service: z.string().min(1).max(promptLimits.service).optional(),
  sysadmin: z.boolean(),
  /** Varia's other connections to the server that sign in as this login (critic D4-3), by their Object Explorer label:
   *  they cannot reconnect while it is disabled. */
  connections: z.array(z.string().min(1).max(promptLimits.connectionName)).min(1).max(promptLimits.connections).optional(),
  /** Login Properties (D2c): its Status denies the login permission to connect rather than disabling it. */
  deny: z.literal(true).optional()
}).strict()
export const actionPromptRequestSchema = z.discriminatedUnion('prompt', [
  z.object({ prompt: z.literal('renameDatabase'), facts: renameDatabaseFactsSchema }).strict(),
  z.object({ prompt: z.literal('disableLogin'), facts: disableLoginFactsSchema }).strict()
])
export type ActionPromptRequest = z.infer<typeof actionPromptRequestSchema>
export type ActionPromptId = ActionPromptRequest['prompt']
type FactsOf<P extends ActionPromptId> = Extract<ActionPromptRequest, { prompt: P }>['facts']

export interface PromptButton<A extends string> { readonly answer: A; readonly label: string }
/** A prompt: its title, message and detail from the facts, its buttons in order, and which is the default and which Escape. */
export interface ActionPromptSpec<P extends ActionPromptId, A extends string> {
  readonly title: string
  message(facts: FactsOf<P>): string
  detail(facts: FactsOf<P>): readonly string[]
  buttons(facts: FactsOf<P>): readonly PromptButton<A>[]
  defaultAnswer(facts: FactsOf<P>): A
  readonly cancelAnswer: A
}
const plural = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`
const show = (text: string) => displayText(text)
/** Varia's connections that sign in as a login, and what a change to the login does to them (critic D4-3). */
export const loginConnectionsText = (labels: readonly string[], consequence: string): string =>
  labels.length === 1 ? `Varia's connection ${show(labels[0])} signs in as this login, and ${consequence}.` : `Varia's connections ${labels.map(show).join(', ')} sign in as this login, and ${consequence}.`

export const actionPrompts = {
  // SSMS has none: its rename fails ("The database could not be exclusively locked"); Varia offers to close the connections
  // (SINGLE_USER, rename, restore access) or to wait with Stop, as its rename did before.
  renameDatabase: {
    title: 'Rename Database',
    // The question matches the buttons: closing when Varia may, else renaming once the connections are gone. One connection is "it".
    message: facts => {
      const one = facts.sessions === 1
      const using = facts.sessions === undefined ? `Other connections may be using ${show(facts.database)}`
        : `${plural(facts.sessions, 'connection is', 'connections are')} using ${show(facts.database)}${facts.tabs ? ` (${plural(facts.tabs, 'query window', 'query windows')} in Varia)` : ''}`
      return `${using}. ${facts.canClose ? `Close ${one ? 'it' : 'them'} and rename the database?` : `Rename the database when ${one ? 'it disconnects' : 'they disconnect'}?`}`
    },
    // A7: when Varia may close them, the box always says what closing rolls back; when the transactions could not be counted, it
    // says so generally. Without Close, nothing is rolled back, and the windows with open transactions are what the wait waits for.
    detail: facts => {
      const one = facts.sessions === 1
      return [
        ...!facts.canClose ? [] : facts.transactions === undefined ? [`Closing ${one ? 'it' : 'them'} rolls back any open transaction.`]
          : facts.transactions ? [`${plural(facts.transactions, 'session has an open transaction', 'sessions have open transactions')}, which closing rolls back.`] : [],
        ...facts.tabsWithTransactions.length || facts.moreTabsWithTransactions ? [`Varia's query windows with open transactions: ${[
          ...facts.tabsWithTransactions.map(show), ...facts.moreTabsWithTransactions ? [facts.tabsWithTransactions.length ? `and ${plural(facts.moreTabsWithTransactions, 'more', 'more')}` : plural(facts.moreTabsWithTransactions, 'window', 'windows')] : []
        ].join(', ')}.`] : [],
        ...facts.canClose ? [] : [`This server does not let Varia close ${one ? 'it' : 'them'}.`],
        `Rename When Free waits until ${one ? 'it disconnects' : 'they disconnect'}; Stop in the status bar ends the wait.`
      ]
    },
    buttons: facts => [...facts.canClose ? [{ answer: 'closeAndRename' as const, label: 'Close Connections and Rename' }] : [], { answer: 'renameWhenFree', label: 'Rename When Free' }, { answer: 'cancel', label: 'Cancel' }],
    defaultAnswer: facts => facts.canClose ? 'closeAndRename' : 'renameWhenFree',
    cancelAnswer: 'cancel'
  } satisfies ActionPromptSpec<'renameDatabase', 'closeAndRename' | 'renameWhenFree' | 'cancel'>,
  // SSMS disables at once; Varia asks, with Cancel the default for a login a service runs as. Login Properties asks it too, for Deny as
  // well, when a session, a service or another Varia connection would be locked out (D2c).
  disableLogin: {
    title: 'Disable Login',
    message: facts => facts.deny ? `Deny the login ${show(facts.login)} permission to connect?` : `Disable the login ${show(facts.login)}?`,
    detail: facts => [
      'New connections will be refused.' + (facts.sessions ? ` ${facts.sessions === 1 ? '1 session connected as this login stays connected until it ends' : `${plural(facts.sessions, 'session', 'sessions')} connected as this login stay connected until they end`}; Activity Monitor can end ${facts.sessions === 1 ? 'it' : 'them'}.` : ''),
      ...facts.service ? [`${show(facts.service)} runs as this account, and cannot connect while it is ${facts.deny ? 'denied' : 'disabled'}.`] : [],
      ...facts.sysadmin ? ['This login is a member of sysadmin.'] : [],
      ...facts.connections?.length ? [loginConnectionsText(facts.connections, facts.deny ? 'cannot reconnect while it is denied' : 'cannot reconnect while it is disabled')] : []
    ],
    buttons: facts => [facts.deny ? { answer: 'deny' as const, label: 'Deny' } : { answer: 'disable' as const, label: 'Disable' }, { answer: 'cancel', label: 'Cancel' }],
    defaultAnswer: facts => facts.service ? 'cancel' : facts.deny ? 'deny' : 'disable',
    cancelAnswer: 'cancel'
  } satisfies ActionPromptSpec<'disableLogin', 'disable' | 'deny' | 'cancel'>
} as const
export type ActionPromptAnswer<P extends ActionPromptId = ActionPromptId> = ReturnType<typeof actionPrompts[P]['buttons']>[number]['answer']

/** A prompt's message box, as main shows it: the buttons' labels and answers, and the default's and Escape's indexes. */
export interface ActionPromptBox { readonly title: string; readonly message: string; readonly detail: string; readonly buttons: readonly string[]; readonly answers: readonly string[]; readonly defaultId: number; readonly cancelId: number }
export function actionPromptBox(request: ActionPromptRequest): ActionPromptBox {
  const spec = actionPrompts[request.prompt] as unknown as ActionPromptSpec<ActionPromptId, string>
  const facts = request.facts as never
  const buttons = spec.buttons(facts), answers = buttons.map(button => button.answer)
  return {
    title: spec.title, message: spec.message(facts), detail: spec.detail(facts).join('\n\n'), buttons: buttons.map(button => button.label), answers,
    defaultId: answers.indexOf(spec.defaultAnswer(facts)), cancelId: answers.indexOf(spec.cancelAnswer)
  }
}
/** The answer for a response index: a button's, else (Escape, a closed box, a page that went away) the cancel answer. */
export const actionPromptAnswer = (box: ActionPromptBox, response: number): string => box.answers[response] ?? box.answers[box.cancelId]
