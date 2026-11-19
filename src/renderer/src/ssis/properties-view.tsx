// What an SSIS properties document shows, from its state: the path to the object, the header's facts and state, and
// the sections. Pure, so tests render it without a workbench; SsisProperties.tsx puts it in the document frame.
import type { ReactNode } from 'react'
import { displayText } from '../../../shared/explorer/refs.ts'
import type { LocalTableData } from '../../../shared/results/local-table.ts'
import { catalogDatabase, referenceTypes, ssisDocumentSpecs, ssisLimits, validationStatuses, valueTypes } from '../../../shared/ssis/catalog.ts'
import type { SsisParameter } from '../../../shared/ssis/schema.ts'
import type { StatusTone } from '../../../shared/theme/tones'
import { formatCount } from '../results/status'
import type { GridViewState } from '../results/ResultsService'
import type { Crumb, Fact, FrameSection } from '../kit/DocumentFrame'
import { LocalGrid } from '../grid/LocalGrid'
import type { SsisPropertiesModel, SsisPropertiesState } from './SsisPropertiesService'

/** What General says to a screen reader for an empty value, where the page draws a dash. */
export const noneLabel = 'None'
/** What a sensitive parameter or variable shows: the catalog never returns its value, and Varia never reads it. */
export const sensitiveMask = '********'

/**
 * A catalog time as the catalog stores it, in its own offset ("2026-10-21 14:05:06 +02:00"): never converted to the
 * local clock, so the offset the server wrote stays visible. Fractions of a second are left out; anything else shows as sent.
 */
export function ssisTime(iso: string | undefined): string {
  if (!iso) return ''
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(iso)
  return match ? `${match[1]} ${match[2]} ${match[3] === 'Z' ? '+00:00' : match[3]}` : iso
}
export const yesNo = (value: boolean): string => value ? 'Yes' : 'No'
/** A validation_status code as words; a code the catalogue does not know shows as the catalog stores it. */
export function validationLabel(code: string): string { return validationStatuses.find(status => status.code === code)?.label ?? code }
/** Where a parameter's value comes from: its design default, a literal, or an environment variable. */
export function parameterSource(parameter: SsisParameter): string {
  if (!parameter.valueSet) return 'Default'
  return valueTypes.find(type => type.code === parameter.valueType)?.label ?? parameter.valueType
}
/** The value the parameter takes: masked when sensitive, the variable it names, the server value, or the design default. */
export function parameterValue(parameter: SsisParameter): string {
  if (parameter.sensitive) return sensitiveMask
  if (parameter.valueSet && parameter.valueType === 'R') return parameter.variable ?? ''
  return (parameter.valueSet ? parameter.value : parameter.designDefault) ?? ''
}
/** A relative reference's environment is in the project's own folder, which SSMS shows as ".". */
export const referenceFolder = (folder: string | undefined): string => folder ?? '.'
export const referenceTypeLabel = (type: 'R' | 'A'): string => referenceTypes.find(item => item.code === type)?.label ?? type

/** The path to the object: the server, the catalog, its folder and, for a package, its project. */
export function ssisCrumbs(state: SsisPropertiesState): Crumb[] {
  const { target } = state
  const path = [state.serverLabel, 'Integration Services Catalogs', catalogDatabase, ...target.ssisFolder !== undefined ? [target.ssisFolder] : [], ...target.ssisProject !== undefined ? [target.ssisProject] : []]
  return path.map(label => ({ label: displayText(label), title: label }))
}

/** The header's two or three facts that say most about the object. */
export function ssisFacts(model: SsisPropertiesModel | undefined): Fact[] {
  switch (model?.view) {
    case 'folder': return [{ label: 'Projects', value: formatCount(model.projects) }, { label: 'Environments', value: formatCount(model.environments) }, { label: 'Created', value: ssisTime(model.created) }]
    case 'project': return [{ label: 'Folder', value: displayText(model.folder), title: model.folder }, { label: 'Last deployed', value: ssisTime(model.deployed) }, { label: 'Validation', value: validationLabel(model.validationStatus) }]
    case 'package': return [{ label: 'Project', value: displayText(model.project), title: model.project }, { label: 'Entry point', value: yesNo(model.entryPoint) }, { label: 'Version', value: model.version }]
    case 'environment': return [{ label: 'Folder', value: displayText(model.folder), title: model.folder }, { label: 'Variables', value: formatCount(model.variables.length) }]
    default: return []
  }
}

export type HeaderState = { readonly kind: 'pill'; readonly tone: StatusTone; readonly label: string; readonly title?: string } | { readonly kind: 'updated'; readonly at: number } | { readonly kind: 'stale'; readonly since: number }
/**
 * The header's state: loading, refreshing, gone, failed, disconnected, or how old the shown model is. A refresh that
 * failed over a model (SSISDB locked, a timeout) still says how old that model is, as stale, since it is what shows;
 * the failure itself is the notice above the sections.
 */
export function ssisHeaderState(state: SsisPropertiesState): HeaderState | undefined {
  if (state.loading) return { kind: 'pill', tone: 'running', label: state.model ? 'Refreshing' : 'Loading' }
  if (state.gone) return { kind: 'pill', tone: 'critical', label: state.error?.code === 'CATALOG_MISSING' ? 'Catalog missing' : 'Not found', title: state.error?.message }
  if (state.disconnected) return { kind: 'pill', tone: 'warning', label: 'Disconnected', title: `${state.serverLabel} is not connected.` }
  if (state.error && state.model && state.loadedAt !== undefined) return { kind: 'stale', since: state.loadedAt }
  if (state.error) return { kind: 'pill', tone: 'critical', label: 'Failed', title: state.error.message }
  return state.loadedAt === undefined ? undefined : { kind: 'updated', at: state.loadedAt }
}

/** Under a truncated answer: which lists stop short. */
export function truncatedNote(state: SsisPropertiesState): string | undefined {
  const model = state.model
  if (!model || model.view === 'folder' || !model.truncated) return undefined
  const noun = ssisDocumentSpecs[state.kind].noun, first = formatCount(ssisLimits.rows)
  if (model.view === 'project') return `This ${noun} has more packages, parameters or references than one read returns: each list shows its first ${first}.`
  return `This ${noun} has more ${model.view === 'package' ? 'parameters' : 'variables'} than one read returns: the list shows its first ${first}.`
}

/** A value the catalog left empty: a muted dash (None to a screen reader). */
function valueText(value: string): ReactNode {
  if (value === '') return <span className="ssis-properties-none"><span aria-hidden="true">—</span><span className="visually-hidden">{noneLabel}</span></span>
  return displayText(value)
}

type Row = readonly [label: string, value: string]
/** The General section: label and value pairs, as SSMS's General page lists them (facts as text, not input boxes). */
function General({ rows }: { readonly rows: readonly Row[] }) {
  return <dl className="ssis-properties">
    {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value}><bdi>{valueText(value)}</bdi></dd></div>)}
  </dl>
}

/** A list's column: its title and a row's value as the page shows it (a sensitive value already masked). */
interface ListColumn<T> { readonly title: string; readonly value: (row: T) => string }

/**
 * A list's rows as the page shows them (docs/architecture.md, Local tables): control characters named, a sensitive value
 * as stars, an empty value as an empty cell. Copy and Save write this text, so nothing the page does not show can leave.
 */
export function listTable<T>(rows: readonly T[], columns: readonly ListColumn<T>[]): LocalTableData {
  return { columns: columns.map(column => ({ name: column.title })), rows: rows.map(row => columns.map(column => displayText(column.value(row)))) }
}

/** The most rows a list shows before it scrolls inside its section. */
export const listRows = 20

export interface SsisListProps {
  readonly label: string
  readonly table: LocalTableData
  readonly empty: string
  readonly suggestedName: string
  /** Scroll, widths, selection and sort, kept per document so a tab switched back to shows the list as it was left. */
  readonly state: GridViewState
}
/**
 * A read-only list of at most ssisLimits.rows rows in the results grid (LocalGrid): a page, with Save, as tall as its rows
 * up to listRows (the section column scrolls, so there is no area to fill), or what an empty one says.
 */
export function SsisList({ label, table, empty, suggestedName, state }: SsisListProps) {
  return <div className="ssis-properties-grid">
    <LocalGrid table={table} label={label} preset="page" fit maxRows={listRows} empty={empty} suggestedName={suggestedName} state={state} />
  </div>
}

/** A document's view of one list, made on first use. */
function listState(states: Map<string, GridViewState>, list: string): GridViewState {
  let state = states.get(list)
  if (!state) states.set(list, state = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false })
  return state
}

const parameterColumns: readonly ListColumn<SsisParameter>[] = [
  { title: 'Name', value: parameter => parameter.name },
  { title: 'Data type', value: parameter => parameter.dataType },
  { title: 'Value', value: parameterValue },
  { title: 'Source', value: parameterSource },
  { title: 'Required', value: parameter => yesNo(parameter.required) },
  { title: 'Sensitive', value: parameter => yesNo(parameter.sensitive) },
  { title: 'Description', value: parameter => parameter.description ?? '' }
]

type SectionContent = Readonly<Record<string, { readonly content: ReactNode; readonly count?: number }>>
/**
 * Each model's sections, built once: the document renders again on every snapshot (a section chosen, another document's
 * read), and the same elements let React skip lists of up to ssisLimits.rows rows each. Models are immutable snapshots.
 */
const contents = new WeakMap<Map<string, GridViewState>, WeakMap<SsisPropertiesModel, SectionContent>>()
function sectionContent(model: SsisPropertiesModel, lists: Map<string, GridViewState>): SectionContent {
  // By document (its lists) and model: the content holds the document's grid views, so one model never lends another
  // document its views.
  let byModel = contents.get(lists)
  if (!byModel) contents.set(lists, byModel = new WeakMap())
  let content = byModel.get(model)
  if (!content) byModel.set(model, content = buildContent(model, lists))
  return content
}
/** The general rows and the lists of a model, by section id. */
function buildContent(model: SsisPropertiesModel, lists: Map<string, GridViewState>): SectionContent {
  // A list's file is named for the object and the list ("Loads-Parameters"), as a result's is for its query.
  const list = <T,>(label: string, rows: readonly T[], columns: readonly ListColumn<T>[], empty: string) => ({
    count: rows.length,
    content: <SsisList label={label} table={listTable(rows, columns)} empty={empty} suggestedName={`${displayText(model.name)}-${label}`} state={listState(lists, label)} />
  })
  switch (model.view) {
    case 'folder': return {
      general: { content: <General rows={[['Name', model.name], ['Identifier', String(model.id)], ['Description', model.description ?? ''], ['Created by', model.createdBy], ['Created', ssisTime(model.created)],
        ['Projects', formatCount(model.projects)], ['Environments', formatCount(model.environments)]]} /> }
    }
    case 'project': return {
      general: { content: <General rows={[['Name', model.name], ['Identifier', String(model.id)], ['Description', model.description ?? ''], ['Folder', model.folder],
        ['Project format version', model.formatVersion === undefined ? '' : String(model.formatVersion)], ['Version LSN', String(model.versionLsn)], ['Deployed by', model.deployedBy],
        ['Last deployed', ssisTime(model.deployed)], ['Created', ssisTime(model.created)], ['Validation status', validationLabel(model.validationStatus)], ['Last validated', ssisTime(model.validated)]]} /> },
      packages: list('Packages', model.packages, [
        { title: 'Name', value: item => item.name }, { title: 'Entry point', value: item => yesNo(item.entryPoint) },
        { title: 'Version', value: item => item.version }, { title: 'Description', value: item => item.description ?? '' }
      ], 'This project has no packages.'),
      parameters: list('Parameters', model.parameters, parameterColumns, 'This project has no parameters.'),
      references: list('References', model.references, [
        { title: 'Environment', value: item => item.environment }, { title: 'Folder', value: item => referenceFolder(item.folder) }, { title: 'Type', value: item => referenceTypeLabel(item.type) },
        { title: 'Validation status', value: item => validationLabel(item.validationStatus) }
      ], 'This project references no environments.')
    }
    case 'package': return {
      general: { content: <General rows={[['Name', model.name], ['Identifier', String(model.id)], ['Description', model.description ?? ''], ['Folder', model.folder], ['Project', model.project],
        ['Entry point', yesNo(model.entryPoint)], ['Package format version', String(model.formatVersion)], ['Version', model.version], ['Version comments', model.versionComments ?? ''],
        ['Validation status', validationLabel(model.validationStatus)], ['Last validated', ssisTime(model.validated)]]} /> },
      parameters: list('Parameters', model.parameters, parameterColumns, 'This package has no parameters.')
    }
    case 'environment': return {
      general: { content: <General rows={[['Name', model.name], ['Identifier', String(model.id)], ['Description', model.description ?? ''], ['Folder', model.folder], ['Created by', model.createdBy],
        ['Created', ssisTime(model.created)]]} /> },
      variables: list('Variables', model.variables, [
        { title: 'Name', value: item => item.name }, { title: 'Type', value: item => item.type },
        { title: 'Value', value: item => item.sensitive ? sensitiveMask : item.value ?? '' },
        { title: 'Sensitive', value: item => yesNo(item.sensitive) }, { title: 'Description', value: item => item.description ?? '' }
      ], 'This environment has no variables.')
    }
  }
  return {}
}

const countNouns: Readonly<Record<string, readonly [one: string, many: string]>> = {
  packages: ['package', 'packages'], parameters: ['parameter', 'parameters'], references: ['reference', 'references'], variables: ['variable', 'variables']
}
/** The document's sections, with a count after each list's title; none before the first model arrives. */
export function ssisSectionViews(state: SsisPropertiesState): FrameSection[] {
  if (!state.model) return []
  const content = sectionContent(state.model, state.lists)
  return ssisDocumentSpecs[state.kind].sections.map(section => {
    const item = content[section.id], nouns = countNouns[section.id]
    const count = item?.count === undefined || !nouns ? undefined : { text: formatCount(item.count), label: `${formatCount(item.count)} ${item.count === 1 ? nouns[0] : nouns[1]}` }
    return { id: section.id, title: section.title, content: item?.content, ...count ? { count } : {} }
  })
}
