import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import type { AdvancedConnectionOptions, ApiResult, BigQueryConnectionOptions, ConnectionInfo, ConnectionOptions, DatabaseInfo, DiscoveredServer, ErrorDetails, ProviderConnectionOptions } from '../../shared/contracts'
import type { ErrorCode } from '../../shared/ipc/wire/protocol'
import { changedConnectionDetails, type ConnectionDetailField, type ConnectionDetails } from '../../shared/connection-targets'
import { detailsOf, type ConnectionAttempt } from './services/connections'
import { liveGeneration } from './services/backend'
import { isLiveConnection } from './services/connection-availability'
import { advancedDefaults, advancedToStore, canRememberPassword, connectionDefaults, credentialBinding, rememberedProfile, type ConnectionLibrary, type ConnectionLibraryView, type ConnectionProfile, type ConnectionProfileInput, type ConnectionSaveView, type SecretStorageState } from '../../shared/connections'
import { bigQueryTargetOptions, connectionTargetOptions, isBigQueryTarget } from '../../shared/connection-targets'
import { connectionKey } from '../../shared/connections'
import type { BigQueryConnectionProfile, BigQueryLibraryView, PickedKeyFile } from '../../shared/bigquery-connections'
import type { ProviderId } from '../../shared/providers'
import type { BigQueryAuthenticationMode } from '../../shared/auth'
import { BigQueryAdvanced, BigQueryConnectFields, accountText, bigQueryAdvancedCount, bigQueryAdvancedSummary, useBigQueryLists } from './BigQueryConnectFields'
import { bigQueryCredentialReady, bigQueryDefaults, bigQueryFormOptions, bigQueryReady, bigQueryRowDetail, bigQueryRowText, lastServerType, savedCostPrompt, serverTypeLabels, switchServerType, undoServerType, withAuthentication, withoutCostPrompt, type ServerTypeState, bigQueryFormShape } from './bigquery-connect-form'
import { connectionPresets } from '../../shared/theme/connection-colors'
import { dialogWindowKinds } from '../../shared/popouts'
import Icon from './Icon'
import InlineError, { type ErrorAction } from './kit/InlineError'
import { connectFix } from './connect-fix'
import { advancedCount, advancedSummary, clampConnectRailWidth, connectRailLimits, listStep, parseConnectionString, rowTitle } from './connect-form'
import { EnvironmentField } from './EnvironmentDialog'
import EnvironmentTag from './EnvironmentTag'
import { entryKey, parseEnvironment, savedEntry } from './services/environments'
import { trapFocus } from './trap-focus'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import { IntegratedIdentityLookup } from './services/integrated-identity'
import { authenticationCatalog, authenticationModes, requiresUser, showsIdentity, usesPassword, type AuthenticationMode } from '../../shared/auth'
import { focusToReturn, returnFocusBeside } from './core/focus'
import SubDialog from './dialogs/SubDialog'
import { useKeepFocus } from './dialogs/keep-focus'
import { applySavedDetails } from './services/saved-connection-details'
import DialogWindow, { closesDialogWindow, DialogHeading, useDialogWindow } from './popouts/DialogWindow'

/** What Cancel compares: settings and labels (the environment as stored), never the password. */
function labels(from: ConnectionOptions, autoReconnect: ConnectionDetails['autoReconnect']) {
  const environment = parseEnvironment(from.environment)
  return JSON.stringify([from.displayName ?? '', from.color ?? '', environment.ok ? environment.environment ?? '' : from.environment, autoReconnect])
}
/** The details a form would give a connection, with the environment as stored. */
function detailsFrom(from: ConnectionOptions, autoReconnect: ConnectionDetails['autoReconnect']): ConnectionDetails {
  const environment = parseEnvironment(from.environment)
  return detailsOf({ ...from, environment: environment.ok ? environment.environment : from.environment }, autoReconnect)
}
const historyNotSaved = 'Connected, but the changed name, color or environment could not be saved to History.'
const connectingLabel = 'Connecting…'
const testConnectionLabel = 'Test Connection'
const cancelLabel = 'Cancel'
const settingsKey = (from: ConnectionOptions) => entryKey({ ...from, displayName: undefined, color: undefined, environment: undefined })
const shape = (from: ConnectionOptions, autoReconnect: ConnectionDetails['autoReconnect']) => JSON.stringify([settingsKey(from) ?? null, labels(from, autoReconnect)])
function unwrap<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(result.error); return result.value }
function message(error: unknown) { return error instanceof Error ? error.message : 'The operation failed.' }
const palette: readonly (readonly [string, string])[] = [['Default', ''], ...connectionPresets.map(preset => [preset.label, preset.stored] as const)]
type HistoryRow = { readonly sql: ConnectionProfile } | { readonly bigQuery: BigQueryConnectionProfile }
const rowTime = (row: HistoryRow) => ('sql' in row ? row.sql : row.bigQuery).lastConnected ?? ''
const bigQueryShape = bigQueryFormShape
const bigQueryKey = (from: BigQueryConnectionOptions) => { try { return connectionKey(bigQueryFormOptions({ ...from, displayName: undefined, color: undefined, environment: undefined })) } catch { return undefined } }
const railStorageKey = 'varia.connect.railWidth'
function loadRailWidth(dialogWidth: number): number {
  try {
    const raw = localStorage.getItem(railStorageKey)
    if (raw !== null) return clampConnectRailWidth(Number(raw), dialogWidth)
  } catch {}
  return clampConnectRailWidth(undefined, dialogWidth)
}
function saveRailWidth(width: number): void {
  try { localStorage.setItem(railStorageKey, String(Math.round(width))) } catch {}
}

interface Props {
  initial: ProviderConnectionOptions
  initialTargetId?: string
  raise?: number
  reconnectSeq?: number
  reviewOpen?: boolean
  review?: ReactNode
  initialAutoReconnect?: ConnectionDetails['autoReconnect']
  onConnected(info: ConnectionInfo, options: ProviderConnectionOptions, autoReconnect: ConnectionDetails['autoReconnect'], attempt: ConnectionAttempt, requestId: string, signal: AbortSignal, changedDetails: readonly ConnectionDetailField[]): Promise<void>
  onClose(): void
}
type Field = { key: keyof AdvancedConnectionOptions; label: string; choices?: readonly string[]; min?: number; max?: number; boolean?: boolean; maxLength?: number }
const sections: { title: string; fields: Field[] }[] = [
  { title: 'Common', fields: [{ key: 'commandTimeout', label: 'Command timeout (seconds)', min: 0, max: 86400 }, { key: 'connectTimeout', label: 'Connect timeout (seconds)', min: 0, max: 3600 }] },
  { title: 'Always Encrypted', fields: [{ key: 'columnEncryption', label: 'Enable Always Encrypted', boolean: true }, { key: 'secureEnclaves', label: 'Enable secure enclaves', boolean: true }, { key: 'attestationProtocol', label: 'Attestation protocol', choices: ['None', 'HGS', 'AAS'] }, { key: 'enclaveAttestationUrl', label: 'Enclave attestation URL', maxLength: 2048 }] },
  { title: 'Advanced', fields: [{ key: 'multipleActiveResultSets', label: 'Multiple active result sets', boolean: true }, { key: 'networkProtocol', label: 'Network library', choices: ['default', 'tcp', 'np', 'lpc'] }, { key: 'packetSize', label: 'Packet size', min: 512, max: 32767 }, { key: 'transactionBinding', label: 'Transaction binding', choices: ['Implicit Unbind', 'Explicit Unbind'] }, { key: 'typeSystemVersion', label: 'Type system version', choices: ['Latest', 'SQL Server 2008', 'SQL Server 2005', 'SQL Server 2000'] }] },
  { title: 'Connection resiliency', fields: [{ key: 'connectRetryCount', label: 'Connect retry count', min: 0, max: 255 }, { key: 'connectRetryInterval', label: 'Connect retry interval (seconds)', min: 1, max: 60 }] },
  { title: 'Context', fields: [{ key: 'applicationName', label: 'Application name' }, { key: 'workstationId', label: 'Workstation ID' }] },
  { title: 'Initialization', fields: [{ key: 'applicationIntent', label: 'Application intent', choices: ['ReadWrite', 'ReadOnly'] }, { key: 'currentLanguage', label: 'Current language' }] },
  { title: 'Replication', fields: [{ key: 'replication', label: 'Replication', boolean: true }] },
  { title: 'Security', fields: [{ key: 'ipAddressPreference', label: 'IP address preference', choices: ['IPv4First', 'IPv6First', 'UsePlatformDefault'] }, { key: 'serverCertificate', label: 'Server certificate (file path)', maxLength: 1024 }] },
  { title: 'Source', fields: [{ key: 'attachDbFilename', label: 'Attach DB filename', maxLength: 1024 }, { key: 'failoverPartner', label: 'Failover partner', maxLength: 256 }, { key: 'failoverPartnerSpn', label: 'Failover partner SPN', maxLength: 512 }, { key: 'multiSubnetFailover', label: 'Multi subnet failover', boolean: true }, { key: 'serverSpn', label: 'Server SPN', maxLength: 512 }, { key: 'userInstance', label: 'User instance', boolean: true }] }
]

export function FailureDetails({ details }: { details: ErrorDetails }) {
  const rows = ([['Error number', details.number], ['Severity', details.class], ['State', details.state], ['Server', details.server]] as const).filter(([, value]) => value !== undefined && value !== '')
  if (!rows.length) return null
  return <details className="connect-error-details"><summary>Error details</summary><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>
}
const storageNotes: Record<NonNullable<SecretStorageState['reason']>, string> = {
  'no-keyring': 'Remember password needs a system keyring (GNOME Keyring or KWallet), and none was found. Passwords are used for this connection only.',
  'unknown-backend': 'Remember password is unavailable because the operating system could not encrypt passwords. Passwords are used for this connection only.',
  unavailable: 'Remember password is unavailable because the operating system could not encrypt passwords. Passwords are used for this connection only.'
}
const forgottenNotice = 'The saved password was rejected, so it has been removed. Enter the password.'
const userPlaceholders: Partial<Record<AuthenticationMode, string>> = {
  entraMfa: 'user@contoso.com (optional)', entraServicePrincipal: 'Application (client) ID', entraManagedIdentity: 'Client ID (blank: system-assigned)', entraDefault: 'Optional'
}
const mfaWaiting = 'Complete the sign-in in your web browser. Waiting up to 3 minutes…'
const cancelledNotice = 'Connection cancelled.'
const testCancelledNotice = 'Test cancelled.'
const settingsDroppedPassword = 'Saved to History. The saved password was for the old settings, so it was forgotten; enter it with Remember password checked and save to keep it.'
const settingsDroppedPasswordFor = 'Saved to History. The saved password was for the old login settings, so it was forgotten.'
const saveCancelledNotice = 'Save cancelled. Nothing was saved.'
const saveTitle = 'Save settings and labels to History. Opens no session.'
const keepsPassword = 'Save checks this password with the server, then remembers it.'
const dropsPassword = 'Save keeps the settings, not this password. Check Remember password to keep it.'
const forgetsTyped = 'Save keeps the settings and forgets the saved password; it does not keep this one either.'
const inUseNote = 'Save checks this password with the server, then remembers it. If it differs from the saved one, Object Explorer connections that use the saved one will need the new password entered when they next connect.'
const databasesKey = (from: ConnectionOptions) => JSON.stringify({ ...from, database: '', displayName: '', color: '', environment: '' })
const trustLabel = 'Trust server certificate and connect'
const strictCertificate = "Strict encryption always validates the server's certificate. Install a certificate this computer trusts, set Host Name in Certificate to the name the certificate was issued for, or choose Mandatory encryption and Trust server certificate."
const pinnedCertificate = "The server's certificate did not match the Server Certificate or the Host Name in Certificate set for this connection, so it was not trusted. Check that this is the server you meant and that those settings are current; Trust server certificate would skip that check."
const trustNeedsPassword = (action = 'connect') => `Trust server certificate is now checked. The saved password is kept for the old settings only, so enter the password, then ${action}.`
const choiceLabels: Record<string, string> = { default: '<default>', tcp: 'TCP/IP', np: 'Named pipes', lpc: 'Shared memory', IPv4First: 'IPv4 first', IPv6First: 'IPv6 first', UsePlatformDefault: 'Platform default' }

/** Inline SQL Server Advanced Properties tab: filterable sections applying changes live via `advancedToStore`. */
function SqlAdvancedPanel({ value, executionTimeout, locked, onChange }: { value: Partial<AdvancedConnectionOptions>; executionTimeout: number; locked: boolean; onChange(value: Partial<AdvancedConnectionOptions>): void }) {
  const [filter, setFilter] = useState('')
  const [modifiedOnly, setModifiedOnly] = useState(false)
  const edited = useRef(new Set<string>())
  const draft = useMemo(() => ({ ...advancedDefaults, ...value.commandTimeout === undefined ? { commandTimeout: '' as unknown as number } : {}, ...value }), [value])
  const count = advancedCount(value)
  const query = filter.trim().toLowerCase()
  const edit = (key: keyof AdvancedConnectionOptions, patch: Partial<AdvancedConnectionOptions>) => {
    edited.current.add(key)
    const next = { ...draft, ...patch }
    onChange(advancedToStore(next, edited.current, value))
  }
  const isFieldModified = (key: keyof AdvancedConnectionOptions) =>
    key === 'commandTimeout' ? value.commandTimeout !== undefined : value[key] !== undefined && value[key] !== advancedDefaults[key]
  const visibleSections = sections.map(section => ({
    ...section,
    fields: section.fields.filter(field => {
      if (modifiedOnly && !isFieldModified(field.key)) return false
      if (!query) return true
      return field.label.toLowerCase().includes(query) || section.title.toLowerCase().includes(query)
    })
  })).filter(section => section.fields.length > 0)

  return <div className="connect-advanced-panel">
    <div className="connect-advanced-toolbar">
      <div className="connection-filter-box connect-advanced-filter">
        <Icon name="search" className="connection-filter-icon" />
        <input className="ui-field connection-filter" aria-label="Filter advanced properties" placeholder="Filter advanced properties…" value={filter} disabled={locked} onChange={event => setFilter(event.target.value)} />
        {filter && <button type="button" className="ui-button icon-button connection-filter-clear" aria-label="Clear advanced filter" onClick={() => setFilter('')}><Icon name="close" /></button>}
      </div>
      <button type="button" className="ui-button" data-control-variant="secondary" data-control-size="dense" aria-pressed={modifiedOnly} disabled={locked} onClick={() => setModifiedOnly(current => !current)}>Modified ({count})</button>
      <button type="button" className="ui-button" data-control-variant="secondary" data-control-size="dense" disabled={locked || count === 0} onClick={() => { edited.current.clear(); onChange({}) }}>Reset</button>
    </div>
    {visibleSections.length === 0
      ? <p className="field-note">{modifiedOnly && count === 0 ? 'No advanced properties differ from their defaults.' : 'No advanced properties match your filter.'}</p>
      : visibleSections.map(section => <fieldset className="property-section" key={section.title}><legend>{section.title}</legend><div className="property-grid">{section.fields.map(field => {
        const id = 'advanced-' + field.key
        const disabled = locked || (field.key === 'secureEnclaves' && !draft.columnEncryption || ['attestationProtocol', 'enclaveAttestationUrl'].includes(field.key) && (!draft.columnEncryption || !draft.secureEnclaves) || field.key === 'enclaveAttestationUrl' && draft.attestationProtocol === 'None')
        return <div className="property-row" key={id}><label htmlFor={id}>{field.label}</label>{field.boolean || field.choices
          ? <select className="ui-field" id={id} disabled={disabled} value={String(draft[field.key])} onChange={event => edit(field.key, { [field.key]: field.boolean ? event.target.value === 'true' : event.target.value, ...(field.key === 'columnEncryption' && event.target.value === 'false' ? { secureEnclaves: false } : {}) } as Partial<AdvancedConnectionOptions>)}>{(field.boolean ? ['false', 'true'] : field.choices!).map(choice => <option key={choice} value={choice}>{field.boolean ? choice === 'true' ? 'True' : 'False' : choiceLabels[choice] ?? choice}</option>)}</select>
          : <input className="ui-field" id={id} disabled={disabled} type={field.min !== undefined ? 'number' : 'text'} min={field.min}
            {...field.key === 'commandTimeout' ? { placeholder: `${executionTimeout} (Tools › Options)`, 'aria-describedby': 'advanced-timeout-note' } : {}} max={field.max} step={field.min !== undefined ? 1 : undefined} maxLength={field.maxLength ?? 128} value={draft[field.key] as string | number} onChange={event => edit(field.key, { [field.key]: field.min !== undefined ? event.target.value === '' ? '' : Number(event.target.value) : event.target.value } as Partial<AdvancedConnectionOptions>)} />}</div>
      })}</div></fieldset>)}
    <p className="field-note" id="advanced-timeout-note">Leave Command timeout empty to use Tools › Options › Query Execution › SQL Server › General (default {executionTimeout}s). Timeout 0 means no timeout.</p>
  </div>
}

/** Renders Reset Form inside the footer only when showing over the main-window backdrop instead of a DialogWindow. */
function ConnectFooterReset({ disabled, onReset }: { readonly disabled: boolean; onReset(): void }) {
  return useDialogWindow().inWindow ? null : <button className="ui-button" data-control-variant="secondary" type="button" disabled={disabled} onClick={onReset}>Reset Form</button>
}

export default function ConnectDialog({ initial, initialTargetId, raise, reconnectSeq, reviewOpen, review, initialAutoReconnect, onConnected, onClose }: Props) {
  const { theme, platform, gestures, connections, backend, connectionReady, startupReconnect, settings, documents } = useWorkbench()
  const executionTimeout = settings.get('queryExecution.executionTimeout')
  const { active } = useServiceSnapshot(theme)
  const liveConnections = useServiceSnapshot(connections)
  const [sqlInitial] = useState<ConnectionOptions>(() => initial.provider === 'bigquery' ? connectionDefaults(platform) : initial)
  const [options, setOptions] = useState<ConnectionOptions>({ ...sqlInitial, password: '' })
  const [serverType, setServerType] = useState<ServerTypeState>({ type: initial.provider === 'bigquery' ? 'bigquery' : 'sqlserver' })
  const isBigQuery = serverType.type === 'bigquery'
  const [bigQuery, setBigQuery] = useState<BigQueryConnectionOptions>(() => initial.provider === 'bigquery' ? withoutCostPrompt(initial) : bigQueryDefaults())
  const currentBigQuery = useRef(bigQuery)
  currentBigQuery.current = bigQuery
  const [bigQueryLibrary, setBigQueryLibrary] = useState<BigQueryLibraryView>({ profiles: [] })
  const [bigQuerySelectedId, setBigQuerySelectedId] = useState<string>()
  const [pickedKeyName, setPickedKeyName] = useState<{ keyFile: string; name: string }>()
  const [sourcePrompt, setSourcePrompt] = useState<PickedKeyFile>()
  const bigQueryEdited = useRef(false)
  const bigQueryBaseline = useRef<{ readonly options: BigQueryConnectionOptions; readonly autoReconnect: ConnectionDetails['autoReconnect'] } | undefined>(undefined)
  const fresh = useRef(!initialTargetId && initialAutoReconnect === undefined && initial.provider !== 'bigquery' && shape({ ...initial, password: '' }, 'inherit') === shape(connectionDefaults(platform), 'inherit'))
  const [autoReconnect, setAutoReconnect] = useState(initial.provider === 'bigquery' ? 'inherit' : initialAutoReconnect ?? 'inherit')
  const [bigQueryReconnect, setBigQueryReconnect] = useState<ConnectionDetails['autoReconnect']>(initial.provider === 'bigquery' ? initialAutoReconnect ?? 'inherit' : 'inherit')
  const reconnectOwned = useRef(!!initialTargetId || initialAutoReconnect !== undefined)
  const [library, setLibrary] = useState<ConnectionLibrary>({ version: 1, profiles: [] })
  const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [storage, setStorage] = useState<SecretStorageState>()
  const [remember, setRemember] = useState(false)
  const rememberEdited = useRef(false)
  const [showPassword, setShowPassword] = useState(false)
  const [identity, setIdentity] = useState('Current Windows user')
  const [principal, setPrincipal] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState<string>()
  const [tab, setTab] = useState<'history' | 'browse'>('history')
  const [scope, setScope] = useState<'local' | 'network' | 'registered'>('local')
  const [filter, setFilter] = useState('')
  const [servers, setServers] = useState<DiscoveredServer[]>([])
  const [browseBusy, setBrowseBusy] = useState(false)
  const [browseNote, setBrowseNote] = useState('')
  const [pendingConnectLabel, setPendingConnectLabel] = useState<string>()
  const busy = pendingConnectLabel !== undefined
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [failure, setFailure] = useState<{ error: string; code?: ErrorCode; details?: ErrorDetails; server: string; options?: ConnectionOptions; checking?: 'test' | 'save' }>()
  const [testing, setTesting] = useState<{ kind: 'test' | 'save'; server: string }>()
  const testRequest = useRef<string | undefined>(undefined)
  const [tested, setTested] = useState<{ text: string; warning?: string }>()
  const failureBox = useRef<HTMLDivElement>(null)
  const [notice, setNotice] = useState('')
  const [lastRemoved, setLastRemoved] = useState<{ kind: 'sql'; profile: ConnectionProfile } | { kind: 'bigquery'; profile: BigQueryConnectionProfile }>()
  const [databases, setDatabases] = useState<DatabaseInfo[]>([])
  const [dbBusy, setDbBusy] = useState(false)
  const [dbNote, setDbNote] = useState('')
  const [dbDetails, setDbDetails] = useState<ErrorDetails>()
  const [properties, setProperties] = useState<'properties' | 'advanced' | 'string'>('properties')
  const [preview, setPreview] = useState('')
  const [copiedString, setCopiedString] = useState(false)
  const [pasteInput, setPasteInput] = useState('')
  const [confirmClose, setConfirmClose] = useState<{ target?: ConnectionProfile; bigQueryTarget?: BigQueryConnectionProfile; type: ProviderId }>()
  const edited = useRef(false)
  const detailFields = useRef(new Set<ConnectionDetailField>())
  const editBase = useRef<string | undefined>(undefined)
  const baseline = useRef<{ options: ConnectionOptions; autoReconnect: ConnectionDetails['autoReconnect'] } | undefined>(undefined)
  const [opened] = useState(() => shape({ ...sqlInitial, password: '' }, initialAutoReconnect ?? 'inherit'))
  const pristine = useRef(opened)
  const touched = useRef(false)
  const [dialogWidth, setDialogWidth] = useState<number>(dialogWindowKinds.connect.width)
  const [railWidth, setRailWidth] = useState(() => loadRailWidth(dialogWindowKinds.connect.width))
  const [draggingSplit, setDraggingSplit] = useState(false)
  const [resetSeq, setResetSeq] = useState(0)
  const [bigQueryAdvancedError, setBigQueryAdvancedError] = useState('')
  const prevReconnectSeq = useRef(reconnectSeq ?? 0)
  const splitterCleanup = useRef<(() => void) | undefined>(undefined)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingFavoriteFocus = useRef<string | undefined>(undefined)
  const dialog = useRef<HTMLFormElement | null>(null)
  const [formElement, setFormElement] = useState<HTMLFormElement | null>(null)
  const setDialogRef = useCallback((el: HTMLFormElement | null) => { dialog.current = el; setFormElement(el) }, [])
  const focusedInitial = useRef(false)
  const [returnFocus] = useState(focusToReturn)
  const sourcesPane = useRef<HTMLDivElement>(null)
  const filterInput = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  const currentOptions = useRef(options)
  currentOptions.current = options
  const dbRequest = useRef(0)
  const browseRequest = useRef(0)
  const dbLoadedKey = useRef('')
  const labelServer = useRef<string | null>(sqlInitial.displayName || sqlInitial.color || sqlInitial.environment ? sqlInitial.server : null)
  const selected = library.profiles.find(profile => profile.id === selectedId)
  const environmentOwner = useRef<string | null>(null)
  const ownsEnvironment = () => environmentOwner.current !== null && environmentOwner.current === currentOptions.current.server.trim().toLowerCase()
  const entryKeys = useMemo(() => new Map(library.profiles.map(profile => [profile.id, entryKey(profile.options)])), [library])
  const entry = useMemo(() => savedEntry(library.profiles, entryKeys, options, selectedId), [library, entryKeys, options, selectedId])
  const locked = busy || saving || !!testing
  const auth = authenticationCatalog[options.authentication]
  const authReady = !requiresUser(options.authentication) || !!options.username?.trim()
  const connectRequest = useRef<string | undefined>(undefined)
  const targetAttempt = useRef<ConnectionAttempt | undefined>(undefined)
  const connectAbort = useRef<AbortController | undefined>(undefined)
  const databasesRequest = useRef<string | undefined>(undefined)
  const databasesRun = useRef<Promise<void> | undefined>(undefined)
  const rejections = useRef(0)
  const stopped = useRef(new Set<string>())
  const stopButton = useRef<HTMLButtonElement>(null)
  const connectButton = useRef<HTMLButtonElement>(null)
  const saveButton = useRef<HTMLButtonElement>(null)
  const match = rememberedProfile(library.profiles, savedIds, options, selectedId)
  const rememberable = canRememberPassword(options.authentication) && !!storage?.available
  const storageNote = canRememberPassword(options.authentication) && storage && !storage.available ? storageNotes[storage.reason ?? 'unavailable'] : ''
  function showLibrary(view: ConnectionLibraryView & { bigQuery?: BigQueryLibraryView }) { setLibrary(view.library); setSavedIds(new Set(view.savedPasswords)); if (view.bigQuery) setBigQueryLibrary(view.bigQuery) }
  const bigQuerySelected = bigQueryLibrary.profiles.find(profile => profile.id === bigQuerySelectedId)
  const bigQuerySavedCostPrompt = savedCostPrompt(bigQueryLibrary.profiles, bigQuery)
  const bigQueryKeyName = bigQuery.keyFile ? pickedKeyName?.keyFile === bigQuery.keyFile ? pickedKeyName.name : bigQueryLibrary.profiles.find(profile => profile.options.keyFile === bigQuery.keyFile)?.keyFileName : undefined
  const bigQueryLists = useBigQueryLists(bigQuery, alive, isBigQuery)
  const ready = isBigQuery ? bigQueryReady(bigQuery) && !bigQueryAdvancedError : authReady

  const liveTargets = useMemo(() => {
    const profileIds = new Set<string>(), sqlKeys = new Set<string>(), bqKeys = new Set<string>()
    const liveTargetIds = new Set(liveConnections.filter(c => isLiveConnection(c) && c.targetId).map(c => c.targetId!))
    for (const target of connections.connectionTargets.getSnapshot()) {
      if (!liveTargetIds.has(target.id)) continue
      if (target.credential?.profileId) profileIds.add(target.credential.profileId)
      const k = entryKey(target.options as ProviderConnectionOptions)
      if (!k) continue
      if (isBigQueryTarget(target.options)) bqKeys.add(k)
      else sqlKeys.add(k)
    }
    return { profileIds, sqlKeys, bqKeys }
  }, [liveConnections, connections])

  function passwordRejected() {
    rejections.current++
    const binding = credentialBinding(currentOptions.current)
    setSavedIds(current => new Set([...current].filter(id => { const profile = library.profiles.find(item => item.id === id); return !!profile && credentialBinding(profile.options) !== binding })))
    setRemember(false); setNotice(forgottenNotice)
  }
  const integratedUser = principal ?? identity
  const identityOf = (authentication: AuthenticationMode) => authentication === 'windows' ? integratedUser : identity
  const authNote = options.authentication === 'entraMfa' ? 'Sign in with your web browser when you connect.'
    : options.authentication === 'entraIntegrated' && platform !== 'win32' ? 'Microsoft Entra Integrated needs Windows. On Linux and macOS use Microsoft Entra MFA or Microsoft Entra Default.' : ''
  function cancelDatabases() {
    const id = databasesRequest.current
    databasesRequest.current = undefined
    if (id) void window.varia.cancelConnectionRequests([id]).catch(() => {})
  }
  function stopTest() {
    const id = testRequest.current
    if (!id) return
    stopped.current.add(id)
    if (databasesRequest.current) { dbRequest.current++; cancelDatabases(); setDbBusy(false) }
    void window.varia.cancelConnectionRequests([id]).catch(() => {})
  }
  function stop() {
    connectAbort.current?.abort()
    if (targetAttempt.current) connections.cancelAttempt(targetAttempt.current)
    const id = connectRequest.current
    if (id) void window.varia.cancelConnectionRequests([id]).catch(() => {})
  }
  const [identityLookup] = useState(() => new IntegratedIdentityLookup(platform, () => window.varia.integratedIdentity(), value => { if (alive.current) setPrincipal(value) }))

  useEffect(() => {
    alive.current = true
    void window.varia.loadConnectionLibrary().then(result => {
      if (!alive.current) return
      const value = unwrap(result)
      showLibrary(value); setStorage(value.passwordStorage); setIdentity(value.windowsIdentity); setNotice([value.warning, value.passwordWarning].filter(Boolean).join(' ')); setLoaded(true)
      if (fresh.current && !touched.current) setServerType({ type: lastServerType(value.library.profiles, value.bigQuery.profiles) })
    }).catch(reason => { if (alive.current) { setError(message(reason)); setLoaded(true) } })
    return () => {
      alive.current = false; dbRequest.current++; browseRequest.current++
      splitterCleanup.current?.(); clearTimeout(copyTimer.current)
      cancelDatabases(); stopTest(); stop()
    }
  }, [])
  useEffect(() => {
    if (!formElement || focusedInitial.current) return
    focusedInitial.current = true
    formElement.querySelector<HTMLInputElement>(initial.provider === 'bigquery' ? '#connect-bq-project' : '#connect-server')?.focus()
  }, [formElement, initial.provider])
  useEffect(() => () => returnFocusBeside(returnFocus, '[data-connect-dialog]', () => documents.focusActive()), [returnFocus, documents])

  // Track dialog width for safe rail clamping and responsive stacking inside resized OS window.
  useEffect(() => {
    if (!formElement) return
    const updateWidth = () => {
      const next = formElement.clientWidth
      if (next > 0) setDialogWidth(next)
    }
    updateWidth()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateWidth) : undefined
    observer?.observe(formElement)
    return () => observer?.disconnect()
  }, [formElement])

  // When Reconnect is requested while the Connect OS window is already open, load the requested target cleanly.
  useEffect(() => {
    const seq = reconnectSeq ?? 0
    if (seq === prevReconnectSeq.current) return
    prevReconnectSeq.current = seq
    if (locked) return
    if (initial.provider === 'bigquery') {
      const nextBq = withoutCostPrompt(initial)
      setServerType({ type: 'bigquery' })
      setBigQuery(nextBq)
      setBigQueryReconnect(initialAutoReconnect ?? 'inherit')
      setBigQuerySelectedId(undefined)
      setBigQueryAdvancedError('')
      bigQuerySettled()
    } else {
      const nextSql: ConnectionOptions = { ...initial, password: '' }
      const nextReconnect = initialAutoReconnect ?? 'inherit'
      setServerType({ type: 'sqlserver' })
      setOptions(nextSql)
      setAutoReconnect(nextReconnect)
      reconnectOwned.current = !!initialTargetId || initialAutoReconnect !== undefined
      setSelectedId(undefined)
      rememberEdited.current = false
      setShowPassword(false)
      setBigQueryAdvancedError('')
      labelServer.current = initial.displayName || initial.color || initial.environment ? initial.server : null
      environmentOwner.current = null
      startAfresh()
      settle(nextSql, nextReconnect)
      pristine.current = shape(nextSql, nextReconnect)
      setRemember(!!rememberedProfile(library.profiles, savedIds, nextSql))
    }
    setProperties('properties')
    setError(''); setNotice(''); setTested(undefined); setFailure(undefined); setLastRemoved(undefined)
    setResetSeq(count => count + 1)
    setTimeout(() => { dialog.current?.querySelector<HTMLInputElement>(initial.provider === 'bigquery' ? '#connect-bq-project' : '#connect-server')?.focus() }, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectSeq])

  useEffect(() => { identityLookup.authenticationChanged(options.authentication) }, [identityLookup, options.authentication])
  useEffect(() => {
    if (!entry || ownsEnvironment() || entry.options.environment === currentOptions.current.environment) return
    setOptions(current => ({ ...current, environment: entry.options.environment }))
    if (entry.options.environment && labelServer.current === null) labelServer.current = entry.options.server
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id, entry?.options.environment, options.server])
  useEffect(() => {
    if (!reconnectOwned.current) setAutoReconnect(entry?.autoReconnect ?? 'inherit')
  }, [entry?.id, entry?.autoReconnect])
  useEffect(() => {
    if (busy) stopButton.current?.focus()
    else if ((dialog.current?.ownerDocument.activeElement ?? null) === stopButton.current) connectButton.current?.focus()
  }, [busy])
  // Save's password check disables Save. Focus moves to Cancel, which stops the check, at once: left to the next frame, an
  // Escape pressed meanwhile reaches the page instead of the dialog.
  const checkingSave = testing?.kind === 'save'
  useEffect(() => {
    if (checkingSave) stopButton.current?.focus()
    else if ((dialog.current?.ownerDocument.activeElement ?? null) === stopButton.current && !busy) saveButton.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkingSave])
  useKeepFocus(formElement, !!sourcePrompt || !!reviewOpen || !!confirmClose)
  useEffect(() => {
    const id = pendingFavoriteFocus.current
    if (!id || saving) return
    pendingFavoriteFocus.current = undefined
    const root = dialog.current, doc = root?.ownerDocument
    if (!root || !doc) return
    if (doc.activeElement && doc.activeElement !== doc.body && doc.activeElement !== root) return
    const button = [...root.querySelectorAll<HTMLButtonElement>('.favorite-button[data-profile-id]')].find(item => item.dataset.profileId === id)
    button?.focus({ preventScroll: true })
  }, [saving, library, bigQueryLibrary])
  useEffect(() => {
    if (!currentOptions.current.password && !rememberEdited.current) setRemember(!!match)
  }, [match?.id])
  useEffect(() => {
    dbRequest.current++; cancelDatabases(); dbLoadedKey.current = ''; setDatabases([]); setDbNote(''); setDbDetails(undefined); setDbBusy(false)
  }, [options.server, options.authentication, options.username, options.password, options.encrypt, options.trustServerCertificate, options.hostNameInCertificate, options.advanced])
  useEffect(() => {
    if (tab !== 'browse') return
    if (serverType.type === 'bigquery') { if (!bigQueryLists.projects.length && !bigQueryLists.projectsBusy) void bigQueryLists.loadProjects(); return }
    if (scope === 'registered') return
    void browse(scope)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, scope, serverType.type])
  useEffect(() => {
    if (properties !== 'string' || isBigQuery) return
    let cancelled = false
    setPreview(''); setCopiedString(false)
    const timer = setTimeout(() => {
      if (!authReady || !options.server.trim()) { setPreview('Enter a server and authentication details to preview the connection string.'); return }
      void window.varia.previewConnection(options).then(result => { if (!cancelled) setPreview(result.ok ? result.value.connectionString : result.error) }).catch(reason => { if (!cancelled) setPreview(message(reason)) })
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [properties, options, authReady, isBigQuery])

  function changeServer(server: string, patch: Partial<ConnectionOptions> = {}) {
    const inherited = labelServer.current !== null && server.trim().toLowerCase() !== labelServer.current.trim().toLowerCase()
    if (inherited) labelServer.current = null
    setSelectedId(undefined)
    update({ server, ...patch, ...(inherited ? { displayName: '', color: undefined, environment: undefined } : {}) })
    startAfresh()
  }
  function markEdited() {
    touched.current = true
    if (!edited.current) { editBase.current = (selected ?? entry)?.id; baseline.current = { options: currentOptions.current, autoReconnect } }
    edited.current = true
  }
  function settle(from: ConnectionOptions, reconnect: ConnectionDetails['autoReconnect']) { pristine.current = shape(from, reconnect); touched.current = false }
  function startAfresh() { edited.current = false; detailFields.current = new Set(); editBase.current = undefined; baseline.current = undefined }
  function editedEntry(from: ConnectionOptions = currentOptions.current): ConnectionProfile | undefined { return selected ?? (editBase.current ? baseEntry(from) : entry) }
  function baseEntry(from: ConnectionOptions = currentOptions.current): ConnectionProfile | undefined {
    const base = library.profiles.find(profile => profile.id === editBase.current)
    return base && entryKey(base.options) === entryKey(from) ? base : undefined
  }
  function update(patch: Partial<ConnectionOptions>) { markEdited(); setOptions(current => ({ ...current, ...patch })); setError(''); setNotice(''); setLastRemoved(undefined); setTested(undefined) }
  function editDetails(patch: Partial<Pick<ConnectionOptions, 'displayName' | 'color' | 'environment'>>) { labelServer.current = null; for (const field of Object.keys(patch) as ConnectionDetailField[]) detailFields.current.add(field); update(patch) }
  function choose(profile: ConnectionProfile) {
    const chosen = { ...profile.options, password: '' }
    setServerType(current => switchServerType(current, 'sqlserver')); setBigQuerySelectedId(undefined); setBigQueryAdvancedError('')
    environmentOwner.current = null; setSelectedId(profile.id); setOptions(chosen); reconnectOwned.current = true; setAutoReconnect(profile.autoReconnect ?? 'inherit')
    rememberEdited.current = false; setShowPassword(false); startAfresh(); settle(chosen, profile.autoReconnect ?? 'inherit')
    setRemember(!!rememberedProfile(library.profiles, savedIds, chosen, profile.id))
    labelServer.current = profile.options.displayName || profile.options.color || profile.options.environment ? profile.options.server : null
    setError(''); setNotice(''); setLastRemoved(undefined); setTested(undefined)
  }
  async function browse(next: 'local' | 'network') {
    const request = ++browseRequest.current
    setBrowseBusy(true); setServers([]); setBrowseNote('')
    try {
      const result = unwrap(await window.varia.discoverServers(next))
      if (!alive.current || request !== browseRequest.current) return
      setServers(result.servers); setBrowseNote(result.warning ?? '')
    } catch (reason) { if (alive.current && request === browseRequest.current) setBrowseNote(message(reason)) }
    finally { if (alive.current && request === browseRequest.current) setBrowseBusy(false) }
  }
  async function loadDatabases() {
    if (dbBusy || !authReady || !options.server.trim()) return
    const key = databasesKey(options), request = ++dbRequest.current, requestId = crypto.randomUUID()
    databasesRequest.current = requestId
    let finished!: () => void
    const run = databasesRun.current = new Promise<void>(resolve => { finished = resolve })
    setDbBusy(true); setDbNote(''); setDbDetails(undefined)
    const failed = (reason: string, details?: ErrorDetails) => {
      dbLoadedKey.current = key
      setDbNote('Could not load databases: ' + reason + ' You can enter a database name manually.'); setDbDetails(details)
    }
    try {
      const result = await window.varia.discoverDatabases(options, { ...match ? { profileId: match.id } : {}, requestId })
      if (!alive.current || request !== dbRequest.current) return
      if (!result.ok) { failed(result.error, result.details); if (result.passwordForgotten) passwordRejected(); return }
      const values = result.value
      setDatabases(values); dbLoadedKey.current = key
      setDbNote(values.length ? `${values.length} databases available.` : 'No databases are visible to this login. You can still enter a database name.')
    } catch (reason) {
      if (!alive.current || request !== dbRequest.current) return
      failed(message(reason))
    } finally {
      if (databasesRequest.current === requestId) databasesRequest.current = undefined
      if (alive.current && request === dbRequest.current) setDbBusy(false)
      if (databasesRun.current === run) databasesRun.current = undefined
      finished()
    }
  }
  function labelledOptions(from: ConnectionOptions = options): ConnectionOptions | undefined {
    const environment = parseEnvironment(from.environment)
    if (!environment.ok) {
      setError(environment.error); setProperties('properties')
      setTimeout(() => dialog.current?.querySelector<HTMLInputElement>('#connect-environment-custom')?.focus(), 0)
      return undefined
    }
    return { ...from, environment: environment.environment }
  }
  async function persist(input: ConnectionProfileInput, labelled: ConnectionOptions, id?: string) {
    const previous = input.id ? library.profiles.find(item => item.id === input.id) : library.profiles.find(item => entryKey(item.options) === entryKey(labelled))
    const value = unwrap(await window.varia.saveConnectionProfile(input))
    const saved = id ? value.library.profiles.find(item => item.id === id) : savedEntry(value.library.profiles, new Map(value.library.profiles.map(item => [item.id, entryKey(item.options)])), labelled, input.id)
    if (saved) applySavedDetails(connections, value.library.profiles, saved, previous && detailsOf(previous.options, previous.autoReconnect ?? 'inherit'))
    return { value, savedId: saved?.id }
  }
  async function saveProfile(favorite?: boolean, registered?: boolean, profile?: ConnectionProfile, how?: { labelled: ConnectionOptions; rememberPassword: boolean; forgetPassword?: boolean }): Promise<ConnectionSaveView | undefined> {
    const labelled = profile ? profile.options : how?.labelled ?? labelledOptions()
    if (!labelled) return undefined
    setSaving(true); setError(''); setNotice(''); setLastRemoved(undefined); setTested(undefined)
    try {
      const { value, savedId } = await persist({ id: profile?.id ?? editedEntry(labelled)?.id, options: labelled, favorite, registered, autoReconnect: profile ? profile.autoReconnect ?? 'inherit' : autoReconnect, ...how ? { saved: true, ...how.rememberPassword ? { rememberPassword: true } : how.forgetPassword ? { forgetPassword: true } : {} } : {} }, labelled, profile?.id)
      if (!alive.current) return value
      showLibrary(value)
      if (!profile) { setSelectedId(savedId); startAfresh(); settle(labelled, autoReconnect) }
      return value
    } catch (reason) { if (alive.current) setError(message(reason)); return undefined }
    finally { if (alive.current) setSaving(false) }
  }
  async function check(labelled: ConnectionOptions, kind: 'test' | 'save'): Promise<DatabaseInfo[] | undefined> {
    const requestId = crypto.randomUUID()
    testRequest.current = requestId
    setTesting({ kind, server: labelled.server }); setError(''); setFailure(undefined); setTested(undefined); setLastRemoved(undefined)
    setNotice(current => current === cancelledNotice || current === testCancelledNotice || current === saveCancelledNotice ? '' : current)
    try {
      if (databasesRun.current) {
        const rejected = rejections.current
        await databasesRun.current
        if (!alive.current) return undefined
        if (testRequest.current !== requestId || stopped.current.has(requestId)) { setNotice(kind === 'save' ? saveCancelledNotice : testCancelledNotice); return undefined }
        if (rejections.current !== rejected && !labelled.password) return undefined
      }
      const saved = rememberedProfile(library.profiles, savedIds, labelled, selectedId)
      const result = await window.varia.discoverDatabases(labelled, { ...saved ? { profileId: saved.id } : {}, requestId, ...kind === 'save' ? { remember: true } : {} })
      if (!alive.current) return undefined
      if (result.ok) return result.value
      if (result.code === 'CANCELLED') { setNotice(kind === 'save' ? saveCancelledNotice : testCancelledNotice); return undefined }
      setError(result.error); setFailure({ error: result.error, code: result.code, details: result.details, server: labelled.server, options: labelled, checking: kind })
      if (result.passwordForgotten) passwordRejected()
    } catch (reason) { if (alive.current) { setError(message(reason)); setFailure(undefined) } }
    finally {
      stopped.current.delete(requestId)
      if (testRequest.current === requestId) { testRequest.current = undefined; if (alive.current) setTesting(undefined) }
    }
    return undefined
  }
  async function testConnection(chosen: ConnectionOptions = options) {
    if (locked || !loaded || !authReady) return
    const labelled = labelledOptions(chosen)
    if (!labelled) return
    const values = await check(labelled, 'test')
    if (!values || !alive.current) return
    setDatabases(values); setDbNote(''); setDbDetails(undefined); dbLoadedKey.current = databasesKey(labelled)
    const login = labelled.authentication === 'windows' ? integratedUser : labelled.authentication === 'sql' || labelled.authentication === 'entraPassword' ? labelled.username : undefined
    const visible = values.length === 1 ? '1 database is visible.' : `${values.length} databases are visible.`
    const database = labelled.database.trim()
    const missing = database && !values.some(value => value.name.toLowerCase() === database.toLowerCase())
    setTested({ text: `Connected to ${labelled.server}${login ? ` as ${login}` : ''}. ${visible}`, ...missing ? { warning: `${database} is not among the databases this login can see.` } : {} })
  }
  async function save(chosen: ConnectionOptions = options): Promise<'saved' | 'warned' | false> {
    if (locked || !loaded) return false
    if (isBigQuery) return bigQueryReady(bigQuery) ? saveBigQuery(undefined, undefined, 'save') : false
    const labelled = labelledOptions(chosen)
    if (!labelled) return false
    const typed = usesPassword(labelled.authentication) && !!labelled.password
    const rememberPassword = typed && remember && rememberable
    const forgetPassword = rememberEdited.current && !remember && rememberable && !!match
    const target = editedEntry(labelled)
    const inUse = rememberPassword && passwordInUse(labelled, target?.id)
    const hadPassword = !!target && savedIds.has(target.id) && !forgetPassword && credentialBinding(target.options) !== credentialBinding(labelled)
    if (rememberPassword && !await check(labelled, 'save')) return false
    const value = await saveProfile(undefined, undefined, undefined, { labelled, rememberPassword, forgetPassword })
    if (!value || !alive.current) return value ? 'saved' : false
    if (value.passwordSaved) {
      setOptions(current => ({ ...current, password: '' })); rememberEdited.current = false; setShowPassword(false)
      setNotice(!value.passwordReplaced ? 'Saved to History. The password is remembered.' : inUse ? 'Saved to History. The new password is remembered; Object Explorer connections that used the old one will need it entered when they next connect.' : 'Saved to History. The new password is remembered.')
      return inUse && value.passwordReplaced ? 'warned' : 'saved'
    }
    if (rememberPassword) { setNotice('Saved to History, but the password could not be remembered.'); return 'warned' }
    if (hadPassword && !value.savedPasswords.includes(target!.id)) { setNotice(canRememberPassword(labelled.authentication) ? settingsDroppedPassword : settingsDroppedPasswordFor); return 'warned' }
    if (forgetPassword) {
      rememberEdited.current = false
      setNotice(!value.passwordForgotten ? 'Saved to History, but the saved password could not be removed.' : typed ? 'Saved to History. The saved password was forgotten, and the typed one was not kept.' : 'Saved to History. The saved password was forgotten.')
      return value.passwordForgotten ? 'saved' : 'warned'
    }
    if (typed) { setNotice(rememberable ? 'Saved to History. The password was not kept; check Remember password to keep it.' : 'Saved to History. The password was not kept.'); return 'saved' }
    setNotice('Saved to History.')
    return 'saved'
  }
  async function recordDetails(labelled: ConnectionOptions, reconnect: ConnectionDetails['autoReconnect'], id: string | undefined): Promise<boolean> {
    setSaving(true)
    try {
      const { value } = await persist({ id, options: { ...labelled, password: '' }, autoReconnect: reconnect }, labelled)
      if (alive.current) { showLibrary(value); startAfresh() }
      return true
    } catch { return false }
    finally { if (alive.current) setSaving(false) }
  }
  function unsaved(type: ProviderId = serverType.type): { target?: ConnectionProfile; bigQueryTarget?: BigQueryConnectionProfile } | undefined {
    if (type === 'bigquery') {
      if (!bigQueryEdited.current) return undefined
      const form = bigQueryShape(bigQuery, bigQueryReconnect, bigQuery.costPrompt ?? bigQuerySavedCostPrompt)
      const baseline = bigQueryBaseline.current
      if (baseline && form === bigQueryShape(baseline.options, baseline.autoReconnect, baseline.options.costPrompt ?? savedCostPrompt(bigQueryLibrary.profiles, baseline.options))) return undefined
      if (bigQuerySelected) return form === bigQueryShape(bigQuerySelected.options, bigQuerySelected.autoReconnect ?? 'inherit') ? undefined : { bigQueryTarget: bigQuerySelected }
      const key = bigQueryKey(bigQuery)
      if (!loaded || !key || !bigQueryReady(bigQuery) || bigQueryLibrary.profiles.some(profile => connectionKey(profile.options) === key)) return undefined
      return {}
    }
    const target = editedEntry()
    const form = shape(options, autoReconnect)
    if (target) {
      if (!edited.current || !baseline.current) return undefined
      if (form === shape(baseline.current.options, baseline.current.autoReconnect)) return undefined
      return form === shape(target.options, target.autoReconnect ?? 'inherit') ? undefined : { target }
    }
    const key = settingsKey(options)
    if (!touched.current || form === pristine.current || library.profiles.some(profile => entryKeys.get(profile.id) === key) || !loaded || !options.server.trim() || !authReady) return undefined
    return {}
  }
  function passwordInUse(from: ConnectionOptions, entryId?: string): boolean {
    const binding = credentialBinding(from)
    return connections.connectionTargets.getSnapshot().some(target => !!target.credential && (credentialBinding(target.options) === binding || target.credential.profileId === entryId))
  }
  function requestClose() {
    if (locked) return
    closeAfter(serverType.type, serverType.type === 'bigquery' ? 'sqlserver' : 'bigquery')
  }
  function closeAfter(...order: ProviderId[]) {
    for (const type of order) {
      const pending = unsaved(type)
      if (!pending) continue
      if (type !== serverType.type) setServerType(current => switchServerType(current, type))
      setConfirmClose({ ...pending, type })
      return
    }
    onClose()
  }
  function closeRest(answered: ProviderId) { closeAfter(answered === 'bigquery' ? 'sqlserver' : 'bigquery') }
  function changeServerType(next: ProviderId) {
    if (next === serverType.type) return
    touched.current = true
    setServerType(current => switchServerType(current, next))
    if (next !== 'bigquery') setBigQueryAdvancedError('')
    if (next === 'bigquery' && properties === 'string') setProperties('properties')
    setError(''); setFailure(undefined); setTested(undefined); setNotice(current => current === cancelledNotice || current === testCancelledNotice ? '' : current)
  }
  function undoServerTypeChange() {
    const back = undoServerType(serverType)
    setServerType(back)
    if (back.type !== 'bigquery') setBigQueryAdvancedError('')
    setError(''); setFailure(undefined); setTested(undefined)
    setTimeout(() => dialog.current?.querySelector<HTMLButtonElement>(`[data-server-type="${back.type}"]`)?.focus(), 0)
  }
  function bigQueryUpdate(patch: Partial<BigQueryConnectionOptions>) {
    touched.current = true
    if (!bigQueryEdited.current) bigQueryBaseline.current = { options: currentBigQuery.current, autoReconnect: bigQueryReconnect }
    bigQueryEdited.current = true
    setBigQuery(current => ({ ...current, ...patch })); setError(''); setNotice(''); setLastRemoved(undefined); setTested(undefined)
  }
  function bigQueryAuthentication(mode: BigQueryAuthenticationMode) {
    touched.current = true
    if (!bigQueryEdited.current) bigQueryBaseline.current = { options: currentBigQuery.current, autoReconnect: bigQueryReconnect }
    bigQueryEdited.current = true
    setBigQuery(current => withAuthentication(current, mode)); setError(''); setNotice(''); setLastRemoved(undefined); setTested(undefined)
  }
  function bigQuerySettled() { bigQueryEdited.current = false; bigQueryBaseline.current = undefined }
  function chooseBigQuery(profile: BigQueryConnectionProfile) {
    setServerType(current => switchServerType(current, 'bigquery'))
    if (properties === 'string') setProperties('properties')
    setBigQueryAdvancedError('')
    setBigQuery(withoutCostPrompt(profile.options)); setBigQuerySelectedId(profile.id); setSelectedId(undefined)
    setBigQueryReconnect(profile.autoReconnect ?? 'inherit'); bigQuerySettled()
    setError(''); setNotice(''); setLastRemoved(undefined); setTested(undefined); setFailure(undefined)
  }
  async function pickKeyFile() {
    const mode = currentBigQuery.current.authentication
    if (mode === 'gcloud') return
    try {
      const picked = unwrap(await window.varia.pickKeyFile(mode))
      if (!picked || !alive.current || currentBigQuery.current.authentication !== mode) return
      if (picked.source !== undefined && !picked.sourceConfirmed) { setSourcePrompt(picked); return }
      setPickedKeyName({ keyFile: picked.keyFile, name: picked.name }); bigQueryUpdate({ keyFile: picked.keyFile })
    } catch (reason) { if (alive.current) setError(message(reason)) }
  }
  async function confirmSource(picked: PickedKeyFile) {
    setSourcePrompt(undefined)
    try {
      unwrap(await window.varia.confirmFederationSource(picked.keyFile, picked.source!))
      if (!alive.current || currentBigQuery.current.authentication !== 'externalAccount') return
      setPickedKeyName({ keyFile: picked.keyFile, name: picked.name }); bigQueryUpdate({ keyFile: picked.keyFile })
    } catch (reason) { if (alive.current) setError(message(reason)) }
  }
  function bigQueryLabelled(from: BigQueryConnectionOptions = bigQuery): BigQueryConnectionOptions | undefined {
    const environment = parseEnvironment(from.environment)
    if (!environment.ok) {
      setError(environment.error); setProperties('properties')
      setTimeout(() => dialog.current?.querySelector<HTMLInputElement>('#connect-environment-custom')?.focus(), 0)
      return undefined
    }
    try { return bigQueryFormOptions({ ...from, environment: environment.environment }) } catch (reason) { setError(message(reason)); return undefined }
  }
  async function saveBigQuery(favorite?: boolean, profile?: BigQueryConnectionProfile, how?: 'save'): Promise<'saved' | false> {
    if (!profile && bigQueryAdvancedError) return false
    const labelled = profile ? profile.options : bigQueryLabelled()
    if (!labelled) return false
    setSaving(true); setError(''); setNotice(''); setLastRemoved(undefined); setTested(undefined)
    try {
      const previous = profile ?? bigQuerySelected
      const value = unwrap(await window.varia.saveConnectionProfile({ ...previous ? { id: previous.id } : {}, options: labelled, ...favorite !== undefined ? { favorite } : {}, autoReconnect: profile ? profile.autoReconnect ?? 'inherit' : bigQueryReconnect, ...how ? { saved: true } : {} }))
      if (!alive.current) return 'saved'
      showLibrary(value)
      const profiles = value.bigQuery?.profiles ?? [], key = connectionKey(labelled)
      const saved = previous ? profiles.find(item => item.id === previous.id) : profiles.find(item => connectionKey(item.options) === key)
      if (saved) applySavedDetails(connections, profiles, saved, previous && detailsOf(previous.options, previous.autoReconnect ?? 'inherit'))
      if (!profile) { setBigQuerySelectedId(saved?.id); bigQuerySettled() }
      if (how) setNotice('Saved to History.')
      return 'saved'
    } catch (reason) { if (alive.current) setError(message(reason)); return false }
    finally { if (alive.current) setSaving(false) }
  }
  async function removeBigQuery(profile: BigQueryConnectionProfile) {
    setSaving(true); setError('')
    try {
      const value = unwrap(await window.varia.removeConnectionProfile(profile.id))
      if (!alive.current) return
      showLibrary(value)
      if (bigQuerySelectedId === profile.id) { setBigQuerySelectedId(undefined); bigQuerySettled() }
      setLastRemoved({ kind: 'bigquery', profile })
      setNotice(`Removed ${profile.options.displayName || profile.options.project}.`)
    } catch (reason) { if (alive.current) setError(message(reason)) }
    finally { if (alive.current) setSaving(false) }
  }
  async function testBigQuery() {
    if (locked || !loaded || !bigQueryReady(bigQuery) || bigQueryAdvancedError) return
    const labelled = bigQueryLabelled()
    if (!labelled) return
    const requestId = crypto.randomUUID()
    testRequest.current = requestId
    setTesting({ kind: 'test', server: labelled.project }); setError(''); setFailure(undefined); setTested(undefined); setLastRemoved(undefined)
    setNotice(current => current === cancelledNotice || current === testCancelledNotice ? '' : current)
    try {
      const result = await window.varia.discoverDatabases(labelled, { requestId })
      if (!alive.current) return
      if (result.ok) {
        bigQueryLists.showDatasets(result.value)
        const account = bigQueryLists.account.state === 'ok' ? bigQueryLists.account.account : undefined
        const visible = result.value.length === 1 ? '1 dataset is visible.' : `${result.value.length} datasets are visible.`
        const missing = labelled.dataset && !result.value.some(value => value.name === labelled.dataset)
        setTested({ text: `Connected to ${labelled.project}${account ? ` (${accountText(account)})` : ''}. ${visible}`, ...missing ? { warning: `${labelled.dataset} is not among the datasets this account can see.` } : {} })
      } else if (result.code === 'CANCELLED') setNotice(testCancelledNotice)
      else { setError(result.error); setFailure({ error: result.error, code: result.code, details: result.details, server: labelled.project, checking: 'test' }) }
    } catch (reason) { if (alive.current) { setError(message(reason)); setFailure(undefined) } }
    finally {
      stopped.current.delete(requestId)
      if (testRequest.current === requestId) { testRequest.current = undefined; if (alive.current) setTesting(undefined) }
    }
  }
  async function connectBigQuery() {
    if (connectRequest.current || saving || !loaded || !bigQueryReady(bigQuery) || bigQueryAdvancedError) return
    const labelled = bigQueryLabelled()
    if (!labelled) return
    setPendingConnectLabel(connectLabel); setError(''); setTested(undefined); setLastRemoved(undefined); setNotice(current => current === cancelledNotice ? '' : current)
    const requestId = crypto.randomUUID()
    const controller = new AbortController(), foreground = startupReconnect.beginManual()
    connectAbort.current = controller
    connectRequest.current = requestId
    let attempt: ConnectionAttempt | undefined
    try {
      await connectionReady
      if (!alive.current || controller.signal.aborted) return
      const prior = initialBigQueryTarget(labelled)
      const targetId = prior && ['disconnected', 'lost'].includes(prior.lifecycle.state) ? prior.id : undefined
      if (targetId) startupReconnect.cancel(targetId)
      attempt = connections.beginConnect(labelled, liveGeneration(backend.getSnapshot().state), targetId, detailsOf(labelled, bigQueryReconnect))
      if (!attempt) { setError('This connection is already changing. Review its current state before connecting.'); return }
      targetAttempt.current = attempt
      const named = bigQuerySelected && connectionKey(bigQuerySelected.options) === connectionKey(labelled) ? bigQuerySelected : undefined
      const result = await window.varia.connect(labelled, {
        targetId: attempt.operation.targetId, mode: 'interactive', credentialIntent: 'preserve', autoReconnect: bigQueryReconnect, requestId,
        ...prior?.expectedPrincipal ? { expectedPrincipal: prior.expectedPrincipal } : {}, ...named ? { selectedProfileId: named.id } : {}
      })
      if (!alive.current) return
      if (result.ok) { bigQuerySettled(); await onConnected(result.value, labelled, bigQueryReconnect, attempt, requestId, controller.signal, []); targetAttempt.current = undefined }
      else if (result.code === 'CANCELLED') setNotice(cancelledNotice)
      else {
        connections.failAttempt(attempt, result.connectionFailure ?? 'unknown')
        setError(result.error); setFailure({ error: result.error, code: result.code, details: result.details, server: labelled.project })
      }
    } catch (reason) { if (alive.current) { setError(message(reason)); setFailure(undefined) } }
    finally {
      if (attempt && targetAttempt.current === attempt) { connections.failAttempt(attempt); targetAttempt.current = undefined }
      if (connectRequest.current === requestId) connectRequest.current = undefined
      if (connectAbort.current === controller) connectAbort.current = undefined
      foreground.dispose()
      if (alive.current) setPendingConnectLabel(undefined)
    }
  }
  function initialBigQueryTarget(value: BigQueryConnectionOptions) {
    try {
      const target = initialTargetId ? connections.connectionTargets.get(initialTargetId) : undefined
      return target && JSON.stringify(target.options) === JSON.stringify(bigQueryTargetOptions(value)) ? target : undefined
    } catch { return undefined }
  }
  async function remove(profile: ConnectionProfile) {
    setSaving(true); setError('')
    const editing = selectedId === profile.id || editedEntry()?.id === profile.id
    try {
      const value = unwrap(await window.varia.removeConnectionProfile(profile.id))
      if (alive.current) {
        showLibrary(value)
        if (selectedId === profile.id) setSelectedId(undefined)
        if (editing) { startAfresh(); settle(currentOptions.current, autoReconnect) }
        setLastRemoved({ kind: 'sql', profile })
        setNotice(`Removed ${profile.options.displayName || profile.options.server}.`)
      }
    } catch (reason) { if (alive.current) setError(message(reason)) }
    finally { if (alive.current) setSaving(false) }
  }
  async function undoRemove() {
    if (!lastRemoved || locked) return
    setSaving(true); setError('')
    try {
      if (lastRemoved.kind === 'sql') {
        const removed = lastRemoved.profile
        const value = unwrap(await window.varia.saveConnectionProfile({
          options: removed.options, favorite: removed.favorite, registered: removed.registered,
          saved: Boolean(removed.saved || !removed.favorite), autoReconnect: removed.autoReconnect ?? 'inherit'
        }))
        if (!alive.current) return
        showLibrary(value)
        const restored = savedEntry(value.library.profiles, new Map(value.library.profiles.map(p => [p.id, entryKey(p.options)])), removed.options)
        if (restored) choose(restored)
        setResetSeq(count => count + 1)
        setNotice(`Restored ${removed.options.displayName || removed.options.server}.`)
      } else {
        const removed = lastRemoved.profile
        const value = unwrap(await window.varia.saveConnectionProfile({
          options: removed.options, favorite: removed.favorite, saved: Boolean(removed.saved || !removed.favorite),
          autoReconnect: removed.autoReconnect ?? 'inherit'
        }))
        if (!alive.current) return
        showLibrary(value)
        const list = value.bigQuery?.profiles ?? []
        const key = connectionKey(removed.options)
        const restored = list.find(p => connectionKey(p.options) === key)
        if (restored) chooseBigQuery(restored)
        setResetSeq(count => count + 1)
        setNotice(`Restored ${removed.options.displayName || removed.options.project}.`)
      }
      setLastRemoved(undefined)
    } catch (reason) { if (alive.current) setError(message(reason)) }
    finally { if (alive.current) setSaving(false) }
  }
  async function connect(chosen: ConnectionOptions = options) {
    if (connectRequest.current || saving || !loaded) return
    const labelled = labelledOptions(chosen)
    if (!labelled) return
    setPendingConnectLabel(connectLabel); setError(''); setTested(undefined); setLastRemoved(undefined); setNotice(current => current === cancelledNotice ? '' : current)
    const requestId = crypto.randomUUID()
    const controller = new AbortController(), foreground = startupReconnect.beginManual()
    connectAbort.current = controller
    connectRequest.current = requestId
    const saved = chosen === options ? match : rememberedProfile(library.profiles, savedIds, chosen, selectedId)
    const named = selected ?? baseEntry(labelled) ?? savedEntry(library.profiles, entryKeys, labelled)
    const selectedProfileId = named?.id
    let attempt: ConnectionAttempt | undefined
    try {
      await connectionReady
      if (!alive.current || controller.signal.aborted) return
      const targetId = matchingTarget(labelled)
      if (targetId) startupReconnect.cancel(targetId)
      const prior = targetId ? connections.connectionTargets.get(targetId) : initialTarget(labelled)
      const credentialPolicy = canRememberPassword(labelled.authentication) && storage?.available ? remember ? 'remember' : 'forget' : 'preserve'
      const credentialIntent = prior && (labelled.password || rememberEdited.current || (credentialPolicy === 'remember' && !prior.credential) || (credentialPolicy === 'forget' && prior.credential)) ? 'update-credentials' : 'preserve'
      attempt = connections.beginConnect(labelled, liveGeneration(backend.getSnapshot().state), targetId, detailsOf(labelled, autoReconnect), credentialIntent)
      if (!attempt) { setError('This connection is already changing. Review its current state before connecting.'); return }
      targetAttempt.current = attempt
      const result = await window.varia.connect(labelled, {
        targetId: attempt.operation.targetId, mode: 'interactive', credentialIntent, credentialPolicy, autoReconnect,
        ...prior?.expectedPrincipal ? { expectedPrincipal: prior.expectedPrincipal } : {}, ...prior?.credential ? { credential: prior.credential } : {},
        ...saved ? { profileId: saved.id } : {}, ...selectedProfileId ? { selectedProfileId } : {}, remember: remember && rememberable, requestId, ...ownsEnvironment() ? { setsEnvironment: true } : {}
      })
      if (!alive.current) return
      const changedDetails = baseline.current ? changedConnectionDetails(detailsFrom(baseline.current.options, baseline.current.autoReconnect), detailsFrom(labelled, autoReconnect)).filter(field => detailFields.current.has(field)) : []
      const owner = named && entryKey(named.options) === entryKey(labelled) ? named : library.profiles.find(profile => entryKey(profile.options) === entryKey(labelled))
      const pick = <K extends 'displayName' | 'color' | 'environment'>(field: K, value: ConnectionOptions[K]) => owner && !changedDetails.includes(field) ? owner.options[field] : value
      const environment = ownsEnvironment() ? labelled.environment : labelled.environment ?? (result.ok ? result.value.environment : undefined)
      const record = changedDetails.length ? { ...labelled, displayName: pick('displayName', labelled.displayName), color: pick('color', labelled.color), environment: pick('environment', environment) } : undefined
      const recordReconnect = owner && changedDetails.length && !changedDetails.includes('autoReconnect') ? owner.autoReconnect ?? 'inherit' : autoReconnect
      const recorded = !result.ok || !record || controller.signal.aborted || await recordDetails(record, recordReconnect, owner?.id)
      if (result.ok) {
        setShowPassword(false)
        const { environment: kept, ...connected } = result.value, info = recorded ? connected : { ...connected, historyWarning: connected.historyWarning ?? historyNotSaved }
        await onConnected(info, record ? { ...record, password: '' } : { ...labelled, password: '', environment: labelled.environment ?? kept }, record ? recordReconnect : autoReconnect, attempt, requestId, controller.signal, changedDetails)
        targetAttempt.current = undefined
      } else if (result.code === 'CANCELLED') setNotice(cancelledNotice)
      else {
        connections.failAttempt(attempt, result.connectionFailure ?? 'unknown')
        setError(result.error); setFailure({ error: result.error, code: result.code, details: result.details, server: chosen.server, options: chosen })
        if (result.passwordForgotten) passwordRejected()
      }
    } catch (reason) { if (alive.current) { setError(message(reason)); setFailure(undefined) } }
    finally {
      if (attempt && targetAttempt.current === attempt) { connections.failAttempt(attempt); targetAttempt.current = undefined }
      if (connectRequest.current === requestId) connectRequest.current = undefined
      if (connectAbort.current === controller) connectAbort.current = undefined
      foreground.dispose()
      if (alive.current) setPendingConnectLabel(undefined)
    }
  }
  function matchingTarget(value: ConnectionOptions): string | undefined {
    try {
      const encoded = JSON.stringify(connectionTargetOptions(value))
      const target = initialTarget(value)
      if (target && ['disconnected', 'lost'].includes(target.lifecycle.state)) return target.id
      if (value.password) return
      const saved = rememberedProfile(library.profiles, savedIds, value, selectedId)
      if (!saved) return
      const candidates = connections.connectionTargets.getSnapshot().filter(candidate => ['disconnected', 'lost'].includes(candidate.lifecycle.state)
        && candidate.credential?.profileId === saved.id && JSON.stringify(candidate.options) === encoded)
      if (candidates.length === 1) return candidates[0].id
    } catch {}
  }
  function initialTarget(value: ConnectionOptions) {
    try {
      const target = initialTargetId ? connections.connectionTargets.get(initialTargetId) : undefined
      return target && JSON.stringify(target.options) === JSON.stringify(connectionTargetOptions(value)) ? target : undefined
    } catch { return undefined }
  }
  function trustAndRetry(kind?: 'test' | 'save') {
    const next = { ...options, trustServerCertificate: true }
    markEdited()
    setOptions(next)
    if (usesPassword(next.authentication) && !next.password && match && rememberedProfile(library.profiles, savedIds, next, selectedId)?.id !== match.id) {
      setError(''); setNotice(trustNeedsPassword(kind === 'test' ? 'test the connection' : kind === 'save' ? 'save' : 'connect'))
      dialog.current?.querySelector<HTMLInputElement>('#connect-password')?.focus()
      return
    }
    if (kind === 'test') void testConnection(next)
    else if (kind === 'save') void save(next)
    else void connect(next)
  }
  const shownFailure = error && failure?.error === error ? failure : undefined
  const fix = shownFailure?.options && connectFix(shownFailure.options, shownFailure.details)
  const retry = shownFailure?.checking
  const fixActions: ErrorAction[] = fix === 'trust' ? [{ label: retry === 'test' ? 'Trust server certificate and test' : retry === 'save' ? 'Trust server certificate and save' : trustLabel, run: () => trustAndRetry(retry) }] : []
  useEffect(() => { if (error) failureBox.current?.scrollIntoView({ block: 'nearest' }) }, [error])
  const matches = (text: string) => text.toLowerCase().includes(filter.toLowerCase())
  const filtered = library.profiles.filter(profile => matches([profile.options.displayName, profile.options.server, profile.options.database, profile.options.username].join(' ')))
  const rows: HistoryRow[] = [...filtered.map(sql => ({ sql })), ...bigQueryLibrary.profiles.filter(profile => matches(bigQueryRowText(profile))).map(profile => ({ bigQuery: profile }))]
  const entryOf = (row: HistoryRow) => 'sql' in row ? row.sql : row.bigQuery
  // Deduplicate Favorites out of Recent Connections so each server appears in one list and highlights once.
  const favorite = rows.filter(row => entryOf(row).favorite)
  const recent = rows.filter(row => entryOf(row).lastConnected && !entryOf(row).favorite).sort((a, b) => rowTime(b).localeCompare(rowTime(a)))
  const savedOnly = rows.filter(row => entryOf(row).saved && !entryOf(row).lastConnected && !entryOf(row).favorite)
  const labelled = isBigQuery ? bigQuery : options
  const sqlAdvCount = advancedCount(options.advanced)
  const bqAdvCount = bigQueryAdvancedCount({ ...bigQuery, costPrompt: bigQuery.costPrompt ?? bigQuerySavedCostPrompt })
  const advBadgeCount = isBigQuery ? bqAdvCount : sqlAdvCount
  const advSummaryText = isBigQuery ? bigQueryAdvancedSummary({ ...bigQuery, costPrompt: bigQuery.costPrompt ?? bigQuerySavedCostPrompt }) : advancedSummary(options.advanced)
  const passwordShown = usesPassword(options.authentication)
  const passwordFromKeyring = !options.password && !!match
  const labelEdit = (patch: Partial<Pick<ConnectionOptions, 'displayName' | 'color' | 'environment'>>) => { if (isBigQuery) bigQueryUpdate(patch); else editDetails(patch) }

  function reset() {
    setError(''); setTested(undefined); setFailure(undefined); setLastRemoved(undefined); setBigQueryAdvancedError('')
    setResetSeq(count => count + 1)
    if (isBigQuery) { setBigQuerySelectedId(undefined); setBigQuery(bigQueryDefaults()); setBigQueryReconnect('inherit'); bigQuerySettled(); return }
    reconnectOwned.current = true; setAutoReconnect('inherit'); setSelectedId(undefined); rememberEdited.current = false; setShowPassword(false); startAfresh(); settle(connectionDefaults(platform), 'inherit'); labelServer.current = null; environmentOwner.current = null; setOptions(connectionDefaults(platform))
  }
  const maxRailWidth = Math.max(connectRailLimits.minWidth, Math.min(connectRailLimits.maxWidth, Math.round(dialogWidth) - connectRailLimits.minFormWidth))
  function startSplitterDrag(event: React.MouseEvent<HTMLDivElement>) {
    if (locked) return
    event.preventDefault()
    splitterCleanup.current?.()
    const doc = dialog.current?.ownerDocument ?? document, win = doc.defaultView
    const startX = event.clientX, startWidth = effectiveRailWidth
    let current = startWidth
    setDraggingSplit(true)
    const onMove = (ev: MouseEvent) => {
      current = Math.max(connectRailLimits.minWidth, Math.min(maxRailWidth, Math.round(startWidth + (ev.clientX - startX))))
      setRailWidth(current)
    }
    const teardown = () => {
      doc.removeEventListener('mousemove', onMove)
      doc.removeEventListener('mouseup', onUp)
      win?.removeEventListener('blur', onUp)
      if (splitterCleanup.current === teardown) splitterCleanup.current = undefined
    }
    const onUp = () => {
      teardown()
      if (alive.current) { setDraggingSplit(false); saveRailWidth(current) }
    }
    splitterCleanup.current = teardown
    doc.addEventListener('mousemove', onMove)
    doc.addEventListener('mouseup', onUp)
    win?.addEventListener('blur', onUp)
  }
  function splitterKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (locked || event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const delta = event.key === 'ArrowLeft' ? -16 : 16
      const next = clampConnectRailWidth(effectiveRailWidth + delta, dialogWidth)
      setRailWidth(next); saveRailWidth(next)
    } else if (event.key === 'Home') {
      event.preventDefault()
      const next = clampConnectRailWidth(connectRailLimits.defaultWidth, dialogWidth)
      setRailWidth(next); saveRailWidth(next)
    }
  }
  function profileRows(entries: readonly HistoryRow[], empty: string) {
    const keyDown = (event: KeyboardEvent<HTMLButtonElement>, row: HistoryRow) => {
      if (event.key !== 'Enter' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return
      event.preventDefault()
      if (locked || event.repeat) return
      flushSync(() => { if ('sql' in row) choose(row.sql); else chooseBigQuery(row.bigQuery) })
      connectButton.current?.click()
    }
    return entries.length ? entries.map(row => 'bigQuery' in row ? bigQueryRow(row.bigQuery, keyDown) : sqlRow(row.sql, keyDown)) : <p className="connection-empty">{empty}</p>
  }
  function bigQueryRow(profile: BigQueryConnectionProfile, keyDown: (event: KeyboardEvent<HTMLButtonElement>, row: HistoryRow) => void) {
    const name = profile.options.displayName || profile.options.project
    const connectedLive = liveTargets.profileIds.has(profile.id) || (() => { try { return liveTargets.bqKeys.has(connectionKey(profile.options)) } catch { return false } })()
    return <div key={profile.id} className={'connection-list-row' + (bigQuerySelectedId === profile.id && isBigQuery ? ' selected' : '')}>
      <button type="button" className="connection-choice" disabled={locked} onClick={() => chooseBigQuery(profile)} onKeyDown={event => keyDown(event, { bigQuery: profile })} onDoubleClick={event => { if (gestures.matches('connections.connect', event)) connectButton.current?.click() }} title={[profile.options.displayName, `${profile.options.project} · ${profile.options.dataset || '<no default dataset>'}`].filter(Boolean).join('\n')}>
        <span className="connection-swatch" style={{ backgroundColor: theme.accent(profile.options.color) ?? 'var(--varia-connection-default)' }} />
        <Icon name="bigquery" />
        <span>
          <span className="connection-choice-title">{connectedLive && <span className="connect-live-dot" title="Connected in Object Explorer" aria-hidden="true" />}<strong>{name}</strong><EnvironmentTag environment={profile.options.environment} place="list" /></span>
          <small>{profile.options.displayName ? profile.options.project + ' · ' : ''}{bigQueryRowDetail(profile)}</small>
        </span>
      </button>
      <span className="connection-row-actions">
        <button type="button" className="ui-button icon-button favorite-button" data-profile-id={profile.id} aria-label={`${profile.favorite ? 'Unfavorite' : 'Favorite'} ${name}`} title={profile.favorite ? 'Remove from favorites' : 'Add to favorites'} disabled={locked} onClick={() => { pendingFavoriteFocus.current = profile.id; void saveBigQuery(!profile.favorite, profile) }}><Icon name={profile.favorite ? 'star-full' : 'star-empty'} /></button>
        <button type="button" className="ui-button icon-button" aria-label={`Remove saved ${name}`} title="Remove saved connection" disabled={locked} onClick={() => void removeBigQuery(profile)}><Icon name="close" /></button>
      </span>
    </div>
  }
  function sqlRow(profile: ConnectionProfile, keyDown: (event: KeyboardEvent<HTMLButtonElement>, row: HistoryRow) => void) {
    const k = entryKeys.get(profile.id)
    const connectedLive = liveTargets.profileIds.has(profile.id) || (!!k && liveTargets.sqlKeys.has(k))
    const name = profile.options.displayName || profile.options.server
    const detail = [profile.options.displayName ? profile.options.server : '', profile.options.database || '', showsIdentity(profile.options.authentication) ? identityOf(profile.options.authentication) : profile.options.username ?? ''].filter(Boolean).join(' · ')
    return <div key={profile.id} className={'connection-list-row' + (selectedId === profile.id && !isBigQuery ? ' selected' : '')}>
      <button type="button" className="connection-choice" disabled={locked} onClick={() => choose(profile)} onKeyDown={event => keyDown(event, { sql: profile })} onDoubleClick={event => { if (gestures.matches('connections.connect', event)) connectButton.current?.click() }} title={rowTitle(profile.options)}>
        <span className="connection-swatch" style={{ backgroundColor: theme.accent(profile.options.color) ?? 'var(--varia-connection-default)' }} />
        <Icon name="server" />
        <span>
          <span className="connection-choice-title">{connectedLive && <span className="connect-live-dot" title="Connected in Object Explorer" aria-hidden="true" />}<strong>{name}</strong><EnvironmentTag environment={profile.options.environment} place="list" /></span>
          <small>{detail}</small>
        </span>
      </button>
      <span className="connection-row-actions">
        <button type="button" className="ui-button icon-button favorite-button" data-profile-id={profile.id} aria-label={`${profile.favorite ? 'Unfavorite' : 'Favorite'} ${name}`} title={profile.favorite ? 'Remove from favorites' : 'Add to favorites'} disabled={locked} onClick={() => { pendingFavoriteFocus.current = profile.id; void saveProfile(!profile.favorite, undefined, profile) }}><Icon name={profile.favorite ? 'star-full' : 'star-empty'} /></button>
        <button type="button" className="ui-button icon-button" aria-label={`Remove saved ${name}`} title="Remove saved connection" disabled={locked} onClick={() => void remove(profile)}><Icon name="close" /></button>
      </span>
    </div>
  }
  function sourcesKey(event: KeyboardEvent<HTMLDivElement>) {
    const rows = [...sourcesPane.current?.querySelectorAll<HTMLButtonElement>('.connection-choice, .discovered-server') ?? []].filter(row => !row.disabled && row.getClientRects().length > 0)
    const fromFilter = event.target === filterInput.current
    const current = fromFilter ? -1 : rows.indexOf(event.target as HTMLButtonElement)
    if (!fromFilter && current < 0) return
    const next = listStep(current, rows.length, event.key, event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing)
    if (next === undefined) return
    event.preventDefault()
    if (next < 0) filterInput.current?.focus()
    else rows[next].focus()
  }
  function trap(event: KeyboardEvent<HTMLFormElement>) {
    if (sourcePrompt || confirmClose || reviewOpen) return
    if (event.key === 'Enter' && event.repeat) { event.preventDefault(); return }
    if (closesDialogWindow(event, platform)) {
      event.preventDefault(); event.stopPropagation()
      if (testing) stopTest()
      else if (busy) { if (!saving) stop() }
      else requestClose()
      return
    }
    if (event.key === 'Escape' && testing) { event.preventDefault(); event.stopPropagation(); stopTest() }
    else if (event.key === 'Escape' && busy) { event.preventDefault(); event.stopPropagation(); if (!saving) stop() }
    else if (event.key === 'Escape' && !locked) { event.preventDefault(); event.stopPropagation(); requestClose() }
    trapFocus(event)
  }
  function applyParsedString() {
    const parsed = parseConnectionString(pasteInput)
    if (parsed.matchedCount === 0) {
      setError('')
      setNotice('No recognized connection string settings were found.')
      return
    }
    const { server, ...rest } = parsed.patch
    const mergedAdvanced = Object.keys(parsed.advancedPatch).length ? { ...options.advanced, ...parsed.advancedPatch } : undefined
    const patch: Partial<ConnectionOptions> = { ...rest, password: '', ...(mergedAdvanced ? { advanced: mergedAdvanced } : {}) }
    if (server !== undefined && server !== options.server || rest.authentication !== undefined && rest.authentication !== options.authentication) {
      rememberEdited.current = false
    }
    setShowPassword(false)
    setResetSeq(count => count + 1)
    if (server !== undefined && server !== options.server) changeServer(server, patch)
    else update(patch)
    setNotice(`Applied ${parsed.matchedCount} setting${parsed.matchedCount === 1 ? '' : 's'} from connection string.${parsed.passwordOmitted ? ' Password was omitted for security.' : ''}`)
  }
  const copyPreview = () => {
    if (!preview) return
    clearTimeout(copyTimer.current)
    void window.varia.writeClipboardText(preview).then(result => {
      if (!alive.current) return
      if (result.ok) {
        setCopiedString(true)
        copyTimer.current = setTimeout(() => { if (alive.current) setCopiedString(false) }, 2000)
      } else {
        setNotice('Could not copy connection string.')
      }
    }, () => { if (alive.current) setNotice('Could not copy connection string.') })
  }

  const effectiveRailWidth = clampConnectRailWidth(railWidth, dialogWidth)
  const connectLabel = !isBigQuery && matchingTarget(options) && (options.password || rememberEdited.current) ? 'Update Credentials and Reconnect' : 'Connect'
  const formStyle = { '--connect-rail-width': `${effectiveRailWidth}px` } as React.CSSProperties

  return <DialogWindow kind="connect" onClose={requestClose} raise={raise}>
    <form ref={setDialogRef} data-connect-dialog style={formStyle} className={'connection-modal connect-dialog' + (dialogWidth < connectRailLimits.stackBelow ? ' is-stacked' : '')} role="dialog" aria-labelledby="connect-title" aria-modal={reviewOpen ? undefined : 'true'} aria-hidden={reviewOpen || undefined} tabIndex={-1} inert={!!sourcePrompt || reviewOpen || !!confirmClose} onSubmit={(event: FormEvent) => { event.preventDefault(); if (isBigQuery) void connectBigQuery(); else void connect() }} onKeyDown={trap}>
      <DialogHeading id="connect-title" title="Connect" closeLabel="Close connection dialog" disabled={locked} onClose={requestClose} />
      <div className="connect-panes">
        <div ref={sourcesPane} className="connect-sources-pane" onKeyDown={sourcesKey}>
          <div className="connect-sources-top">
            <div className="connection-tabs" role="tablist" aria-label="Connection sources">{(['history', 'browse'] as const).map(value => <button type="button" className="ui-button" role="tab" key={value} aria-selected={tab === value} aria-controls="connection-sources" disabled={locked} onClick={() => setTab(value)}>{value === 'history' ? 'History' : 'Browse'}</button>)}</div>
            <button type="button" className="ui-button" data-control-variant="secondary" data-control-size="dense" disabled={locked} title="Clear form for a new connection" onClick={reset}>Reset</button>
          </div>
          <div className="connection-filter-box">
            <Icon name="search" className="connection-filter-icon" />
            <input className="ui-field connection-filter" ref={filterInput} aria-label="Filter connections" placeholder="Filter connections" maxLength={256} value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} />
            {filter && <button type="button" className="ui-button icon-button connection-filter-clear" aria-label="Clear filter" onClick={() => { setFilter(''); filterInput.current?.focus() }}><Icon name="close" /></button>}
          </div>
          <div id="connection-sources" className="connection-sources" role="tabpanel" aria-label={tab === 'history' ? 'History' : 'Browse'}>
            {!loaded && <p className="connection-empty">Loading saved connections…</p>}
            {tab === 'browse' && isBigQuery ? <>
              <div className="browse-toolbar"><span>Google Cloud projects</span><button className="ui-button" data-control-variant="secondary" type="button" disabled={bigQueryLists.projectsBusy || locked || !bigQueryReady(bigQuery) && !bigQueryCredentialReady(bigQuery)} onClick={() => void bigQueryLists.loadProjects()}>Refresh</button></div>
              {bigQueryLists.projectsBusy && <p className="connection-empty">Loading projects…</p>}
              {bigQueryLists.projects.filter(project => matches(`${project.id} ${project.friendlyName ?? ''}`)).map(project => <button type="button" className="discovered-server" disabled={locked} key={project.id} onClick={() => { bigQueryUpdate({ project: project.id, ...project.id !== bigQuery.project ? { dataset: undefined } : {} }); setBigQuerySelectedId(undefined) }}><Icon name="project" /><span>{project.id}</span><small>{project.friendlyName}</small></button>)}
              {!bigQueryLists.projectsBusy && !bigQueryLists.projects.length && <p className="connection-empty">{bigQueryCredentialReady(bigQuery) ? 'No projects listed. You can type a project id.' : 'Choose the credential to list its projects.'}</p>}
              {bigQueryLists.projectsNote && <p className="field-note">{bigQueryLists.projectsNote}</p>}
              {bigQueryLists.account.state === 'ok' && bigQueryLists.projects.length > 0 && <p className="field-note">Projects visible to {bigQueryLists.account.account.account}.</p>}
            </> : tab === 'history' ? <><details open><summary>Favorites ({favorite.length})</summary>{profileRows(favorite, 'No favorite connections')}</details>{savedOnly.length > 0 && <details open><summary>Saved ({savedOnly.length})</summary>{profileRows(savedOnly, '')}</details>}<details open><summary>Recent Connections ({recent.length})</summary>{profileRows(recent, 'No recent connections')}</details></> : <>
              <div className="browse-toolbar"><label htmlFor="browse-scope">Server source</label><select className="ui-field" id="browse-scope" value={scope} disabled={locked} onChange={event => { browseRequest.current++; setBrowseBusy(false); setBrowseNote(''); setScope(event.target.value as typeof scope) }}><option value="local">Local</option><option value="network">Network</option><option value="registered">Registered Servers</option></select>{scope !== 'registered' && <button className="ui-button" data-control-variant="secondary" type="button" disabled={browseBusy || locked} onClick={() => void browse(scope)}>Refresh</button>}</div>
              {scope === 'registered' ? <>{profileRows(filtered.filter(profile => profile.registered).map(sql => ({ sql })), 'No registered servers. Use Register server to add one.')}<p className="field-note">Registered servers are saved in Varia on this computer.</p></> : <>
                {browseBusy && <p className="connection-empty">Discovering {scope} servers…</p>}
                {servers.filter(server => matches(server.server)).map(server => <button type="button" className="discovered-server" disabled={locked} key={server.server} onClick={() => changeServer(server.server, { database: '', password: '', displayName: '' })}><Icon name="server" /><span>{server.server}</span><small>{server.version}</small></button>)}
                {!browseBusy && !servers.length && <p className="connection-empty">No servers found. You can type a server name.</p>}
                {browseNote && <p className="field-note">{browseNote}</p>}
              </>}
            </>}
          </div>
        </div>
        <div className={'connect-splitter' + (draggingSplit ? ' is-dragging' : '')} role="separator" aria-orientation="vertical" aria-label="Resize saved connections list" aria-valuenow={effectiveRailWidth} aria-valuemin={connectRailLimits.minWidth} aria-valuemax={maxRailWidth} tabIndex={0} onMouseDown={startSplitterDrag} onKeyDown={splitterKeyDown} onDoubleClick={() => { setRailWidth(connectRailLimits.defaultWidth); saveRailWidth(connectRailLimits.defaultWidth) }} />
        <div className="connect-form-pane">
          <div className="connect-form-header">
            <div className="connect-engine-row">
              <div className="connect-engine-switch" role="group" aria-label="Server type">
                {(['sqlserver', 'bigquery'] as const).map(type => <button key={type} type="button" data-server-type={type} className="ui-button" data-control-size="dense" aria-pressed={serverType.type === type} disabled={locked} onClick={() => changeServerType(type)}>{serverTypeLabels[type]}</button>)}
              </div>
              <div className="connect-header-actions">
                {isBigQuery
                  ? <button className="ui-button" data-control-variant="secondary" data-control-size="dense" type="button" disabled={locked || !loaded || !ready} onClick={() => void saveBigQuery(!bigQuerySelected?.favorite)}><Icon name={bigQuerySelected?.favorite ? 'star-full' : 'star-empty'} />{bigQuerySelected?.favorite ? 'Remove favorite' : 'Add favorite'}</button>
                  : <>
                      <button className="ui-button" data-control-variant="secondary" data-control-size="dense" type="button" disabled={locked || !loaded || !authReady} onClick={() => void saveProfile(!selected?.favorite)}><Icon name={selected?.favorite ? 'star-full' : 'star-empty'} />{selected?.favorite ? 'Remove favorite' : 'Add favorite'}</button>
                      <button className="ui-button" data-control-variant="secondary" data-control-size="dense" type="button" disabled={locked || !loaded || !authReady} onClick={() => void saveProfile(undefined, !selected?.registered)}>{selected?.registered ? 'Unregister server' : 'Register server'}</button>
                    </>}
              </div>
            </div>
            {serverType.previous && <p className="field-note" role="status">Server type changed to {serverTypeLabels[serverType.type]}; the {serverTypeLabels[serverType.previous]} fields are kept. <button type="button" className="ui-button connect-inline-action" data-control-size="dense" disabled={locked} onClick={undoServerTypeChange}>Undo</button></p>}
            <div className="connection-tabs connection-property-tabs" role="tablist" aria-label="Connection details">
              <button type="button" className="ui-button" role="tab" aria-selected={properties === 'properties'} aria-controls="connection-properties" onClick={() => setProperties('properties')}>Connection Properties</button>
              <button type="button" className="ui-button" role="tab" aria-selected={properties === 'advanced'} aria-controls="connection-properties" aria-label={advSummaryText ? `Advanced (${advBadgeCount} set)` : 'Advanced'} onClick={() => setProperties('advanced')}>Advanced{advBadgeCount > 0 && <span className="connect-tab-badge" aria-hidden="true">{advBadgeCount}</span>}</button>
              {!isBigQuery && <button type="button" className="ui-button" role="tab" aria-selected={properties === 'string'} aria-controls="connection-properties" onClick={() => setProperties('string')}>Connection String</button>}
            </div>
          </div>
          <div className="connect-form-scroll">
            <div id="connection-properties" role="tabpanel" aria-label={properties === 'properties' ? 'Connection Properties' : properties === 'advanced' ? 'Advanced Properties' : 'Connection String'}>
              {properties === 'properties' && <>
                <div className="property-grid">
                  {isBigQuery ? <BigQueryConnectFields options={bigQuery} keyFileName={bigQueryKeyName} locked={locked} lists={bigQueryLists} onChange={bigQueryUpdate} onAuthentication={bigQueryAuthentication} onBrowseKeyFile={() => void pickKeyFile()} /> : <>
                    <div className="property-row"><label htmlFor="connect-server">Server Name</label><input className="ui-field" id="connect-server" list="known-servers" required maxLength={256} disabled={locked} value={options.server} placeholder="localhost,1433 or server\instance" onChange={event => changeServer(event.target.value)} /><datalist id="known-servers">{[...new Set(library.profiles.map(profile => profile.options.server))].map(server => <option key={server} value={server} />)}</datalist></div>
                    <div className="property-row"><label htmlFor="connect-auth">Authentication</label><select className="ui-field" id="connect-auth" value={options.authentication} disabled={locked} onChange={event => update({ authentication: event.target.value as AuthenticationMode, password: '' })}>{authenticationModes.map(mode => <option key={mode} value={mode}>{authenticationCatalog[mode].label}</option>)}</select></div>
                    <div className="property-row"><label htmlFor="connect-user">{auth.userLabel}</label><input className="ui-field" id="connect-user" required={requiresUser(options.authentication)} disabled={locked || showsIdentity(options.authentication)} autoComplete="off" maxLength={128} placeholder={userPlaceholders[options.authentication]} value={showsIdentity(options.authentication) ? identityOf(options.authentication) : options.username ?? ''} onChange={event => update({ username: event.target.value })} /></div>
                    {passwordShown && <>
                      <div className="property-row">
                        <label htmlFor="connect-password">Password</label>
                        <div className="property-input-action">
                          <input className="ui-field" id="connect-password" type={showPassword && !!options.password ? 'text' : 'password'} autoComplete="off" disabled={locked} maxLength={1024} value={options.password ?? ''} {...match && !options.password ? { placeholder: '••••••••', 'aria-describedby': 'connect-password-saved' } : {}} onChange={event => { if (!event.target.value) setShowPassword(false); update({ password: event.target.value }) }} />
                          {!!options.password && <button type="button" className="ui-button icon-button" data-control-variant="secondary" aria-label={showPassword ? 'Hide password' : 'Show password'} title={showPassword ? 'Hide password' : 'Show password'} disabled={locked} onClick={() => setShowPassword(current => !current)}><Icon name="eye" /></button>}
                        </div>
                        {match && !options.password && <span id="connect-password-saved" className="visually-hidden">A saved password will be used. Type to replace it.</span>}
                      </div>
                      {passwordFromKeyring && <div className="property-row"><span /><span className="connect-pw-saved"><Icon name="lock" />Saved in system keyring (leave empty to keep using)</span></div>}
                      {options.password && rememberable && <div className="property-row"><span /><p className="field-note" id="connect-password-save-note">{!remember ? match && rememberEdited.current ? forgetsTyped : dropsPassword : passwordInUse(options) ? inUseNote : keepsPassword}</p></div>}
                      {!options.password && match && rememberable && !remember && rememberEdited.current && <div className="property-row"><span /><p className="field-note" id="connect-password-forget-note">Save or Connect forgets the saved password.</p></div>}
                      <div className="property-row"><span /><label className="checkbox-label"><input type="checkbox" checked={remember && rememberable} disabled={locked || !rememberable} {...storageNote ? { 'aria-describedby': 'connect-remember-note' } : {}} onChange={event => { rememberEdited.current = true; setRemember(event.target.checked) }} />Remember password</label></div>
                      {storageNote && <div className="property-row"><span /><p className="field-note" id="connect-remember-note">{storageNote}</p></div>}
                    </>}
                    {authNote && <div className="property-row"><span /><p className="field-note" id="connect-auth-note">{authNote}</p></div>}
                    <div className="property-row"><label htmlFor="connect-database">Database Name</label><div className="property-input-action"><input className="ui-field" id="connect-database" list="available-databases" maxLength={128} disabled={locked} placeholder="<default>" value={options.database} onFocus={() => { if (dbLoadedKey.current !== databasesKey(currentOptions.current)) void loadDatabases() }} onChange={event => update({ database: event.target.value })} /><button className="ui-button icon-button" data-control-variant="secondary" type="button" aria-label="Load databases" title="Load databases from this server" disabled={locked || dbBusy || !authReady} onClick={() => void loadDatabases()}><Icon name={dbBusy ? 'loading' : 'refresh'} spin={dbBusy} /></button></div><datalist id="available-databases"><option value="" label="<default>" />{databases.map(database => <option key={database.name} value={database.name} />)}</datalist></div>
                    {(dbBusy || dbNote) && <div className="property-row"><span /><div><p className="field-note" role="status">{dbBusy ? 'Loading databases…' : dbNote}</p>{!dbBusy && dbDetails && <FailureDetails details={dbDetails} />}</div></div>}
                    <fieldset className="property-section connect-security-group">
                      <legend>TLS &amp; Certificate Security</legend>
                      <div className="property-grid">
                        <div className="property-row"><label htmlFor="connect-encrypt">Encrypt</label><select className="ui-field" id="connect-encrypt" value={options.encrypt ?? 'mandatory'} disabled={locked} onChange={event => update({ encrypt: event.target.value as ConnectionOptions['encrypt'] })}><option value="optional">Optional</option><option value="mandatory">Mandatory</option><option value="strict">Strict</option></select></div>
                        <div className="property-row"><span /><label className="checkbox-label"><input type="checkbox" checked={options.encrypt !== 'strict' && options.trustServerCertificate} disabled={locked || options.encrypt === 'strict'} onChange={event => update({ trustServerCertificate: event.target.checked })} />Trust server certificate</label></div>
                        <div className="property-row"><label htmlFor="connect-hostname">Host Name in Certificate</label><input className="ui-field" id="connect-hostname" maxLength={256} disabled={locked} value={options.hostNameInCertificate ?? ''} onChange={event => update({ hostNameInCertificate: event.target.value })} /></div>
                      </div>
                    </fieldset>
                  </>}
                </div>
                <fieldset id="connect-custom" className="property-section custom-properties" aria-label="Labels & Custom Properties">
                  <legend>Labels &amp; Custom Properties</legend>
                  <div className="property-grid">
                    <div className="property-row"><label htmlFor="connect-name">Name</label><input className="ui-field" id="connect-name" maxLength={128} disabled={locked} value={labelled.displayName ?? ''} placeholder="Optional connection name" onChange={event => labelEdit({ displayName: event.target.value })} /></div>
                    <div className="property-row">
                      <label htmlFor="connect-color-custom">Color</label>
                      <div className="connect-swatches">
                        {palette.map(([name, color]) => {
                          const selectedSwatch = (labelled.color ?? '').toLowerCase() === color.toLowerCase()
                          return <button key={name} type="button" className={'connect-swatch-btn' + (selectedSwatch ? ' is-selected' : '')} aria-label={`${name} connection color`} aria-pressed={selectedSwatch} title={name} disabled={locked} style={{ backgroundColor: color ? theme.accent(color) ?? 'var(--varia-connection-default)' : 'var(--varia-connection-default)' }} onClick={() => labelEdit({ color: color || undefined })} />
                        })}
                        <input id="connect-color-custom" className="ui-field connect-color-picker" type="color" aria-label="Custom connection color" title="Custom connection color" disabled={locked} value={labelled.color && /^#[\da-f]{6}$/i.test(labelled.color) ? labelled.color : active?.colors['connection.default']?.slice(0, 7) ?? ''} onChange={event => labelEdit({ color: event.target.value })} />
                      </div>
                    </div>
                    <div className="property-row"><label htmlFor="connect-environment">Environment</label><EnvironmentField id="connect-environment" controlClassName="ui-field" value={labelled.environment} disabled={locked} onChange={environment => { if (!isBigQuery) environmentOwner.current = options.server.trim().toLowerCase(); labelEdit({ environment }) }} /></div>
                    <div className="property-row"><label htmlFor="connect-auto-reconnect">Reconnect on startup</label><select className="ui-field" id="connect-auto-reconnect" disabled={locked} value={isBigQuery ? bigQueryReconnect : autoReconnect} onChange={event => { const value = event.target.value as ConnectionDetails['autoReconnect']; if (isBigQuery) { bigQueryUpdate({}); setBigQueryReconnect(value) } else { reconnectOwned.current = true; markEdited(); detailFields.current.add('autoReconnect'); setAutoReconnect(value) } }}><option value="inherit">Use global default</option><option value="on">On</option><option value="off">Off</option></select></div>
                  </div>
                </fieldset>
              </>}
              {properties === 'advanced' && (isBigQuery
                ? <BigQueryAdvanced key={`${bigQuerySelectedId ?? 'new'}:${resetSeq}`} options={bigQuery} savedCostPrompt={bigQuerySavedCostPrompt} projects={bigQueryLists.projects} locked={locked} onInvalid={setBigQueryAdvancedError} onChange={bigQueryUpdate} />
                : <SqlAdvancedPanel key={`${selectedId ?? 'new'}:${resetSeq}`} value={options.advanced ?? {}} executionTimeout={executionTimeout} locked={locked} onChange={next => update({ advanced: next })} />)}
              {properties === 'string' && !isBigQuery && <div className="connection-preview">
                <div className="connect-preview-header">
                  <span className="field-note">Preview generated by SqlClient (password omitted).</span>
                  <button type="button" className="ui-button" data-control-variant="secondary" data-control-size="dense" disabled={!preview || !authReady || !options.server.trim()} onClick={copyPreview}>{copiedString ? 'Copied' : 'Copy'}</button>
                </div>
                <textarea className="ui-field" aria-label="Connection string preview" readOnly value={preview || 'Preparing connection string…'} />
                <div className="connect-paste-box">
                  <label htmlFor="connect-paste-string">Paste Connection String</label>
                  <textarea id="connect-paste-string" className="ui-field" aria-label="Paste connection string" disabled={locked} placeholder="Server=tcp:server.database.windows.net,1433;Initial Catalog=SalesLedger;User ID=reader;Encrypt=True;" value={pasteInput} onChange={event => setPasteInput(event.target.value)} />
                  <div className="connect-paste-actions">
                    <span className="field-note">Passwords are never imported automatically.</span>
                    <button type="button" className="ui-button" data-control-variant="secondary" data-control-size="dense" disabled={locked || !pasteInput.trim()} onClick={applyParsedString}>Parse &amp; Fill Form</button>
                  </div>
                </div>
              </div>}
            </div>
          </div>
        </div>
      </div>
      <div className="connect-actions">
        {(busy || testing || tested || notice || error || (isBigQuery && bigQueryAdvancedError && properties !== 'advanced')) && <div className="connect-outcome">
          {busy && <p className="field-note" role="status">{!isBigQuery && options.authentication === 'entraMfa' ? mfaWaiting : connectingLabel}</p>}
          {testing && <p className="field-note" role="status">{testing.kind === 'save' ? `Checking the password with ${testing.server}…` : `Testing the connection to ${testing.server}…`}{!isBigQuery && options.authentication === 'entraMfa' ? ' Complete the sign-in in your web browser.' : ''}</p>}
          {tested && <div className="connect-tested" role="status"><p className="field-note" data-tone="success"><Icon name="pass" />{tested.text}</p>{tested.warning && <p className="field-note" data-tone="warning"><Icon name="warning" />{tested.warning}</p>}</div>}
          {notice && <p className="field-note" role="status">{notice}{lastRemoved && <> <button type="button" className="ui-button connect-inline-action" data-control-size="dense" disabled={locked} onClick={() => void undoRemove()}>Undo</button></>}</p>}
          {!error && isBigQuery && bigQueryAdvancedError && properties !== 'advanced' && <p className="field-note" role="alert" data-tone="warning">{bigQueryAdvancedError}</p>}
          {error && <div ref={failureBox} className="connect-failure">
            <InlineError message={error} code={shownFailure?.code} details={shownFailure?.details} context={shownFailure ? `${shownFailure.checking === 'save' ? 'Checking the password with' : shownFailure.checking ? 'Testing the connection to' : 'Connecting to'} ${shownFailure.server}` : undefined} actions={fixActions}
              note={fix === 'strict' ? strictCertificate : fix === 'pinned' ? pinnedCertificate : undefined} />
            {shownFailure?.details && <FailureDetails details={shownFailure.details} />}
          </div>}
        </div>}
        <div className="connection-footer">
          <div>
            <ConnectFooterReset disabled={locked} onReset={reset} />
            <button className="ui-button" data-control-variant="secondary" type="button" data-reserve-label={testConnectionLabel} title={testing ? undefined : 'Sign in with these settings without saving them or opening a session'} disabled={testing ? false : locked || !loaded || !ready} onClick={() => { if (testing) stopTest(); else if (isBigQuery) void testBigQuery(); else void testConnection() }}><span>{testing ? 'Stop' : testConnectionLabel}</span></button>
          </div>
          <div className="connect-footer-end">
            <button ref={saveButton} className="ui-button" data-control-variant="secondary" type="button" title={saveTitle} disabled={locked || !loaded || !ready} onClick={() => void save()}>Save</button>
            <button ref={connectButton} className="ui-button primary" type="submit" data-reserve-label={pendingConnectLabel ?? connectLabel} data-reserve-busy-label={connectingLabel} disabled={locked || !loaded || !ready}><span>{busy ? connectingLabel : connectLabel}</span></button>
            <button ref={stopButton} className="ui-button" data-control-variant="secondary" type="button" data-reserve-label={cancelLabel} disabled={saving} onClick={busy ? stop : testing ? stopTest : requestClose}><span>{busy ? 'Stop' : cancelLabel}</span></button>
          </div>
        </div>
      </div>
    </form>
    {review}
    {confirmClose && <SubDialog title={confirmClose.target ? `Save changes to ${confirmClose.target.options.displayName || confirmClose.target.options.server}?` : confirmClose.bigQueryTarget ? `Save changes to ${confirmClose.bigQueryTarget.options.displayName || confirmClose.bigQueryTarget.options.project}?` : isBigQuery ? `Save ${bigQuery.displayName || bigQuery.project} to History?` : `Save ${options.displayName || options.server} to History?`} okLabel="Save" alternative={{ label: "Don't Save", run: () => { const type = confirmClose.type; setConfirmClose(undefined); closeRest(type) } }}
      onOk={() => { const type = confirmClose.type; setConfirmClose(undefined); void save().then(saved => { if (saved === 'saved') closeRest(type) }) }} onCancel={() => setConfirmClose(undefined)}>
      <p>{confirmClose.target || confirmClose.bigQueryTarget ? 'You changed this saved connection. Save the changes to History and its Object Explorer connections before closing?' : 'This connection is not saved. Save it to History before closing?'}</p>
    </SubDialog>}
    {sourcePrompt && <SubDialog title="Use this token file?" okLabel="Use It" onOk={() => void confirmSource(sourcePrompt)} onCancel={() => setSourcePrompt(undefined)}>
      <p>{sourcePrompt.name} signs in with a token that Varia reads from this file each time it connects:</p>
      <p className="bq-source-path">{sourcePrompt.source}</p>
      <p>Use it only if you know what writes this file. Varia asks again if the configuration names another file.</p>
    </SubDialog>}
  </DialogWindow>
}
