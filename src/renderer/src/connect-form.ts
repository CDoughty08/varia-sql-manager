import type { AdvancedConnectionOptions, ConnectionOptions } from '../../shared/contracts'
import { showsIdentity } from '../../shared/auth'
import { advancedDefaults } from '../../shared/connections'
import { environmentTag } from '../../shared/environments'
import { connectionPresets } from '../../shared/theme/connection-colors'

/** Limits for Connect's resizable saved-connections rail; shared between CSS/layout and tests. */
export const connectRailLimits = { defaultWidth: 320, minWidth: 220, maxWidth: 480, minFormWidth: 420, stackBelow: 720 } as const

/**
 * Clamps or safely restores the Connect rail width for a given dialog width so the form pane keeps at least
 * `minFormWidth`. Invalid values or restored widths that would squeeze a narrower window fall back to `defaultWidth`
 * (fitted to the safe maximum).
 */
export function clampConnectRailWidth(wanted: number | undefined, dialogWidth: number): number {
  const { defaultWidth, minWidth, maxWidth, minFormWidth } = connectRailLimits
  const safeMax = Math.max(minWidth, Math.min(maxWidth, Math.round(dialogWidth) - minFormWidth))
  const fallback = Math.max(minWidth, Math.min(defaultWidth, safeMax))
  if (typeof wanted !== 'number' || !Number.isFinite(wanted) || wanted <= 0 || wanted > dialogWidth - minFormWidth) return fallback
  return Math.max(minWidth, Math.min(Math.round(wanted), safeMax))
}

export interface ParsedConnectionString {
  readonly patch: Partial<ConnectionOptions>
  readonly advancedPatch: Partial<AdvancedConnectionOptions>
  readonly matchedCount: number
  readonly passwordOmitted: boolean
}

function splitPairs(raw: string): [string, string][] {
  const pairs: [string, string][] = []
  let current = '', quote: '"' | "'" | null = null
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote) {
      if (ch === quote && raw[i + 1] === quote) { current += quote; i++ }
      else if (ch === quote) quote = null
      else current += ch
      continue
    }
    if ((ch === '"' || ch === "'") && current.includes('=')) { quote = ch; continue }
    if (ch === ';') {
      const eq = current.indexOf('=')
      if (eq > 0) pairs.push([current.slice(0, eq).trim(), current.slice(eq + 1).trim()])
      current = ''
      continue
    }
    current += ch
  }
  const eq = current.indexOf('=')
  if (eq > 0) pairs.push([current.slice(0, eq).trim(), current.slice(eq + 1).trim()])
  return pairs
}

const boolValue = (value: string): boolean | undefined => {
  const lower = value.toLowerCase()
  if (lower === 'true' || lower === 'yes' || lower === '1') return true
  if (lower === 'false' || lower === 'no' || lower === '0') return false
  return undefined
}
const intInRange = (value: string, min: number, max: number): number | undefined => {
  if (!/^-?\d+$/.test(value)) return undefined
  const num = Number(value)
  return Number.isSafeInteger(num) && num >= min && num <= max ? num : undefined
}

const cleanValue = (value: string, max: number) => value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max)

/**
 * Parses standard semicolon-delimited SqlClient / ADO.NET / Azure SQL connection strings into structured `ConnectionOptions`
 * and `AdvancedConnectionOptions` patches. Passwords (`Password` / `PWD`) are never imported into drafts for safety;
 * `passwordOmitted` reports when a password key was skipped so the UI can remind the user. Control characters are
 * stripped and string fields are bounded to the connection schemas' limits.
 */
export function parseConnectionString(raw: string): ParsedConnectionString {
  const patch: Partial<ConnectionOptions> = {}
  const advancedPatch: Partial<AdvancedConnectionOptions> = {}
  let matchedCount = 0, passwordOmitted = false
  for (const [rawKey, value] of splitPairs(raw)) {
    const key = rawKey.toLowerCase().replace(/\s+/g, '')
    if (!value) continue
    if (key === 'password' || key === 'pwd') { passwordOmitted = true; continue }
    if (['server', 'datasource', 'addr', 'address'].includes(key)) { patch.server = cleanValue(value.replace(/^tcp:/i, ''), 256); matchedCount++ }
    else if (['initialcatalog', 'database'].includes(key)) { patch.database = cleanValue(value, 128); matchedCount++ }
    else if (['userid', 'uid', 'user'].includes(key)) { patch.username = cleanValue(value, 128); patch.authentication ??= 'sql'; matchedCount++ }
    else if (key === 'integratedsecurity' || key === 'trusted_connection' || key === 'trustedconnection') {
      if (value.toLowerCase() === 'sspi' || boolValue(value) === true) { patch.authentication = 'windows'; matchedCount++ }
    } else if (key === 'authentication') {
      const mode = value.toLowerCase().replace(/\s+/g, '')
      if (mode === 'activedirectoryinteractive' || mode === 'entramfa') { patch.authentication = 'entraMfa'; matchedCount++ }
      else if (mode === 'activedirectoryintegrated') { patch.authentication = 'entraIntegrated'; matchedCount++ }
      else if (mode === 'activedirectorypassword') { patch.authentication = 'entraPassword'; matchedCount++ }
      else if (mode === 'activedirectoryserviceprincipal') { patch.authentication = 'entraServicePrincipal'; matchedCount++ }
      else if (mode === 'activedirectorymanagedidentity' || mode === 'activedirectorymsi') { patch.authentication = 'entraManagedIdentity'; matchedCount++ }
      else if (mode === 'activedirectorydefault') { patch.authentication = 'entraDefault'; matchedCount++ }
      else if (mode === 'sqlpassword') { patch.authentication = 'sql'; matchedCount++ }
    } else if (key === 'encrypt') {
      const lower = value.toLowerCase()
      if (lower === 'strict') { patch.encrypt = 'strict'; matchedCount++ }
      else if (boolValue(lower) === false || lower === 'optional') { patch.encrypt = 'optional'; matchedCount++ }
      else if (boolValue(lower) === true || lower === 'mandatory') { patch.encrypt = 'mandatory'; matchedCount++ }
    } else if (key === 'trustservercertificate') {
      const parsed = boolValue(value)
      if (parsed !== undefined) { patch.trustServerCertificate = parsed; matchedCount++ }
    } else if (key === 'hostnameincertificate') { patch.hostNameInCertificate = cleanValue(value, 256); matchedCount++ }
    else if (key === 'commandtimeout') { const n = intInRange(value, 0, 86400); if (n !== undefined) { advancedPatch.commandTimeout = n; matchedCount++ } }
    else if (key === 'connecttimeout' || key === 'connectiontimeout') { const n = intInRange(value, 0, 3600); if (n !== undefined) { advancedPatch.connectTimeout = n; matchedCount++ } }
    else if (key === 'applicationname' || key === 'app') { advancedPatch.applicationName = cleanValue(value, 128); matchedCount++ }
    else if (key === 'workstationid' || key === 'wsid') { advancedPatch.workstationId = cleanValue(value, 128); matchedCount++ }
    else if (key === 'applicationintent') {
      if (value.toLowerCase() === 'readonly') { advancedPatch.applicationIntent = 'ReadOnly'; matchedCount++ }
      else if (value.toLowerCase() === 'readwrite') { advancedPatch.applicationIntent = 'ReadWrite'; matchedCount++ }
    } else if (key === 'multisubnetfailover') { const b = boolValue(value); if (b !== undefined) { advancedPatch.multiSubnetFailover = b; matchedCount++ } }
    else if (key === 'multipleactiveresultsets') { const b = boolValue(value); if (b !== undefined) { advancedPatch.multipleActiveResultSets = b; matchedCount++ } }
    else if (key === 'packetsize') { const n = intInRange(value, 512, 32767); if (n !== undefined) { advancedPatch.packetSize = n; matchedCount++ } }
    else if (key === 'connectretrycount') { const n = intInRange(value, 0, 255); if (n !== undefined) { advancedPatch.connectRetryCount = n; matchedCount++ } }
    else if (key === 'connectretryinterval') { const n = intInRange(value, 1, 60); if (n !== undefined) { advancedPatch.connectRetryInterval = n; matchedCount++ } }
    else if (key === 'failoverpartner') { advancedPatch.failoverPartner = cleanValue(value, 256); matchedCount++ }
  }
  if (patch.authentication && showsIdentity(patch.authentication)) delete patch.username
  return { patch, advancedPatch, matchedCount, passwordOmitted }
}

/**
 * How many Advanced Properties the connection sets: those that differ from their defaults, and a stored command timeout,
 * which overrides Tools › Options whatever its value. A value edited back to its default, or a profile from an earlier
 * version that stored every property, sets nothing more than the defaults do.
 */
export function advancedCount(advanced: Partial<AdvancedConnectionOptions> | undefined): number {
  return advanced ? Object.entries(advanced).filter(([key, value]) => value !== undefined && (key === 'commandTimeout' || value !== advancedDefaults[key as keyof AdvancedConnectionOptions])).length : 0
}
/** What the Advanced tab's accessible summary says: nothing, or how many properties are set. */
export function advancedSummary(advanced: Partial<AdvancedConnectionOptions> | undefined): string {
  const count = advancedCount(advanced)
  return count === 0 ? '' : count === 1 ? '1 property set' : `${count} properties set`
}

/** A stored connection colour by its preset's name, or Custom. */
export function colorName(stored: string | undefined): string | undefined {
  if (!stored) return undefined
  return connectionPresets.find(preset => preset.stored === stored.toLowerCase())?.label ?? 'Custom'
}
/**
 * The Labels & Custom Properties summary, so a name, colour or environment that is set stays in view: the parts for
 * the row, and one sentence for screen readers. A Custom environment still being typed ('') counts as unset.
 */
export function customSummary(options: Pick<ConnectionOptions, 'displayName' | 'color' | 'environment'>): { readonly name?: string; readonly color?: string; readonly environment?: string; readonly text: string } {
  const name = options.displayName?.trim() || undefined
  const color = colorName(options.color)
  const environment = environmentTag(options.environment) ? options.environment!.trim() : undefined
  const parts = [name && `Name ${name}`, color && `Color ${color}`, environment && `Environment ${environment}`].filter(Boolean)
  return { name, color, environment, text: parts.length ? parts.join(', ') : 'No name, color or environment' }
}

/**
 * Arrow keys in the saved and discovered server lists: the index to focus next among `count` rows, or undefined for a
 * key the lists leave alone. -1 is the filter box: Down enters the list from it, and Up from the first row goes back.
 * Home and End in the filter box stay the text's, as does any key with a modifier or during an IME composition (Shift+Down
 * selects, Ctrl+Down and Cmd+Down move the caret).
 */
export function listStep(current: number, count: number, key: string, modified = false): number | undefined {
  if (count === 0 || modified) return undefined
  if (key === 'ArrowDown') return Math.min(current + 1, count - 1)
  if (key === 'ArrowUp') return current < 0 ? undefined : current - 1
  if (current < 0) return undefined
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return undefined
}
/** A saved connection row's tooltip: its name first, which the narrow list often cuts short, then server and database. */
export function rowTitle(options: Pick<ConnectionOptions, 'displayName' | 'server' | 'database'>): string {
  return [options.displayName, [options.server, options.database].filter(Boolean).join(' · ')].filter(Boolean).join('\n')
}
