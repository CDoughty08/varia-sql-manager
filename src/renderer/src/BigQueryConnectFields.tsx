import { useEffect, useRef, useState } from 'react'
import type { BigQueryAccount, BigQueryConnectionOptions, BigQueryProject, DatabaseInfo, ErrorDetails } from '../../shared/contracts'
import { bigQueryAuthenticationModes, usesKeyFile, type BigQueryAuthenticationMode } from '../../shared/auth'
import { bigQueryAuthenticationLabels, bigQueryKeyFileLabels } from '../../shared/bigquery-connections'
import { bigQueryLimits } from '../../shared/connections'
import { z } from 'zod'
import Icon from './Icon'
import DialogFooter from './kit/DialogFooter'
import { trapFocus } from './trap-focus'
import { advancedCostPrompt, bigQueryCredentialReady, bigQueryFormOptions, bigQueryReady, byteUnits, joinBytes, mergeProjects, parseExtraProjects, projectError, splitBytes, type ByteUnit } from './bigquery-connect-form'

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

/** The Advanced button's summary: how many of BigQuery's advanced settings are set. */
export function bigQueryAdvancedSummary(options: BigQueryConnectionOptions): string {
  const count = [options.maximumBytesBilled, options.costPrompt === false, options.impersonateServiceAccount, options.extraProjects?.length].filter(Boolean).length
  return count === 0 ? '' : count === 1 ? '1 property set' : `${count} properties set`
}

interface FieldsProps {
  options: BigQueryConnectionOptions
  /** The saved entry's cost-prompt choice, shown while the form names none. */
  savedCostPrompt?: false
  keyFileName?: string
  locked: boolean
  lists: BigQueryLists
  onChange(patch: Partial<BigQueryConnectionOptions>): void
  onAuthentication(mode: BigQueryAuthenticationMode): void
  onBrowseKeyFile(): void
  onAdvanced(): void
}

/** BigQuery's block of the Connect dialog's Connection Properties (docs/bigquery.md, Connect dialog). */
export function BigQueryConnectFields({ options, savedCostPrompt, keyFileName, locked, lists, onChange, onAuthentication, onBrowseKeyFile, onAdvanced }: FieldsProps) {
  const keyMode = usesKeyFile(options.authentication) ? options.authentication as Exclude<BigQueryAuthenticationMode, 'gcloud'> : undefined
  const ready = bigQueryCredentialReady(options)
  const projectProblem = options.project.trim() ? projectError(options.project) : undefined
  const advancedNote = bigQueryAdvancedSummary({ ...options, costPrompt: options.costPrompt ?? savedCostPrompt })
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
    <div className="advanced-action">{advancedNote && <span className="advanced-summary" id="connect-bq-advanced-summary">{advancedNote}</span>}<button className="ui-button" data-control-variant="secondary" type="button" disabled={locked} {...advancedNote ? { 'aria-describedby': 'connect-bq-advanced-summary' } : {}} onClick={onAdvanced}>Advanced…</button></div>
  </>
}

const serviceAccountSchema = z.email().max(bigQueryLimits.serviceAccount)
/** BigQuery's Advanced Properties: the cost cap and prompt, impersonation and extra read-only projects (a second project picker). */
export function BigQueryAdvanced({ options, savedCostPrompt, projects, onSave, onClose }: { options: BigQueryConnectionOptions; savedCostPrompt?: false; projects: readonly BigQueryProject[]; onSave(patch: Pick<BigQueryConnectionOptions, 'maximumBytesBilled' | 'costPrompt' | 'impersonateServiceAccount' | 'extraProjects'>): void; onClose(): void }) {
  const initialBytes = splitBytes(options.maximumBytesBilled)
  const asking = (options.costPrompt ?? savedCostPrompt) !== false
  const [costPrompt, setCostPrompt] = useState(asking)
  const [amount, setAmount] = useState(initialBytes.amount)
  const [unit, setUnit] = useState<ByteUnit>(initialBytes.unit)
  const [impersonate, setImpersonate] = useState(options.impersonateServiceAccount ?? '')
  const [extra, setExtra] = useState<string[]>(options.extraProjects ?? [])
  const [adding, setAdding] = useState('')
  const [error, setError] = useState('')
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => { form.current?.querySelector<HTMLInputElement>('input')?.focus() }, [])
  function add() {
    const parsed = parseExtraProjects([...extra, adding].join(' '), options.project)
    if (!parsed.ok) { setError(parsed.error); return }
    setExtra(parsed.projects); setAdding(''); setError('')
  }
  function save() {
    const bytes = joinBytes(amount, unit)
    if (!bytes.ok) { setError(bytes.error); return }
    const account = impersonate.trim()
    if (account && !serviceAccountSchema.safeParse(account).success) { setError('Enter the service account as its email address, such as name@project.iam.gserviceaccount.com.'); return }
    const pending = adding.trim() ? [...extra, adding] : extra
    const parsed = parseExtraProjects(pending.join(' '), options.project)
    if (!parsed.ok) { setError(parsed.error); return }
    const prompt = advancedCostPrompt(options, savedCostPrompt, costPrompt)
    onSave({ maximumBytesBilled: bytes.bytes, costPrompt: prompt, impersonateServiceAccount: account || undefined, extraProjects: parsed.projects.length ? parsed.projects : undefined })
  }
  return <div className="modal-backdrop advanced-backdrop"><form ref={form} className="connection-modal advanced-dialog" role="dialog" aria-modal="true" aria-labelledby="bq-advanced-title" onSubmit={event => { event.preventDefault(); save() }} onKeyDown={event => { trapFocus(event); if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }}>
    <div className="connection-heading"><h2 id="bq-advanced-title">Advanced Properties</h2><button type="button" className="ui-button icon-button" aria-label="Close advanced properties" onClick={onClose}><Icon name="close" /></button></div>
    <div className="connection-scroll">
      <fieldset className="property-section"><legend>Cost</legend><div className="property-grid">
        <div className="property-row"><label htmlFor="bq-max-bytes">Maximum bytes billed</label><div className="property-input-action"><input className="ui-field" id="bq-max-bytes" inputMode="decimal" maxLength={24} placeholder="No limit" value={amount} aria-describedby="bq-max-bytes-note" onChange={event => setAmount(event.target.value)} /><select className="ui-field bq-unit" aria-label="Maximum bytes billed unit" value={unit} onChange={event => setUnit(event.target.value as ByteUnit)}>{byteUnits.map(([name]) => <option key={name} value={name}>{name}</option>)}</select></div></div>
        <p className="field-note" id="bq-max-bytes-note">Every query on this connection is sent with this cap, and BigQuery fails a query that would bill more, at no charge. Empty means no limit.</p>
        <div className="property-row"><span /><label className="checkbox-label"><input type="checkbox" checked={costPrompt} aria-describedby="bq-cost-prompt-note" onChange={event => setCostPrompt(event.target.checked)} />Ask before running a query over the cost threshold</label></div>
        <p className="field-note" id="bq-cost-prompt-note">Tools › Options › Query Execution › BigQuery › Cost sets the threshold. Choosing "Don't ask again" in the prompt clears this.</p>
      </div></fieldset>
      <fieldset className="property-section"><legend>Identity</legend><div className="property-grid">
        <div className="property-row"><label htmlFor="bq-impersonate">Impersonate service account</label><input className="ui-field" id="bq-impersonate" type="email" maxLength={bigQueryLimits.serviceAccount} spellCheck={false} placeholder="name@project.iam.gserviceaccount.com" value={impersonate} aria-describedby="bq-impersonate-note" onChange={event => setImpersonate(event.target.value)} /></div>
        <p className="field-note" id="bq-impersonate-note">Needs the Service Account Token Creator role on that account.</p>
      </div></fieldset>
      <fieldset className="property-section"><legend>Projects</legend><div className="property-grid">
        <div className="property-row"><label htmlFor="bq-extra-project">Extra projects (read-only)</label><div className="property-input-action"><input className="ui-field" id="bq-extra-project" list="bq-extra-projects" maxLength={bigQueryLimits.project} spellCheck={false} autoComplete="off" placeholder="Project id" value={adding} disabled={extra.length >= bigQueryLimits.extraProjects} onChange={event => setAdding(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add() } }} /><button className="ui-button" data-control-variant="secondary" type="button" disabled={!adding.trim()} onClick={add}>Add</button></div><datalist id="bq-extra-projects">{projects.filter(project => project.id !== options.project && !extra.includes(project.id)).map(project => <option key={project.id} value={project.id} label={project.friendlyName} />)}</datalist></div>
        {extra.length > 0 && <ul className="bq-extra-projects" aria-label="Extra projects">{extra.map(project => <li key={project}><span>{project}</span><button type="button" className="ui-button icon-button" aria-label={`Remove ${project}`} onClick={() => setExtra(current => current.filter(value => value !== project))}><Icon name="close" /></button></li>)}</ul>}
        <p className="field-note">Listed for browsing and search. Queries still run, and bill, in {options.project.trim() || 'the connection\'s project'}.</p>
      </div></fieldset>
      {error && <p className="field-note" role="alert" data-tone="warning">{error}</p>}
    </div>
    <DialogFooter
      leading={<button className="ui-button" data-control-variant="secondary" type="button" onClick={() => { setAmount(''); setUnit('GiB'); setCostPrompt(true); setImpersonate(''); setExtra([]); setAdding(''); setError('') }}>Reset</button>}
      trailing={<>
        <button className="ui-button primary" type="submit">OK</button>
        <button className="ui-button" data-control-variant="secondary" type="button" onClick={onClose}>Cancel</button>
      </>}
    />
  </form></div>
}
