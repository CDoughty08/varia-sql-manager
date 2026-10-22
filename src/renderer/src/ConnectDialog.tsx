import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { AdvancedConnectionOptions, ApiResult, ConnectionInfo, ConnectionOptions, DatabaseInfo, DiscoveredServer, ErrorDetails } from '../../shared/contracts'
import type { ErrorCode } from '../../shared/ipc/wire/protocol'
import { advancedDefaults, advancedToStore, canRememberPassword, connectionDefaults, connectionKey, credentialBinding, rememberedProfile, type ConnectionLibrary, type ConnectionLibraryView, type ConnectionProfile, type SecretStorageState } from '../../shared/connections'
import { connectionPickerColor, connectionPresets } from '../../shared/theme/connection-colors'
import Icon from './Icon'
import InlineError, { type ErrorAction } from './kit/InlineError'
import { connectFix } from './connect-fix'
import { EnvironmentField } from './EnvironmentDialog'
import EnvironmentTag from './EnvironmentTag'
import { entryKey, parseEnvironment, savedEntry } from './services/environments'
import { trapFocus } from './trap-focus'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import { IntegratedIdentityLookup } from './services/integrated-identity'
import { authenticationCatalog, authenticationModes, requiresUser, showsIdentity, usesPassword, type AuthenticationMode } from '../../shared/auth'

function unwrap<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(result.error); return result.value }
function message(error: unknown) { return error instanceof Error ? error.message : 'The operation failed.' }
// Profiles store the preset's value, which the theme maps to its own color for that preset.
const palette: readonly (readonly [string, string])[] = [['Default', ''], ...connectionPresets.map(preset => [preset.label, preset.stored] as const)]
interface Props { initial: ConnectionOptions; onConnected(info: ConnectionInfo, options: ConnectionOptions): void; onClose(): void }
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
/** SQL Server's facts about a failed connection, as SSMS shows them under its error; absent facts are left out. */
function FailureDetails({ details }: { details: ErrorDetails }) {
  const rows: [string, string | number | undefined][] = [['Error number', details.number], ['Severity', details.class], ['State', details.state], ['Server', details.server]]
  return <details className="connect-error-details"><summary>Error details</summary><dl>{rows.filter(([, value]) => value !== undefined && value !== '').map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>
}
const storageNotes: Record<NonNullable<SecretStorageState['reason']>, string> = {
  'no-keyring': 'Remember password needs a system keyring (GNOME Keyring or KWallet), and none was found. Passwords are used for this connection only.',
  'unknown-backend': 'Remember password is unavailable because the operating system could not encrypt passwords. Passwords are used for this connection only.',
  unavailable: 'Remember password is unavailable because the operating system could not encrypt passwords. Passwords are used for this connection only.'
}
const forgottenNotice = 'The saved password was rejected, so it has been removed. Enter the password.'
// SSMS's hints for the Entra types whose user name is optional or is not a person's.
const userPlaceholders: Partial<Record<AuthenticationMode, string>> = {
  entraMfa: 'user@contoso.com (optional)', entraServicePrincipal: 'Application (client) ID', entraManagedIdentity: 'Client ID (blank: system-assigned)', entraDefault: 'Optional'
}
const mfaWaiting = 'Complete the sign-in in your web browser. Waiting up to 3 minutes…'
const cancelledNotice = 'Connection cancelled.'
const trustLabel = 'Trust server certificate and connect'
/** Strict encryption validates the certificate whatever Trust server certificate says, so the dialog can only explain. */
const strictCertificate = "Strict encryption always validates the server's certificate. Install a certificate this computer trusts, set Host Name in Certificate to the name the certificate was issued for, or choose Mandatory encryption and Trust server certificate."
/** A pinned certificate or name is a check the person chose: trusting would skip it, so the dialog only explains. */
const pinnedCertificate = "The server's certificate did not match the Server Certificate or the Host Name in Certificate set for this connection, so it was not trusted. Check that this is the server you meant and that those settings are current; Trust server certificate would skip that check."
const trustNeedsPassword = 'Trust server certificate is now checked. The saved password is kept for the old settings only, so enter the password, then connect.'
const choiceLabels: Record<string, string> = { default: '<default>', tcp: 'TCP/IP', np: 'Named pipes', lpc: 'Shared memory', IPv4First: 'IPv4 first', IPv6First: 'IPv6 first', UsePlatformDefault: 'Platform default' }

/** Advanced Properties. A command timeout the profile does not set is left empty, showing Tools › Options' Execution time-out. */
function AdvancedProperties({ value, onSave, onClose }: { value: Partial<AdvancedConnectionOptions>; onSave(value: Partial<AdvancedConnectionOptions>): void; onClose(): void }) {
  const { settings } = useWorkbench()
  const executionTimeout = settings.get('queryExecution.executionTimeout')
  const [draft, setDraft] = useState(() => ({ ...advancedDefaults, ...value.commandTimeout === undefined ? { commandTimeout: '' as unknown as number } : {}, ...value }))
  const [previous, setPrevious] = useState(value)
  const edited = useRef(new Set<string>())
  const edit = (key: string, next: (current: AdvancedConnectionOptions) => AdvancedConnectionOptions) => { edited.current.add(key); setDraft(next) }
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => { form.current?.querySelector<HTMLInputElement>('input')?.focus() }, [])
  return <div className="modal-backdrop advanced-backdrop"><form ref={form} className="connection-modal advanced-dialog" role="dialog" aria-modal="true" aria-labelledby="advanced-title" onSubmit={event => { event.preventDefault(); onSave(advancedToStore(draft, edited.current, previous)) }} onKeyDown={event => { trapFocus(event); if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }}>
    <div className="connection-heading"><h2 id="advanced-title">Advanced Properties</h2><button type="button" className="icon-button" aria-label="Close advanced properties" onClick={onClose}><Icon name="close" /></button></div>
    <div className="connection-scroll">
      {sections.map(section => <fieldset className="property-section" key={section.title}><legend>{section.title}</legend><div className="property-grid">{section.fields.map(field => {
        const id = 'advanced-' + field.key
        const disabled = field.key === 'secureEnclaves' && !draft.columnEncryption || ['attestationProtocol', 'enclaveAttestationUrl'].includes(field.key) && (!draft.columnEncryption || !draft.secureEnclaves) || field.key === 'enclaveAttestationUrl' && draft.attestationProtocol === 'None'
        return <div className="property-row" key={id}><label htmlFor={id}>{field.label}</label>{field.boolean || field.choices
          ? <select id={id} disabled={disabled} value={String(draft[field.key])} onChange={event => edit(field.key, current => ({ ...current, [field.key]: field.boolean ? event.target.value === 'true' : event.target.value, ...(field.key === 'columnEncryption' && event.target.value === 'false' ? { secureEnclaves: false } : {}) }))}>{(field.boolean ? ['false', 'true'] : field.choices!).map(choice => <option key={choice} value={choice}>{field.boolean ? choice === 'true' ? 'True' : 'False' : choiceLabels[choice] ?? choice}</option>)}</select>
          : <input id={id} disabled={disabled} type={field.min !== undefined ? 'number' : 'text'} required={field.min !== undefined && field.key !== 'commandTimeout'} min={field.min}
            {...field.key === 'commandTimeout' ? { placeholder: `${executionTimeout} (Tools › Options)`, 'aria-describedby': 'advanced-timeout-note' } : {}} max={field.max} step={field.min !== undefined ? 1 : undefined} maxLength={field.maxLength ?? 128} value={draft[field.key] as string | number} onChange={event => edit(field.key, current => ({ ...current, [field.key]: field.min !== undefined ? event.target.value === '' ? '' : Number(event.target.value) : event.target.value }) as AdvancedConnectionOptions)} />}</div>
      })}</div></fieldset>)}
      <p className="field-note" id="advanced-timeout-note">Leave the command timeout empty to use Tools › Options › Query Execution › SQL Server › General. Timeout 0 means no timeout. Query tabs require an explicit reconnect after a lost session; automatic connection recovery retries apply to metadata connections.</p>
    </div>
    <div className="connection-footer"><button type="button" onClick={() => { edited.current.clear(); setPrevious({}); setDraft({ ...advancedDefaults, commandTimeout: '' as unknown as number }) }}>Reset</button><span /><button className="primary" type="submit">OK</button><button type="button" onClick={onClose}>Cancel</button></div>
  </form></div>
}

export default function ConnectDialog({ initial, onConnected, onClose }: Props) {
  const { theme, platform } = useWorkbench()
  const { active } = useServiceSnapshot(theme)
  const [options, setOptions] = useState<ConnectionOptions>({ ...initial, password: '' })
  const [library, setLibrary] = useState<ConnectionLibrary>({ version: 1, profiles: [] })
  // The entries with a remembered password (ids only: the password stays in main), and whether the OS can protect one.
  const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [storage, setStorage] = useState<SecretStorageState>()
  const [remember, setRemember] = useState(false)
  const [identity, setIdentity] = useState('Current Windows user')
  // Off Windows: the Kerberos principal Windows Authentication signs in with, while there is a valid ticket.
  const [principal, setPrincipal] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState<string>()
  const [tab, setTab] = useState<'history' | 'browse'>('history')
  const [scope, setScope] = useState<'local' | 'network' | 'registered'>('local')
  const [filter, setFilter] = useState('')
  const [servers, setServers] = useState<DiscoveredServer[]>([])
  const [browseBusy, setBrowseBusy] = useState(false)
  const [browseNote, setBrowseNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // The failed connection's code and details, shown only while its message is the dialog's error.
  const [failure, setFailure] = useState<{ error: string; code?: ErrorCode; details?: ErrorDetails; server: string; options: ConnectionOptions }>()
  const failureBox = useRef<HTMLDivElement>(null)
  const [notice, setNotice] = useState('')
  const [databases, setDatabases] = useState<DatabaseInfo[]>([])
  const [dbBusy, setDbBusy] = useState(false)
  const [dbNote, setDbNote] = useState('')
  // A failed Load databases' details, shown under its note as a failed Connect shows them under its error.
  const [dbDetails, setDbDetails] = useState<ErrorDetails>()
  const [properties, setProperties] = useState<'properties' | 'string'>('properties')
  const [preview, setPreview] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const dialog = useRef<HTMLFormElement>(null)
  const alive = useRef(true)
  const currentOptions = useRef(options)
  currentOptions.current = options
  const dbRequest = useRef(0)
  const browseRequest = useRef(0)
  const dbLoadedKey = useRef('')
  // The server an inherited Name/Color/Environment describes (a saved profile or the prefilled last connection), or null once the user owns them.
  const labelServer = useRef<string | null>(initial.displayName || initial.color || initial.environment ? initial.server : null)
  const selected = library.profiles.find(profile => profile.id === selectedId)
  // The server for which the user set (or cleared) Environment; for any other server the saved entry the form names
  // supplies it, so a typed server keeps its label, and a connect without one keeps the entry's (setsEnvironment).
  const environmentOwner = useRef<string | null>(null)
  const ownsEnvironment = () => environmentOwner.current !== null && environmentOwner.current === currentOptions.current.server.trim().toLowerCase()
  const entryKeys = useMemo(() => new Map(library.profiles.map(profile => [profile.id, entryKey(profile.options)])), [library])
  const entry = useMemo(() => savedEntry(library.profiles, entryKeys, options), [library, entryKeys, options])
  const locked = busy || saving
  const auth = authenticationCatalog[options.authentication]
  const authReady = !requiresUser(options.authentication) || !!options.username?.trim()
  // The request Stop cancels: the running connect's, and the running Load databases' (cancelled when the form changes).
  const connectRequest = useRef<string | undefined>(undefined)
  const databasesRequest = useRef<string | undefined>(undefined)
  const stopButton = useRef<HTMLButtonElement>(null)
  const connectButton = useRef<HTMLButtonElement>(null)
  // The entry whose remembered password main would use for this form: Password left empty sends that entry's id.
  const match = rememberedProfile(library.profiles, savedIds, options, selectedId)
  const rememberable = canRememberPassword(options.authentication) && !!storage?.available
  const storageNote = canRememberPassword(options.authentication) && storage && !storage.available ? storageNotes[storage.reason ?? 'unavailable'] : ''
  function showLibrary(view: ConnectionLibraryView) { setLibrary(view.library); setSavedIds(new Set(view.savedPasswords)) }
  /** Main forgot every remembered password for these credentials, which SQL Server rejected. */
  function passwordRejected() {
    const binding = credentialBinding(currentOptions.current)
    setSavedIds(current => new Set([...current].filter(id => { const profile = library.profiles.find(item => item.id === id); return !!profile && credentialBinding(profile.options) !== binding })))
    setRemember(false); setNotice(forgottenNotice)
  }
  // SSMS shows the identity integrated authentication uses: DOMAIN\user on Windows, the ticket's principal elsewhere
  // (the OS user name without one). Microsoft Entra Integrated signs in as the Windows user.
  const integratedUser = principal ?? identity
  const identityOf = (authentication: AuthenticationMode) => authentication === 'windows' ? integratedUser : identity
  const authNote = options.authentication === 'entraMfa' ? 'Sign in with your web browser when you connect.'
    : options.authentication === 'entraIntegrated' && platform !== 'win32' ? 'Microsoft Entra Integrated needs Windows. On Linux and macOS use Microsoft Entra MFA or Microsoft Entra Default.' : ''
  /** Stops a Load databases that no longer matches the form, or whose dialog closed. */
  function cancelDatabases() {
    const id = databasesRequest.current
    databasesRequest.current = undefined
    if (id) void window.varia.cancelConnectionRequests([id]).catch(() => {})
  }
  /** Stop: the connect ends at once, even while it waits for a Microsoft Entra sign-in in the web browser. */
  function stop() {
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
    }).catch(reason => { if (alive.current) { setError(message(reason)); setLoaded(true) } })
    return () => {
      alive.current = false; dbRequest.current++; browseRequest.current++
      cancelDatabases(); stop()
    }
  }, [])
  useEffect(() => {
    const active = document.activeElement
    dialog.current?.querySelector<HTMLInputElement>('#connect-server')?.focus()
    return () => { if (active instanceof HTMLElement && active.isConnected) active.focus() }
  }, [])
  useEffect(() => { identityLookup.authenticationChanged(options.authentication) }, [identityLookup, options.authentication])
  useEffect(() => {
    if (!entry || ownsEnvironment() || entry.options.environment === currentOptions.current.environment) return
    setOptions(current => ({ ...current, environment: entry.options.environment }))
    // Changing the server again drops it, as it drops a label inherited from history.
    if (entry.options.environment && labelServer.current === null) labelServer.current = entry.options.server
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id, entry?.options.environment, options.server])
  // Connect disables the form, so focus moves to Stop, where Escape and Enter still reach the dialog, and back to Connect after.
  useEffect(() => {
    if (busy) stopButton.current?.focus()
    else if (document.activeElement === stopButton.current) connectButton.current?.focus()
  }, [busy])
  // Choosing an entry with a remembered password checks Remember password, as SSMS does; a typed password keeps the choice.
  useEffect(() => {
    if (!currentOptions.current.password) setRemember(!!match)
  }, [match?.id])
  useEffect(() => {
    dbRequest.current++; cancelDatabases(); dbLoadedKey.current = ''; setDatabases([]); setDbNote(''); setDbDetails(undefined); setDbBusy(false)
  }, [options.server, options.authentication, options.username, options.password, options.encrypt, options.trustServerCertificate, options.hostNameInCertificate, options.advanced])
  useEffect(() => {
    if (tab !== 'browse' || scope === 'registered') return
    void browse(scope)
    // Only a deliberate tab/scope change or Refresh starts server enumeration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, scope])
  useEffect(() => {
    if (properties !== 'string') return
    let cancelled = false
    setPreview('')
    const timer = setTimeout(() => {
      if (!authReady || !options.server.trim()) { setPreview('Enter a server and authentication details to preview the connection string.'); return }
      void window.varia.previewConnection(options).then(result => { if (!cancelled) setPreview(result.ok ? result.value.connectionString : result.error) }).catch(reason => { if (!cancelled) setPreview(message(reason)) })
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [properties, options, authReady])

  /** Changing the server drops an inherited Name/Color/Environment, which would otherwise mislabel the new server (e.g. production shown as DEV). */
  function changeServer(server: string, patch: Partial<ConnectionOptions> = {}) {
    const inherited = labelServer.current !== null && server.trim().toLowerCase() !== labelServer.current.trim().toLowerCase()
    if (inherited) labelServer.current = null
    setSelectedId(undefined)
    update({ server, ...patch, ...(inherited ? { displayName: '', color: undefined, environment: undefined } : {}) })
  }
  function update(patch: Partial<ConnectionOptions>) { setOptions(current => ({ ...current, ...patch })); setError(''); setNotice('') }
  function choose(profile: ConnectionProfile) { environmentOwner.current = null; setSelectedId(profile.id); setOptions({ ...profile.options, password: '' }); labelServer.current = profile.options.displayName || profile.options.color || profile.options.environment ? profile.options.server : null; setError(''); setNotice('') }
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
    const key = JSON.stringify({ ...options, database: '', displayName: '', color: '', environment: '' })
    const request = ++dbRequest.current
    const requestId = crypto.randomUUID()
    databasesRequest.current = requestId
    setDbBusy(true); setDbNote(''); setDbDetails(undefined)
    // Remember failures too: focusing the field again must not retry a rejected login (lockout policies). Refresh retries.
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
    }
    finally {
      if (databasesRequest.current === requestId) databasesRequest.current = undefined
      if (alive.current && request === dbRequest.current) setDbBusy(false)
    }
  }
  /** The form's options with the environment as stored (a preset by its own name), or undefined after saying why a
   *  Custom label cannot be one. */
  function labelledOptions(from: ConnectionOptions = options): ConnectionOptions | undefined {
    const environment = parseEnvironment(from.environment)
    if (!environment.ok) { setError(environment.error); return undefined }
    return { ...from, environment: environment.environment }
  }
  async function saveProfile(favorite?: boolean, registered?: boolean, profile?: ConnectionProfile) {
    const labelled = profile ? profile.options : labelledOptions()
    if (!labelled) return
    setSaving(true); setError(''); setNotice('')
    try {
      const input = { id: profile?.id ?? selectedId, options: labelled, favorite, registered }
      const value = unwrap(await window.varia.saveConnectionProfile(input))
      if (!alive.current) return
      showLibrary(value)
      if (!profile) setSelectedId(value.library.profiles.find(item => connectionKey(item.options) === connectionKey(options))?.id)
    } catch (reason) { if (alive.current) setError(message(reason)) }
    finally { if (alive.current) setSaving(false) }
  }
  async function remove(profile: ConnectionProfile) {
    setSaving(true); setError('')
    try { const value = unwrap(await window.varia.removeConnectionProfile(profile.id)); if (alive.current) { showLibrary(value); if (selectedId === profile.id) setSelectedId(undefined) } }
    catch (reason) { if (alive.current) setError(message(reason)) }
    finally { if (alive.current) setSaving(false) }
  }
  /** Connects with the form's options, or with `chosen` when a fix changed them in the same click. */
  async function connect(chosen: ConnectionOptions = options) {
    const labelled = labelledOptions(chosen)
    if (!labelled) return
    // Only Stop's notice is about the last attempt; the library's warnings and a forgotten password's notice stay.
    setBusy(true); setError(''); setNotice(current => current === cancelledNotice ? '' : current)
    const requestId = crypto.randomUUID()
    connectRequest.current = requestId
    const saved = chosen === options ? match : rememberedProfile(library.profiles, savedIds, chosen, selectedId)
    try {
      const result = await window.varia.connect(labelled, { ...saved ? { profileId: saved.id } : {}, remember: remember && rememberable, requestId, ...ownsEnvironment() ? { setsEnvironment: true } : {} })
      if (!alive.current) return
      // Main says which label the entry kept when the form had none (the history had not loaded yet).
      if (result.ok) { const { environment: kept, ...info } = result.value; onConnected(info, { ...labelled, password: '', environment: labelled.environment ?? kept }) }
      // Stop: the form is the user's again, with nothing to report.
      else if (result.code === 'CANCELLED') setNotice(cancelledNotice)
      else {
        setError(result.error); setFailure({ error: result.error, code: result.code, details: result.details, server: chosen.server, options: chosen })
        if (result.passwordForgotten) passwordRejected()
      }
    } catch (reason) { if (alive.current) { setError(message(reason)); setFailure(undefined) } }
    finally {
      if (connectRequest.current === requestId) connectRequest.current = undefined
      if (alive.current) setBusy(false)
    }
  }
  /** Trust server certificate and connect: checks the box, as the person would, and connects again with it. */
  function trustAndConnect() {
    const next = { ...options, trustServerCertificate: true }
    setOptions(next)
    // Main fills a remembered password in only for the certificate settings it was saved with.
    if (usesPassword(next.authentication) && !next.password && match && rememberedProfile(library.profiles, savedIds, next, selectedId)?.id !== match.id) {
      setError(''); setNotice(trustNeedsPassword)
      dialog.current?.querySelector<HTMLInputElement>('#connect-password')?.focus()
      return
    }
    void connect(next)
  }
  const shownFailure = error && failure?.error === error ? failure : undefined
  const fix = shownFailure && connectFix(shownFailure.options, shownFailure.details)
  const fixActions: ErrorAction[] = fix === 'trust' ? [{ label: trustLabel, run: trustAndConnect }] : []
  // The error sits at the end of the scrolled form, next to Connect: bring it into view, as people look there first.
  useEffect(() => { if (error) failureBox.current?.scrollIntoView({ block: 'nearest' }) }, [error])
  const matches = (text: string) => text.toLowerCase().includes(filter.toLowerCase())
  const filtered = library.profiles.filter(profile => matches([profile.options.displayName, profile.options.server, profile.options.database, profile.options.username].join(' ')))
  const recent = filtered.filter(profile => profile.lastConnected).sort((a, b) => b.lastConnected!.localeCompare(a.lastConnected!))
  const favorite = filtered.filter(profile => profile.favorite)
  function profileRows(profiles: ConnectionProfile[], empty: string) {
    return profiles.length ? profiles.map(profile => <div key={profile.id} className={'connection-list-row' + (selectedId === profile.id ? ' selected' : '')}>
      <button type="button" className="connection-choice" disabled={locked} onClick={() => choose(profile)} title={`${profile.options.server} · ${profile.options.database || '<default>'}`}><span className="connection-swatch" style={{ backgroundColor: theme.accent(profile.options.color) ?? 'var(--varia-connection-default)' }} /><Icon name="server" /><span><span className="connection-choice-title"><strong>{profile.options.displayName || profile.options.server}</strong><EnvironmentTag environment={profile.options.environment} place="list" /></span><small>{profile.options.displayName ? profile.options.server + ' · ' : ''}{profile.options.database || '<default>'} · {showsIdentity(profile.options.authentication) ? identityOf(profile.options.authentication) : profile.options.username ?? ''}</small></span></button>
      <button type="button" className="icon-button favorite-button" aria-label={`${profile.favorite ? 'Unfavorite' : 'Favorite'} ${profile.options.displayName || profile.options.server}`} title={profile.favorite ? 'Remove from favorites' : 'Add to favorites'} disabled={locked} onClick={() => void saveProfile(!profile.favorite, undefined, profile)}>{profile.favorite ? '★' : '☆'}</button>
      <button type="button" className="icon-button" aria-label={`Remove saved ${profile.options.displayName || profile.options.server}`} title="Remove saved connection" disabled={locked} onClick={() => void remove(profile)}><Icon name="close" /></button>
    </div>) : <p className="connection-empty">{empty}</p>
  }
  function trap(event: KeyboardEvent<HTMLFormElement>) {
    if (advanced) return
    // While connecting, Escape is Stop, as the footer's button is.
    if (event.key === 'Escape' && busy) { event.preventDefault(); event.stopPropagation(); stop() }
    else if (event.key === 'Escape' && !locked) { event.preventDefault(); event.stopPropagation(); onClose() }
    trapFocus(event)
  }
  return <>
    <div className="modal-backdrop"><form ref={dialog} className="connection-modal connect-dialog" role="dialog" aria-labelledby="connect-title" aria-modal="true" inert={advanced} onSubmit={(event: FormEvent) => { event.preventDefault(); void connect() }} onKeyDown={trap}>
      <div className="connection-heading"><h2 id="connect-title">Connect</h2><button type="button" className="icon-button" aria-label="Close connection dialog" disabled={locked} onClick={onClose}><Icon name="close" /></button></div>
      <div className="connection-scroll">
        <div className="connection-tabs" role="tablist" aria-label="Connection sources">{(['history', 'browse'] as const).map(value => <button type="button" role="tab" key={value} aria-selected={tab === value} aria-controls="connection-sources" disabled={locked} onClick={() => setTab(value)}>{value === 'history' ? 'History' : 'Browse'}</button>)}</div>
        <input className="connection-filter" aria-label="Filter connections" placeholder="Type here to filter the list" value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} />
        <div id="connection-sources" className="connection-sources" role="tabpanel" aria-label={tab === 'history' ? 'History' : 'Browse'}>
          {!loaded && <p className="connection-empty">Loading saved connections…</p>}
          {tab === 'history' ? <><details open><summary>Favorites ({favorite.length})</summary>{profileRows(favorite, 'No favorite connections')}</details><details open><summary>Recent Connections ({recent.length})</summary>{profileRows(recent, 'No recent connections')}</details></> : <>
            <div className="browse-toolbar"><label htmlFor="browse-scope">Server source</label><select id="browse-scope" value={scope} disabled={locked} onChange={event => { browseRequest.current++; setBrowseBusy(false); setBrowseNote(''); setScope(event.target.value as typeof scope) }}><option value="local">Local</option><option value="network">Network</option><option value="registered">Registered Servers</option></select>{scope !== 'registered' && <button type="button" disabled={browseBusy || locked} onClick={() => void browse(scope)}>Refresh</button>}</div>
            {scope === 'registered' ? <>{profileRows(filtered.filter(profile => profile.registered), 'No registered servers. Register the connection below to add one.')}<p className="field-note">Registered servers are saved in Varia on this computer.</p></> : <>
              {browseBusy && <p className="connection-empty">Discovering {scope} servers…</p>}
              {servers.filter(server => matches(server.server)).map(server => <button type="button" className="discovered-server" disabled={locked} key={server.server} onClick={() => changeServer(server.server, { database: '', password: '', displayName: '' })}><Icon name="server" /><span>{server.server}</span><small>{server.version}</small></button>)}
              {!browseBusy && !servers.length && <p className="connection-empty">No servers found. You can enter a server name below.</p>}
              {browseNote && <p className="field-note">{browseNote}</p>}
            </>}
          </>}
        </div>
        <div className="connection-tabs connection-property-tabs" role="tablist" aria-label="Connection details"><button type="button" role="tab" aria-selected={properties === 'properties'} aria-controls="connection-properties" onClick={() => setProperties('properties')}>Connection Properties</button><button type="button" role="tab" aria-selected={properties === 'string'} aria-controls="connection-properties" onClick={() => setProperties('string')}>Connection String</button></div>
        <div id="connection-properties" role="tabpanel" aria-label={properties === 'properties' ? 'Connection Properties' : 'Connection String'}>
          <div className="property-grid" hidden={properties !== 'properties'}>
            <div className="property-row"><label htmlFor="connect-server">Server Name</label><input id="connect-server" list="known-servers" required maxLength={256} disabled={locked} value={options.server} placeholder="localhost,1433 or server\instance" onChange={event => changeServer(event.target.value)} /><datalist id="known-servers">{[...new Set(library.profiles.map(profile => profile.options.server))].map(server => <option key={server} value={server} />)}</datalist></div>
            <div className="property-row"><label htmlFor="connect-auth">Authentication</label><select id="connect-auth" value={options.authentication} disabled={locked} onChange={event => update({ authentication: event.target.value as AuthenticationMode, password: '' })}>{authenticationModes.map(mode => <option key={mode} value={mode}>{authenticationCatalog[mode].label}</option>)}</select></div>
            <div className="property-row"><label htmlFor="connect-user">{auth.userLabel}</label><input id="connect-user" required={requiresUser(options.authentication)} disabled={locked || showsIdentity(options.authentication)} autoComplete="off" maxLength={128} placeholder={userPlaceholders[options.authentication]} value={showsIdentity(options.authentication) ? identityOf(options.authentication) : options.username ?? ''} onChange={event => update({ username: event.target.value })} /></div>
            <div className="property-row"><label htmlFor="connect-password">Password</label><input id="connect-password" type="password" autoComplete="off" disabled={locked || !usesPassword(options.authentication)} maxLength={1024} value={options.password ?? ''} {...match && !options.password ? { placeholder: '••••••••', 'aria-describedby': 'connect-password-saved' } : {}} onChange={event => update({ password: event.target.value })} />{match && !options.password && <span id="connect-password-saved" className="visually-hidden">A saved password will be used. Type to replace it.</span>}</div>
            <div className="property-row"><span /><label className="checkbox-label"><input type="checkbox" checked={remember && rememberable} disabled={locked || !rememberable} {...storageNote ? { 'aria-describedby': 'connect-remember-note' } : {}} onChange={event => setRemember(event.target.checked)} />Remember password</label></div>
            {storageNote && <div className="property-row"><span /><p className="field-note" id="connect-remember-note">{storageNote}</p></div>}
            {authNote && <div className="property-row"><span /><p className="field-note" id="connect-auth-note">{authNote}</p></div>}
            <div className="property-row"><label htmlFor="connect-database">Database Name</label><div className="property-input-action"><input id="connect-database" list="available-databases" maxLength={128} disabled={locked} placeholder="<default>" value={options.database} onFocus={() => { const key = JSON.stringify({ ...currentOptions.current, database: '', displayName: '', color: '', environment: '' }); if (dbLoadedKey.current !== key) void loadDatabases() }} onChange={event => update({ database: event.target.value })} /><button type="button" aria-label="Load databases" title="Load databases from this server" disabled={locked || dbBusy || !authReady} onClick={() => void loadDatabases()}>{dbBusy ? '…' : '↻'}</button></div><datalist id="available-databases"><option value="" label="<default>" />{databases.map(database => <option key={database.name} value={database.name} />)}</datalist></div>
            {(dbBusy || dbNote) && <div className="property-row"><span /><div><p className="field-note" role="status">{dbBusy ? 'Loading databases…' : dbNote}</p>{!dbBusy && dbDetails && <FailureDetails details={dbDetails} />}</div></div>}
            <div className="property-row"><label htmlFor="connect-encrypt">Encrypt</label><select id="connect-encrypt" value={options.encrypt ?? 'mandatory'} disabled={locked} onChange={event => update({ encrypt: event.target.value as ConnectionOptions['encrypt'] })}><option value="optional">Optional</option><option value="mandatory">Mandatory</option><option value="strict">Strict</option></select></div>
            <div className="property-row"><span /><label className="checkbox-label"><input type="checkbox" checked={options.encrypt !== 'strict' && options.trustServerCertificate} disabled={locked || options.encrypt === 'strict'} onChange={event => update({ trustServerCertificate: event.target.checked })} />Trust server certificate</label></div>
            <div className="property-row"><label htmlFor="connect-hostname">Host Name in Certificate</label><input id="connect-hostname" maxLength={256} disabled={locked} value={options.hostNameInCertificate ?? ''} onChange={event => update({ hostNameInCertificate: event.target.value })} /></div>
            <div className="advanced-action"><button type="button" disabled={locked} onClick={() => setAdvanced(true)}>Advanced…</button></div>
          </div>
          {properties === 'string' && <div className="connection-preview"><textarea aria-label="Connection string preview" readOnly value={preview || 'Preparing connection string…'} /><p className="field-note">Preview generated by SqlClient. The password is omitted. Edit settings in Connection Properties.</p></div>}
        </div>
        <fieldset className="property-section custom-properties"><legend>Custom Properties</legend><div className="property-grid">
          <div className="property-row"><label htmlFor="connect-name">Name</label><input id="connect-name" maxLength={128} disabled={locked} value={options.displayName ?? ''} placeholder="Optional connection name" onChange={event => { labelServer.current = null; update({ displayName: event.target.value }) }} /></div>
          <div className="property-row"><label htmlFor="connect-color">Color</label><div className="property-input-action"><select id="connect-color" value={palette.some(([, color]) => color === (options.color ?? '')) ? options.color ?? '' : 'custom'} disabled={locked} onChange={event => { labelServer.current = null; update({ color: event.target.value || undefined }) }}>{palette.map(([name, color]) => <option value={color} key={name}>{name === 'Default' ? '<default>' : name}</option>)}{options.color && !palette.some(([, color]) => color === options.color) && <option value="custom">Custom</option>}</select><input type="color" aria-label="Custom connection color" title="Custom connection color" disabled={locked} value={connectionPickerColor(options.color, active)} onChange={event => { labelServer.current = null; update({ color: event.target.value }) }} /></div></div>
          <div className="property-row"><label htmlFor="connect-environment">Environment</label><EnvironmentField id="connect-environment" value={options.environment} disabled={locked} onChange={environment => { labelServer.current = null; environmentOwner.current = options.server.trim().toLowerCase(); update({ environment }) }} /></div>
        </div><div className="connection-save-actions"><button type="button" disabled={locked || !loaded || !authReady} onClick={() => void saveProfile(!selected?.favorite)}>{selected?.favorite ? '★ Remove favorite' : '☆ Add favorite'}</button><button type="button" disabled={locked || !loaded || !authReady} onClick={() => void saveProfile(undefined, !selected?.registered)}>{selected?.registered ? 'Unregister server' : 'Register server'}</button>{selected && <button type="button" disabled={locked} onClick={() => void saveProfile()}>Save changes</button>}</div></fieldset>
        {busy && <p className="field-note" role="status">{options.authentication === 'entraMfa' ? mfaWaiting : 'Connecting…'}</p>}
        {notice && <p className="field-note" role="status">{notice}</p>}
        {error && <div ref={failureBox} className="connect-failure">
          <InlineError message={error} code={shownFailure?.code} details={shownFailure?.details} context={shownFailure ? `Connecting to ${shownFailure.server}` : undefined} actions={fixActions} />
          {(fix === 'strict' || fix === 'pinned') && <p className="field-note">{fix === 'strict' ? strictCertificate : pinnedCertificate}</p>}
          {shownFailure?.details && (shownFailure.details.number !== undefined || shownFailure.details.server) && <FailureDetails details={shownFailure.details} />}
        </div>}
      </div>
      <div className="connection-footer"><button type="button" disabled={locked} onClick={() => { setSelectedId(undefined); labelServer.current = null; setOptions(connectionDefaults(platform)); setError('') }}>Reset</button><span /><button ref={connectButton} className="primary" type="submit" disabled={locked || !authReady}>{busy ? 'Connecting…' : 'Connect'}</button><button ref={stopButton} type="button" disabled={saving} onClick={busy ? stop : onClose}>{busy ? 'Stop' : 'Cancel'}</button></div>
    </form></div>
    {advanced && <AdvancedProperties value={options.advanced ?? {}} onSave={value => { update({ advanced: value }); setAdvanced(false); setTimeout(() => dialog.current?.querySelector<HTMLButtonElement>('.advanced-action button')?.focus(), 0) }} onClose={() => { setAdvanced(false); setTimeout(() => dialog.current?.querySelector<HTMLButtonElement>('.advanced-action button')?.focus(), 0) }} />}
  </>
}
