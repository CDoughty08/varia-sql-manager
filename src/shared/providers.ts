// The database engines Varia connects to, and how catalogue entries and backend methods declare which of them they
// support. Erasable TypeScript with no imports, so ipc/methods.ts (loaded by the fake backend through Node's type
// stripping) can import it by its .ts name.

/** One id per engine, everywhere: connections, principals, targets, documents, catalogues and methods. `postgresql` stays
 *  reserved in the language contract only (language-service.ts). */
export const providerIds = ['sqlserver', 'bigquery'] as const
export type ProviderId = typeof providerIds[number]
/** A context key's provider value: '' when there is no connection or document to take it from. */
export type ProviderContext = ProviderId | ''

/** What an entry or method that does not say supports: SQL Server only, so one that forgets to declare is hidden for
 *  BigQuery (a safe failure) rather than half working. */
export const defaultProviders: readonly ProviderId[] = ['sqlserver']
/** What a provider-neutral entry declares (editing, results, layout, help). */
export const bothProviders: readonly ProviderId[] = ['sqlserver', 'bigquery']

export function isProviderId(value: unknown): value is ProviderId { return typeof value === 'string' && (providerIds as readonly string[]).includes(value) }
/** An entry's or method's providers, with the default for one that does not declare them. */
export function providersOf(entry: { readonly providers?: readonly ProviderId[] } | undefined): readonly ProviderId[] { return entry?.providers ?? defaultProviders }
/** Whether an entry declared for `providers` applies where the context's provider is `provider`; '' (no connection or
 *  document) never hides anything. */
export function providerAllows(providers: readonly ProviderId[], provider: ProviderContext): boolean { return provider === '' || providers.includes(provider) }
/** 0.9.0 spelled SQL Server `sqlServer` in connection principals and targets; it reads as `sqlserver` and is written so from then on. */
export function normalizedProvider(value: unknown): unknown { return value === 'sqlServer' ? 'sqlserver' : value }
/** The provider of connection options, a target or a record that may predate providers: a missing one is SQL Server. */
export function providerOf(value: { readonly provider?: ProviderId } | undefined): ProviderId { return value?.provider ?? 'sqlserver' }
