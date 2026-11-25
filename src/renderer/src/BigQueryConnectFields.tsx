import { useEffect, useRef, useState } from 'react'
import type { BigQueryAccount, BigQueryConnectionOptions, BigQueryProject, DatabaseInfo, ErrorDetails } from '../../shared/contracts'
import { bigQueryAuthenticationModes, usesKeyFile, type BigQueryAuthenticationMode } from '../../shared/auth'
import { bigQueryAuthenticationLabels, bigQueryKeyFileLabels } from '../../shared/bigquery-connections'
import { bigQueryLimits } from '../../shared/connections'
import { z } from 'zod'
import Icon from './Icon'
import { advancedCostPrompt, advancedCostThreshold, parseCostThreshold, shownCostThreshold, bigQueryCredentialReady, bigQueryFormOptions, bigQueryReady, byteUnits, joinBytes, mergeProjects, parseExtraProjects, projectError, splitBytes, type ByteUnit } from './bigquery-connect-form'

/** Location's choices: Automatic (the dataset's), the multi-regions, then common regions. Any other a profile names is
 *  listed as well. */
export const bigQueryLocations = ['US', 'EU', 'us-central1', 'us-east1', 'us-east4', 'us-west1', 'us-west2', 'northamerica-northeast1', 'southamerica-east1',
  'europe-west1', 'europe-west2', 'europe-west3', 'europe-west4', 'europe-north1', 'asia-east1', 'asia-northeast1', 'asia-south1', 'asia-southeast1', 'australia-southeast1'] as const
/** projects.list pages Load projects reads at most (1,000 projects each). */
const maxProjectPages = 10

/** The account line: who Google will sign in as, before connecting (bigquery.account). */
export type AccountState = { state: 'idle' } | { state: 'checking' } | { state: 'ok'; account: BigQueryAccount } | { state: 'failed'; error: string }
const accountKinds: Record<BigQueryAccount['kind'], string> = {
  user: 'Signed in to gcloud as', serviceAccount: 'Service account', computeEngine: 'Compute Engine service account', external: 'Federated identity', aws: 'AWS identity',
  externalUser: 'Federated user', impersonated: 'Signed in as', emulator: 'Emulator account'
}
export function accountText(account: BigQueryAccount): string {
  return `${accountKinds[account.kind]} ${account.account}${account.impersonated ? `, acting as ${account.impersonated}` : ''}`
}

/**
 * What BigQuery's fields load: the account line, the projects for the Project combo and Browse, and the project's
 * datasets. Each request belongs to the credential (and project) it was made for; a change drops its answer.
 */
export function useBigQueryLists(options: BigQueryConnectionOptions, alive: { readonly current: boolean }, shown: boolean) {
  const [account, setAccount] = useState<AccountState>({ state: 'idle' })
  const [projects, setProjects] = useState<BigQueryProject[]>([])
  const [projectsBusy, setProjectsBusy] = useState(false)
  const [projectsNote, setProjectsNote] = useState('')
  const [datasets, setDatasets] = useState<DatabaseInfo[]>([])
  const [datasetsBusy, setDatasetsBusy] = useState(false)
  const [datasetsNote, setDatasetsNote] = useState('')
  const [datasetsDetails, setDatasetsDetails] = useState<ErrorDetails>()
  const accountRequest = useRef(0), projectsRequest = useRef(0), datasetsRequest = useRef(0)
  const datasetsId = useRef<string | undefined>(undefined)
  const datasetsLoaded = useRef('')
  const current = useRef(options)
  current.current = options
  const credential = (from: BigQueryConnectionOptions) => ({ authentication: from.authentication, ...usesKeyFile(from.authentication) && from.keyFile ? { keyFile: from.keyFile } : {}, ...from.impersonateServiceAccount ? { impersonateServiceAccount: from.impersonateServiceAccount } : {} })
  const credentialKey = JSON.stringify(credential(options))
  const datasetsKey = (from: BigQueryConnectionOptions) => JSON.stringify([credential(from), from.project.trim(), from.location ?? ''])
  function cancelDatasets() {
    const id = datasetsId.current
    datasetsId.current = undefined
    if (id) void window.varia.cancelConnectionRequests([id]).catch(() => {})
  }
  async function checkAccount() {
    const from = current.current, request = ++accountRequest.current
    if (!bigQueryCredentialReady(from)) { setAccount({ state: 'idle' }); return }
    setAccount({ state: 'checking' })
    try {
      const result = await window.varia.bigQueryAccount(credential(from))
      if (!alive.current || request !== accountRequest.current) return
      setAccount(result.ok ? { state: 'ok', account: result.value } : { state: 'failed', error: result.error })
    } catch (reason) {
      if (alive.current && request === accountRequest.current) setAccount({ state: 'failed', error: reason instanceof Error ? reason.message : 'The account could not be read.' })
    }
  }
  async function loadProjects() {
    const from = current.current, request = ++projectsRequest.current
    if (!bigQueryCredentialReady(from)) return
    setProjectsBusy(true); setProjectsNote('')
    try {
      let listed: BigQueryProject[] = [], pageToken: string | undefined, pages = 0
      do {
        const result = await window.varia.bigQueryProjects({ ...credential(from), ...pageToken ? { pageToken } : {} })
        if (!alive.current || request !== projectsRequest.current) return
        // The failure's note stays: no summary of the pages listed before it replaces it.
        if (!result.ok) { setProjectsNote('Could not load projects: ' + result.error + ' You can type a project id.'); return }
        listed = mergeProjects(listed, result.value.projects)
        setProjects(listed)
        pageToken = result.value.nextPageToken
      } while (pageToken && ++pages < maxProjectPages)
      if (alive.current && request === projectsRequest.current && listed.length) setProjectsNote(pageToken ? `The first ${listed.length} projects are listed. Type a project id to use another.` : '')
      else if (alive.current && request === projectsRequest.current && !pageToken) setProjectsNote(current => current || 'This account sees no projects. You can type a project id.')
    } catch (reason) {
      if (alive.current && request === projectsRequest.current) setProjectsNote('Could not load projects: ' + (reason instanceof Error ? reason.message : 'the request failed.') + ' You can type a project id.')
    } finally { if (alive.current && request === projectsRequest.current) setProjectsBusy(false) }
  }
  async function loadDatasets() {
    const from = current.current
    if (datasetsBusy || !bigQueryReady(from)) return
    let options: BigQueryConnectionOptions
    try { options = bigQueryFormOptions({ ...from, displayName: undefined, color: undefined, environment: undefined }) } catch (reason) { setDatasetsNote(reason instanceof Error ? reason.message : 'Check the connection settings.'); return }
    const key = datasetsKey(from), request = ++datasetsRequest.current, requestId = crypto.randomUUID()
    datasetsId.current = requestId
    setDatasetsBusy(true); setDatasetsNote(''); setDatasetsDetails(undefined)
    try {
      const result = await window.varia.discoverDatabases(options, { requestId })
      if (!alive.current || request !== datasetsRequest.current) return
      datasetsLoaded.current = key
      if (!result.ok) { setDatasetsNote('Could not load datasets: ' + result.error + ' You can type a dataset name.'); setDatasetsDetails(result.details); return }
      setDatasets(result.value)
      setDatasetsNote(result.value.length ? `${result.value.length} ${result.value.length === 1 ? 'dataset' : 'datasets'} available.` : 'This project has no datasets this account can see. You can still type a dataset name.')
    } catch (reason) {
      if (alive.current && request === datasetsRequest.current) { datasetsLoaded.current = key; setDatasetsNote('Could not load datasets: ' + (reason instanceof Error ? reason.message : 'the request failed.')) }
    } finally {
      if (datasetsId.current === requestId) datasetsId.current = undefined
      if (alive.current && request === datasetsRequest.current) setDatasetsBusy(false)
    }
  }
  /** Test Connection's answer is the project's datasets too. */
  function showDatasets(values: DatabaseInfo[]) { datasetsRequest.current++; cancelDatasets(); datasetsLoaded.current = datasetsKey(current.current); setDatasets(values); setDatasetsNote(''); setDatasetsDetails(undefined); setDatasetsBusy(false) }
  // A new credential is another account: its line is read again, and what the old one listed goes.
  useEffect(() => {
    projectsRequest.current++; setProjects([]); setProjectsNote(''); setProjectsBusy(false)
    return () => { accountRequest.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialKey])
  // The account line signs in, so it is read only while BigQuery's fields show: a dialog on SQL Server asks Google nothing.
  useEffect(() => {
    if (!shown) { accountRequest.current++; setAccount({ state: 'idle' }); return }
    const timer = setTimeout(() => void checkAccount(), 250)
    return () => { clearTimeout(timer); accountRequest.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialKey, shown])
  useEffect(() => {
    datasetsRequest.current++; cancelDatasets(); datasetsLoaded.current = ''; setDatasets([]); setDatasetsNote(''); setDatasetsDetails(undefined); setDatasetsBusy(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialKey, options.project, options.location])
  useEffect(() => () => { accountRequest.current++; projectsRequest.current++; datasetsRequest.current++; cancelDatasets() }, [])
  return {
    account, checkAccount, projects, projectsBusy, projectsNote, loadProjects, datasets, datasetsBusy, datasetsNote, datasetsDetails, loadDatasets, showDatasets,
    /** Whether the datasets shown are this form's (focusing the field loads them once). */
    datasetsCurrent: () => datasetsLoaded.current === datasetsKey(current.current)
  }
}
export type BigQueryLists = ReturnType<typeof useBigQueryLists>

/** How many of BigQuery's advanced settings are set. */
export function bigQueryAdvancedCount(options: Pick<BigQueryConnectionOptions, 'maximumBytesBilled' | 'costPrompt' | 'costThreshold' | 'impersonateServiceAccount' | 'extraProjects'>): number {
  return [options.maximumBytesBilled, options.costPrompt === false, options.costThreshold, options.impersonateServiceAccount, options.extraProjects?.length].filter(Boolean).length
}

/** The Advanced tab's accessible summary: how many of BigQuery's advanced settings are set. */
export function bigQueryAdvancedSummary(options: BigQueryConnectionOptions): string {
  const count = bigQueryAdvancedCount(options)
  return count === 0 ? '' : count === 1 ? '1 property set' : `${count} properties set`
}

interface FieldsProps {
  options: BigQueryConnectionOptions
  keyFileName?: string
  locked: boolean
  lists: BigQueryLists
  onChange(patch: Partial<BigQueryConnectionOptions>): void
  onAuthentication(mode: BigQueryAuthenticationMode): void
  onBrowseKeyFile(): void
}

/** BigQuery's block of the Connect dialog's Connection Properties (docs/bigquery.md, Connect dialog). */
export function BigQueryConnectFields({ options, keyFileName, locked, lists, onChange, onAuthentication, onBrowseKeyFile }: FieldsProps) {
  const keyMode = usesKeyFile(options.authentication) ? options.authentication as Exclude<BigQueryAuthenticationMode, 'gcloud'> : undefined
  const ready = bigQueryCredentialReady(options)
  const projectProblem = options.project.trim() ? projectError(options.project) : undefined
  const dataset = options.dataset?.trim() ? lists.datasets.find(value => value.name === options.dataset?.trim()) : undefined
  const locations = options.location && !(bigQueryLocations as readonly string[]).includes(options.location) ? [...bigQueryLocations, options.location] : bigQueryLocations
  const { account } = lists
  return <>
    <div className="property-row"><label htmlFor="connect-bq-auth">Authentication</label><select className="ui-field" id="connect-bq-auth" value={options.authentication} disabled={locked} onChange={event => onAuthentication(event.target.value as BigQueryAuthenticationMode)}>{bigQueryAuthenticationModes.map(mode => <option key={mode} value={mode}>{bigQueryAuthenticationLabels[mode]}</option>)}</select></div>
    {keyMode && <div className="property-row"><label htmlFor="connect-bq-keyfile">{bigQueryKeyFileLabels[keyMode]}</label><div className="property-input-action"><input className="ui-field" id="connect-bq-keyfile" readOnly disabled={locked} value={options.keyFile ? keyFileName ?? 'Chosen file' : ''} placeholder="No file chosen" aria-describedby="connect-bq-keyfile-note" /><button className="ui-button" data-control-variant="secondary" type="button" disabled={locked} onClick={onBrowseKeyFile}>Browse…</button></div></div>}
    {keyMode && <div className="property-row"><span /><p className="field-note" id="connect-bq-keyfile-note">Varia remembers where the file is, not what is in it, and reads it each time it connects.</p></div>}
    <div className="property-row"><span /><div className="bq-account" role="status" aria-live="polite">
      {!ready ? <p className="field-note">Choose the {keyMode ? bigQueryKeyFileLabels[keyMode].toLowerCase() : 'credential'} to see which account signs in.</p>
        : account.state === 'checking' ? <p className="field-note"><Icon name="loading" spin /> Checking the account…</p>
          : account.state === 'ok' ? <p className="field-note" data-tone="success"><Icon name="pass" />{accountText(account.account)}</p>
            : account.state === 'failed' ? <p className="field-note" data-tone="warning"><Icon name="warning" />{account.error} <button type="button" className="ui-button connect-inline-action" data-control-size="dense" disabled={locked} onClick={() => void lists.checkAccount()}>Check again</button></p> : null}
    </div></div>
    <div className="property-row"><label htmlFor="connect-bq-project">Project</label><div className="property-input-action"><input className="ui-field" id="connect-bq-project" list="bq-projects" required maxLength={bigQueryLimits.project} disabled={locked} value={options.project} placeholder="Billing project id" spellCheck={false} autoComplete="off" {...projectProblem ? { 'aria-invalid': true, 'aria-describedby': 'connect-bq-project-note' } : {}} onChange={event => onChange({ project: event.target.value })} /><button className="ui-button icon-button" data-control-variant="secondary" type="button" aria-label="Load projects" title="Load the projects this account can see" disabled={locked || lists.projectsBusy || !ready} onClick={() => void lists.loadProjects()}><Icon name={lists.projectsBusy ? 'loading' : 'refresh'} spin={lists.projectsBusy} /></button></div><datalist id="bq-projects">{lists.projects.map(project => <option key={project.id} value={project.id} label={project.friendlyName} />)}</datalist></div>
    {(projectProblem || lists.projectsBusy || lists.projectsNote) && <div className="property-row"><span /><p className="field-note" id="connect-bq-project-note" role="status">{projectProblem ?? (lists.projectsBusy ? 'Loading projects…' : lists.projectsNote)}</p></div>}
    <div className="property-row"><label htmlFor="connect-bq-location">Location</label><select className="ui-field" id="connect-bq-location" value={options.location ?? ''} disabled={locked} onChange={event => onChange({ location: event.target.value || undefined })}><option value="">Automatic (from the dataset)</option>{locations.map(location => <option key={location} value={location}>{location}</option>)}</select></div>
    <div className="property-row"><label htmlFor="connect-bq-dataset">Default dataset</label><div className="property-input-action"><input className="ui-field" id="connect-bq-dataset" list="bq-datasets" maxLength={bigQueryLimits.dataset} disabled={locked} value={options.dataset ?? ''} placeholder="<none>" spellCheck={false} autoComplete="off" onFocus={() => { if (!lists.datasetsCurrent()) void lists.loadDatasets() }} onChange={event => onChange({ dataset: event.target.value })} /><button className="ui-button icon-button" data-control-variant="secondary" type="button" aria-label="Load datasets" title="Load this project's datasets" disabled={locked || lists.datasetsBusy || !bigQueryReady(options)} onClick={() => void lists.loadDatasets()}><Icon name={lists.datasetsBusy ? 'loading' : 'refresh'} spin={lists.datasetsBusy} /></button></div><datalist id="bq-datasets">{lists.datasets.map(value => <option key={value.name} value={value.name} label={value.location} />)}</datalist></div>
    {(lists.datasetsBusy || lists.datasetsNote || dataset?.location) && <div className="property-row"><span /><p className="field-note" role="status">{lists.datasetsBusy ? 'Loading datasets…' : [lists.datasetsNote, dataset?.location && !options.location ? `${dataset.name} is in ${dataset.location}.` : ''].filter(Boolean).join(' ')}</p></div>}
  </>
}

const serviceAccountSchema = z.email().max(bigQueryLimits.serviceAccount)
const impersonateFormatError = 'Enter the service account as its email address, such as name@project.iam.gserviceaccount.com.'

/** Draft text for BigQuery's inline Advanced tab, kept by ConnectDialog so switching tabs never drops edits or errors. */
export interface BigQueryAdvancedDraft {
  readonly amount: string
  readonly unit: ByteUnit
  readonly impersonate: string
  readonly adding: string
  readonly extraError: string
  /** Prompt above as typed; undefined until edited, when the field shows the form's or saved threshold. */
  readonly threshold?: string
}
/** Initialises BigQuery Advanced draft fields from loaded options (only on load/choose/reset, never while typing). */
export function bigQueryAdvancedDraftFrom(options: Pick<BigQueryConnectionOptions, 'maximumBytesBilled' | 'impersonateServiceAccount'>): BigQueryAdvancedDraft {
  const bytes = splitBytes(options.maximumBytesBilled)
  return { amount: bytes.amount, unit: bytes.unit, impersonate: options.impersonateServiceAccount ?? '', adding: '', extraError: '' }
}
/** First validation problem in the BigQuery Advanced draft, or empty when every edited field is valid. */
export function bigQueryAdvancedValidationError(draft: BigQueryAdvancedDraft): string {
  const bytes = joinBytes(draft.amount, draft.unit)
  if (!bytes.ok) return bytes.error
  const threshold = parseCostThreshold(draft.threshold ?? '')
  if (!threshold.ok) return threshold.error
  const impersonate = draft.impersonate.trim()
  if (impersonate && !serviceAccountSchema.safeParse(impersonate).success) return impersonateFormatError
  return draft.extraError
}

/** BigQuery's inline Advanced Properties tab panel: cost cap, prompt and threshold, impersonation, and extra read-only projects. */
export function BigQueryAdvanced({ options, savedCostPrompt, savedCostThreshold, defaultCostThreshold, projects, locked, draft, onDraftChange, onChange }: {
  options: BigQueryConnectionOptions
  savedCostPrompt?: false
  /** The saved entry's own threshold (GiB), and Options' (the placeholder). */
  savedCostThreshold?: number
  defaultCostThreshold: number
  projects: readonly BigQueryProject[]
  locked?: boolean
  draft: BigQueryAdvancedDraft
  onDraftChange(draft: BigQueryAdvancedDraft): void
  onChange(patch: Partial<Pick<BigQueryConnectionOptions, 'maximumBytesBilled' | 'costPrompt' | 'costThreshold' | 'impersonateServiceAccount' | 'extraProjects'>>): void
}) {
  const bytesResult = joinBytes(draft.amount, draft.unit)
  const impersonateTrimmed = draft.impersonate.trim()
  const impersonateError = impersonateTrimmed && !serviceAccountSchema.safeParse(impersonateTrimmed).success ? impersonateFormatError : ''
  const thresholdResult = parseCostThreshold(draft.threshold ?? '')
  const thresholdText = draft.threshold ?? String(shownCostThreshold(options, savedCostThreshold) ?? '')
  const error = (!bytesResult.ok ? bytesResult.error : '') || (!thresholdResult.ok ? thresholdResult.error : '') || impersonateError || draft.extraError
  const asking = (options.costPrompt ?? savedCostPrompt) !== false
  const extra = options.extraProjects ?? []

  function updateBytes(nextAmount: string, nextUnit: ByteUnit) {
    onDraftChange({ ...draft, amount: nextAmount, unit: nextUnit })
    const parsed = joinBytes(nextAmount, nextUnit)
    if (parsed.ok) onChange({ maximumBytesBilled: parsed.bytes })
  }
  function updateThreshold(next: string) {
    onDraftChange({ ...draft, threshold: next })
    const parsed = parseCostThreshold(next)
    if (parsed.ok) onChange({ costThreshold: advancedCostThreshold(parsed.value) })
  }
  function updateImpersonate(next: string) {
    onDraftChange({ ...draft, impersonate: next })
    const trimmed = next.trim()
    if (!trimmed) onChange({ impersonateServiceAccount: undefined })
    else if (serviceAccountSchema.safeParse(trimmed).success) onChange({ impersonateServiceAccount: trimmed })
  }
  function add() {
    const parsed = parseExtraProjects([...extra, draft.adding].join(' '), options.project)
    if (!parsed.ok) { onDraftChange({ ...draft, extraError: parsed.error }); return }
    onDraftChange({ ...draft, adding: '', extraError: '' })
    onChange({ extraProjects: parsed.projects.length ? parsed.projects : undefined })
  }
  function resetAll() {
    onDraftChange({ amount: '', unit: 'GiB', impersonate: '', adding: '', extraError: '' })
    // When the saved entry chose "Don't ask again" (costPrompt: false), explicit true is needed to turn the prompt back on;
    // likewise 0 clears a saved threshold.
    onChange({ maximumBytesBilled: undefined, costPrompt: savedCostPrompt === false ? true : undefined, costThreshold: advancedCostThreshold(undefined), impersonateServiceAccount: undefined, extraProjects: undefined })
  }
  return <div className="connect-advanced-panel">
    <div className="connect-advanced-toolbar">
      <span className="field-note">Changes apply live to this connection.</span>
      <button className="ui-button" data-control-variant="secondary" data-control-size="dense" type="button" disabled={locked} onClick={resetAll}>Reset Advanced</button>
    </div>
    <fieldset className="property-section"><legend>Cost</legend><div className="property-grid">
      <div className="property-row"><label htmlFor="bq-max-bytes">Maximum bytes billed</label><div className="property-input-action"><input className="ui-field" id="bq-max-bytes" inputMode="decimal" maxLength={24} disabled={locked} placeholder="No limit" value={draft.amount} aria-invalid={!bytesResult.ok || undefined} aria-describedby="bq-max-bytes-note" onChange={event => updateBytes(event.target.value, draft.unit)} /><select className="ui-field bq-unit" aria-label="Maximum bytes billed unit" disabled={locked} value={draft.unit} onChange={event => updateBytes(draft.amount, event.target.value as ByteUnit)}>{byteUnits.map(([name]) => <option key={name} value={name}>{name}</option>)}</select></div></div>
      <p className="field-note" id="bq-max-bytes-note">Every query on this connection is sent with this cap, and BigQuery fails a query that would bill more, at no charge. Empty means no limit.</p>
      <div className="property-row"><span /><label className="checkbox-label"><input type="checkbox" checked={asking} disabled={locked} aria-describedby="bq-cost-prompt-note" onChange={event => onChange({ costPrompt: advancedCostPrompt(options, savedCostPrompt, event.target.checked) })} />Ask before running a query over the cost threshold</label></div>
      <p className="field-note" id="bq-cost-prompt-note">Choosing "Don't ask again" in the prompt clears this.</p>
      <div className="property-row"><label htmlFor="bq-cost-threshold">Prompt above</label><div className="property-input-action"><input className="ui-field" id="bq-cost-threshold" inputMode="numeric" maxLength={9} disabled={locked} placeholder={`Options default (${defaultCostThreshold.toLocaleString('en-US')} GiB)`} value={thresholdText} aria-invalid={!thresholdResult.ok || undefined} aria-describedby="bq-cost-threshold-note" onChange={event => updateThreshold(event.target.value)} /><span className="bq-unit-label" aria-hidden="true">GiB</span></div></div>
      <p className="field-note" id="bq-cost-threshold-note">The threshold in GiB the cost prompt uses on this connection, in place of Tools › Options › Query Execution › BigQuery › Cost's, for every billed query while the prompt is on. Empty uses the Options threshold.</p>
    </div></fieldset>
    <fieldset className="property-section"><legend>Identity</legend><div className="property-grid">
      <div className="property-row"><label htmlFor="bq-impersonate">Impersonate service account</label><input className="ui-field" id="bq-impersonate" type="email" maxLength={bigQueryLimits.serviceAccount} disabled={locked} spellCheck={false} placeholder="name@project.iam.gserviceaccount.com" value={draft.impersonate} aria-invalid={!!impersonateError || undefined} aria-describedby="bq-impersonate-note" onChange={event => updateImpersonate(event.target.value)} /></div>
      <p className="field-note" id="bq-impersonate-note">Needs the Service Account Token Creator role on that account.</p>
    </div></fieldset>
    <fieldset className="property-section"><legend>Projects</legend><div className="property-grid">
      <div className="property-row"><label htmlFor="bq-extra-project">Extra projects (read-only)</label><div className="property-input-action"><input className="ui-field" id="bq-extra-project" list="bq-extra-projects" maxLength={bigQueryLimits.project} spellCheck={false} autoComplete="off" placeholder="Project id" value={draft.adding} aria-invalid={!!draft.extraError || undefined} disabled={locked || extra.length >= bigQueryLimits.extraProjects} onChange={event => onDraftChange({ ...draft, adding: event.target.value, extraError: '' })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add() } }} /><button className="ui-button" data-control-variant="secondary" type="button" disabled={locked || !draft.adding.trim()} onClick={add}>Add</button></div><datalist id="bq-extra-projects">{projects.filter(project => project.id !== options.project && !extra.includes(project.id)).map(project => <option key={project.id} value={project.id} label={project.friendlyName} />)}</datalist></div>
      {extra.length > 0 && <ul className="bq-extra-projects" aria-label="Extra projects">{extra.map(project => <li key={project}><span>{project}</span><button type="button" className="ui-button icon-button" aria-label={`Remove ${project}`} disabled={locked} onClick={() => onChange({ extraProjects: extra.filter(value => value !== project).length ? extra.filter(value => value !== project) : undefined })}><Icon name="close" /></button></li>)}</ul>}
      <p className="field-note">Listed for browsing and search. Queries still run, and bill, in {options.project.trim() || 'the connection\'s project'}.</p>
    </div></fieldset>
    {error && <p className="field-note" role="alert" data-tone="warning">{error}</p>}
  </div>
}
