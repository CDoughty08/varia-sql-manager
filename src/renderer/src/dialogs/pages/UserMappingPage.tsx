import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type UIEvent } from 'react'
import { actionLimits } from '../../../../shared/actions/catalog.ts'
import { loginLimits, publicRole, userMappingMessages, type NewLoginDatabase, type NewLoginModel } from '../../../../shared/actions/logins.ts'
import { displayText } from '../../../../shared/explorer/refs.ts'
import { databaseChips } from '../../../../shared/explorer/status.ts'
import { defaultDensity, densities } from '../../../../shared/theme/metrics.ts'
import type { StatusTone } from '../../../../shared/theme/tones.ts'
import { useWorkbench } from '../../core/WorkbenchContext'
import StatusPill from '../../kit/StatusPill'
import { mappable, mappedUser, mappingOf, setMapped, setMappingRole, setMappingSchema, setMappingUser, type MappingDraft, type NewLoginDraft } from '../new-login'
import type { PageProps } from '../ObjectDialog'
import type { DatabaseRolesLookup } from '../ObjectDialogService'
import SubDialog from '../SubDialog'

/** Every row has one height, the density's row token (`--varia-row`, which the editor and … button are sized from), so only the
 *  rows in view (and a few more) render: a server lists up to 4,096 databases. */
export const userMappingRowHeight = densities[defaultDensity].row
/** The grid shows this many rows before it scrolls, as SSMS's upper grid does in its dialog. */
const shownRows = 9
const overscan = 6
export const userMappingColumns = ['map', 'database', 'user', 'schema'] as const
export type UserMappingColumn = typeof userMappingColumns[number]
const headers: Readonly<Record<UserMappingColumn, string>> = { map: 'Map', database: 'Database', user: 'User', schema: 'Default Schema' }
/** The chip of a row that cannot be mapped: its state (OFFLINE, RESTORING…) as Object Explorer shows it, no access, or read-only. */
const noAccess = { tone: 'warning', label: 'NO ACCESS', title: 'This login cannot open the database.' } as const
export function unavailableChip(database: NewLoginDatabase): { readonly tone: StatusTone; readonly label: string; readonly title: string } | undefined {
  if (mappable(database)) return undefined
  if (database.state === 0 && !database.accessible) return noAccess
  const chip = databaseChips({ name: database.name, state: database.state, userAccess: 0, readOnly: database.readOnly, standby: false })[0]
  return chip ? { tone: chip.tone, label: chip.label, title: chip.title } : noAccess
}

/** The rows [first, last) a viewport shows, with overscan. */
export function mappingRange(scrollTop: number, height: number, count: number): { readonly first: number; readonly last: number } {
  const first = Math.max(0, Math.floor(scrollTop / userMappingRowHeight) - overscan)
  return { first, last: Math.min(count, Math.ceil((scrollTop + height) / userMappingRowHeight) + overscan) }
}

interface Editing { readonly database: string; readonly column: 'user' | 'schema'; readonly text: string }

/**
 * SSMS's "Users mapped to this login:" grid: Map, Database, User and Default Schema (with … for Select Schema). One focusable
 * grid with an active cell (aria-activedescendant): arrows, Home, End and Page keys move it; Space toggles Map; F2, Enter or
 * typing edits User or Default Schema of a mapped row in one native field (Enter or Tab commits, Escape cancels without closing
 * the dialog); Alt+Down opens Select Schema. Selecting a row selects its database below, which reads its roles. Databases that
 * are not online or not open to this login are greyed with their state, as SSMS greys them.
 */
function UserMappingGrid({ model, draft, editable, onSchema }: { model: NewLoginModel; draft: NewLoginDraft; editable: boolean; onSchema(database: string): void }) {
  const { dialogs } = useWorkbench()
  const root = useRef<HTMLDivElement | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const [column, setColumn] = useState<UserMappingColumn>('map')
  const [editing, setEditingState] = useState<Editing>()
  // Read synchronously: Escape, then the blur its refocus causes, must not commit what Escape discarded.
  const live = useRef<Editing | undefined>(undefined)
  const setEditing = (value: Editing | undefined) => { live.current = value; setEditingState(value) }
  const [top, setTop] = useState(0)
  const databases = model.databases, count = databases.length
  const row = draft.mappingDatabase === undefined ? -1 : databases.findIndex(database => database.name === draft.mappingDatabase)
  const height = Math.min(Math.max(count, 1), shownRows) * userMappingRowHeight

  // The current row stays in view as the keys move it.
  useLayoutEffect(() => {
    const element = body.current
    if (!element || row < 0) return
    const at = row * userMappingRowHeight
    if (at < element.scrollTop) element.scrollTop = at
    else if (at + userMappingRowHeight > element.scrollTop + element.clientHeight) element.scrollTop = at + userMappingRowHeight - element.clientHeight
  }, [row])

  const focusGrid = () => root.current?.focus({ preventScroll: true })
  const select = (index: number, to: UserMappingColumn = column) => {
    const database = databases[index]
    if (!database) return
    setColumn(to)
    if (database.name !== draft.mappingDatabase) dialogs.updateDraft({ mappingDatabase: database.name })
  }
  const toggle = (index: number) => {
    const database = databases[index]
    if (!database || !editable || !mappable(database)) return
    dialogs.updateDraft(setMapped(draft, database.name, !mappingOf(draft, database.name).map))
  }
  const begin = (index: number, to: UserMappingColumn, text?: string) => {
    const database = databases[index]
    if (!database || !editable || (to !== 'user' && to !== 'schema') || !mappable(database) || !mappingOf(draft, database.name).map) return
    select(index, to)
    const mapping = mappingOf(draft, database.name)
    setEditing({ database: database.name, column: to, text: text ?? (to === 'user' ? mappedUser(draft, mapping) : mapping.defaultSchema) })
  }
  const commit = () => {
    const value = live.current
    setEditing(undefined)
    if (!value) return
    dialogs.updateDraft(value.column === 'user' ? setMappingUser(draft, value.database, value.text) : setMappingSchema(draft, value.database, value.text))
  }

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return
    const col = userMappingColumns.indexOf(column), mod = event.ctrlKey || event.metaKey
    if (editing) {
      // Escape ends the edit, never the dialog.
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(undefined); focusGrid() }
      else if (event.key === 'Enter') { event.preventDefault(); commit(); focusGrid() }
      else if (event.key === 'Tab') {
        event.preventDefault()
        commit()
        setColumn(editing.column === 'user' && !event.shiftKey ? 'schema' : editing.column === 'schema' && event.shiftKey ? 'user' : editing.column)
        focusGrid()
      }
      return
    }
    const page = shownRows - 1, current = Math.max(row, 0)
    let handled = true
    switch (event.key) {
      case 'ArrowDown':
        if (event.altKey) { if (column === 'schema' && row >= 0 && editable && mappable(databases[row]) && mappingOf(draft, databases[row].name).map) onSchema(databases[row].name) }
        else select(row < 0 ? 0 : Math.min(count - 1, row + 1))
        break
      case 'ArrowUp': select(row < 0 ? 0 : Math.max(0, row - 1)); break
      case 'ArrowLeft': if (row < 0) select(0); setColumn(userMappingColumns[Math.max(0, col - 1)]); break
      case 'ArrowRight': if (row < 0) select(0); setColumn(userMappingColumns[Math.min(userMappingColumns.length - 1, col + 1)]); break
      case 'Home': if (mod) select(0); else { if (row < 0) select(0); setColumn('map') } break
      case 'End': if (mod) select(count - 1); else { if (row < 0) select(0); setColumn('schema') } break
      case 'PageDown': select(Math.min(count - 1, current + page)); break
      case 'PageUp': select(Math.max(0, current - page)); break
      case ' ': if (row >= 0) toggle(row); else select(0); break
      case 'F2': case 'Enter': if (row >= 0) begin(row, column); break
      default:
        // Typing starts editing the cell with the character typed, as in SSMS's grids.
        if (event.key.length === 1 && !mod && !event.altKey && row >= 0 && (column === 'user' || column === 'schema')) begin(row, column, event.key)
        else handled = false
    }
    if (handled) event.preventDefault()
  }

  const scroll = (event: UIEvent<HTMLDivElement>) => { const value = event.currentTarget.scrollTop; setTop(current => current === value ? current : value) }
  const { first, last } = mappingRange(top, height, count)
  const cellId = (index: number, of: UserMappingColumn) => `user-mapping-${index}-${of}`

  return <div ref={root} className="user-mapping-grid" role="grid" aria-labelledby="user-mapping-label" aria-rowcount={count + 1} aria-colcount={userMappingColumns.length} tabIndex={0}
    aria-activedescendant={editing || row < 0 ? undefined : cellId(row, column)} onKeyDown={keyDown}>
    <div className="user-mapping-head" role="row" aria-rowindex={1}>
      {userMappingColumns.map(of => <span key={of} className="user-mapping-cell" role="columnheader">{headers[of]}</span>)}
    </div>
    {/* Out of the tab order: Chromium makes a scrolling box a tab stop of its own, which here has no role or name. A click there
        focuses the grid, whose active cell the keys move. */}
    <div ref={body} className="user-mapping-body" style={{ height }} tabIndex={-1} onScroll={scroll} onFocus={event => { if (event.target === event.currentTarget) focusGrid() }}>
      <div style={{ height: count * userMappingRowHeight, position: 'relative' }}>
        {databases.slice(first, last).map((database, offset) => {
          const index = first + offset, mapping: MappingDraft = mappingOf(draft, database.name), chip = unavailableChip(database), usable = !chip
          const mapped = usable && mapping.map, selected = index === row
          const cell = (of: UserMappingColumn) => ({
            id: cellId(index, of), role: 'gridcell', 'aria-colindex': userMappingColumns.indexOf(of) + 1, 'aria-selected': selected && of === column,
            'data-active': (selected && of === column) || undefined, onPointerDown: () => select(index, of)
          })
          const field = (of: 'user' | 'schema') => editing?.database === database.name && editing.column === of
            ? <input className="user-mapping-editor" autoFocus aria-label={`${headers[of]} in ${database.name}`} maxLength={actionLimits.newName} spellCheck={false} value={editing.text}
              onChange={event => setEditing({ ...editing, text: event.target.value })} onBlur={() => commit()} onFocus={event => { const end = event.currentTarget.value.length; event.currentTarget.setSelectionRange(end, end) }} />
            : <span className="user-mapping-text"><bdi>{mapped ? displayText(of === 'user' ? mappedUser(draft, mapping) : mapping.defaultSchema) : ''}</bdi></span>
          return <div key={database.name} className="user-mapping-row" role="row" aria-rowindex={index + 2} aria-selected={selected} aria-disabled={!usable || undefined}
            data-selected={selected || undefined} data-unavailable={!usable || undefined} style={{ top: index * userMappingRowHeight, height: userMappingRowHeight }}>
            <span {...cell('map')} className="user-mapping-cell user-mapping-map">
              <input type="checkbox" tabIndex={-1} aria-label={`Map ${database.name}`} checked={mapped} disabled={!editable || !usable}
                onChange={() => { select(index, 'map'); toggle(index); focusGrid() }} />
            </span>
            <span {...cell('database')} className="user-mapping-cell user-mapping-database">
              <span className="user-mapping-text" title={displayText(database.name)}><bdi>{displayText(database.name)}</bdi></span>
              {chip && <StatusPill tone={chip.tone} label={chip.label} title={chip.title} size="small" icon={null} />}
            </span>
            <span {...cell('user')} className="user-mapping-cell" onDoubleClick={() => begin(index, 'user')}>{field('user')}</span>
            <span {...cell('schema')} className="user-mapping-cell user-mapping-schema" onDoubleClick={() => begin(index, 'schema')}>
              {field('schema')}
              {mapped && editing?.database !== database.name && <button type="button" className="user-mapping-browse" tabIndex={-1} aria-label={`Select Schema for ${database.name}`} title="Select Schema"
                disabled={!editable} onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.preventDefault()}
                onClick={() => { focusGrid(); select(index, 'schema'); onSchema(database.name) }}>…</button>}
            </span>
          </div>
        })}
      </div>
    </div>
  </div>
}

/** Select Schema: the database's schemas, read with its roles; OK puts the chosen one in Default Schema. */
function SelectSchema({ database, lookup, current, onOk, onCancel }: { database: string; lookup: DatabaseRolesLookup | undefined; current: string; onOk(schema: string): void; onCancel(): void }) {
  const schemas = lookup?.state === 'ready' ? lookup.value.schemas : []
  const [chosen, setChosen] = useState('')
  const value = chosen || (schemas.includes(current) ? current : schemas[0] ?? '')
  return <SubDialog title="Select Schema" okDisabled={!value} onOk={() => onOk(value)} onCancel={onCancel} initialFocus="select-schema-list">
    <label htmlFor="select-schema-list">Schemas in <bdi>{displayText(database)}</bdi>:</label>
    {!lookup || lookup.state === 'loading' ? <p className="field-note" role="status">{userMappingMessages.rolesLoading}</p>
      : lookup.state === 'failed' ? <p className="field-note" role="alert">{lookup.error.message}</p>
        : schemas.length === 0 ? <p className="field-note">{userMappingMessages.noSchemas}</p>
          : <select id="select-schema-list" className="database-owner-list" size={12} value={value} onChange={event => setChosen(event.target.value)} onDoubleClick={() => value && onOk(value)}>
            {schemas.map(schema => <option key={schema} value={schema}>{displayText(schema)}</option>)}
          </select>}
    {lookup?.state === 'ready' && lookup.value.schemasTruncated && <p className="field-note">{`Only the first ${loginLimits.schemas.toLocaleString('en-US')} schemas are listed.`}</p>}
  </SubDialog>
}

/**
 * New Login's User Mapping page (D2b), in SSMS's layout: the "Users mapped to this login:" grid; "Guest account enabled for:" the
 * selected database, read-only as in SSMS; and "Database role membership for:" it, public checked and greyed, the others
 * enabled once its row is mapped. The selected database's roles, guest state and schemas are read when it is first selected.
 */
export default function UserMappingPage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const model = open.model as NewLoginModel | undefined, draft = open.draft as NewLoginDraft | undefined
  const [schemaFor, setSchemaFor] = useState<string>()
  const selected = draft?.mappingDatabase
  useEffect(() => { if (selected !== undefined) dialogs.loadDatabaseRoles(selected) }, [dialogs, selected])
  if (!model || !draft) return null
  const lookup = selected === undefined ? undefined : open.databaseRoles?.get(selected)
  const database = selected === undefined ? undefined : model.databases.find(item => item.name === selected)
  const mapping = selected === undefined ? undefined : mappingOf(draft, selected)
  const mapped = !!database && mappable(database) && !!mapping?.map
  const ready = lookup?.state === 'ready' ? lookup.value : undefined
  const chosen = new Set(mapping?.roles ?? [])
  const name = selected === undefined ? null : <bdi>{displayText(selected)}</bdi>
  const mappedCount = draft.mappings.filter(item => item.map).length
  return <div className="new-login-page user-mapping-page">
    <p className="user-mapping-label" id="user-mapping-label">Users mapped to this login:</p>
    <UserMappingGrid model={model} draft={draft} editable={editable} onSchema={database => { dialogs.loadDatabaseRoles(database); setSchemaFor(database) }} />
    {(model.databasesTruncated || mappedCount > loginLimits.mappings) && <ul className="object-dialog-warnings" aria-label="Notes">
      {model.databasesTruncated && <li><span>{`Only the first ${model.databases.length.toLocaleString('en-US')} databases are listed.`}</span></li>}
      {mappedCount > loginLimits.mappings && <li><span>{userMappingMessages.mappingsLimit}</span></li>}
    </ul>}
    {/* One span, so the label's flex gap does not widen the space before the name. */}
    <label className="checkbox-label"><input type="checkbox" checked={!!ready?.guest} disabled /><span>Guest account enabled for: {name}</span></label>
    <p className="user-mapping-label" id="user-mapping-roles-label">Database role membership for: {name}</p>
    <div className="user-mapping-roles-box">
      {selected === undefined ? <p className="field-note">Select a database above to see its roles.</p>
        : database && !mappable(database) ? <p className="field-note">{userMappingMessages.unavailable}</p>
          : !lookup || lookup.state === 'loading' ? <p className="field-note" role="status">{userMappingMessages.rolesLoading}</p>
            : lookup.state === 'failed' ? <div className="user-mapping-failed" role="alert"><span>{lookup.error.message}</span>
              <button type="button" onClick={() => dialogs.loadDatabaseRoles(selected)}>Retry</button></div>
              : <fieldset className="user-mapping-roles" role="group" aria-labelledby="user-mapping-roles-label" aria-describedby={mapped ? undefined : 'user-mapping-roles-note'} disabled={!editable}>
                {lookup.value.roles.map(role => role === publicRole
                  ? <label key={role} className="checkbox-label"><input type="checkbox" checked disabled /><bdi className="user-mapping-role">{role}</bdi></label>
                  : <label key={role} className="checkbox-label"><input type="checkbox" checked={mapped && chosen.has(role)} disabled={!mapped}
                    onChange={event => dialogs.updateDraft(setMappingRole(draft, selected, role, event.target.checked))} /><bdi className="user-mapping-role" title={displayText(role)}>{displayText(role)}</bdi></label>)}
              </fieldset>}
      {ready && !mapped && database && mappable(database) && <p className="field-note" id="user-mapping-roles-note">{userMappingMessages.notMapped}</p>}
      {ready?.rolesTruncated && <p className="field-note">{`Only the first ${loginLimits.roles.toLocaleString('en-US')} roles are listed.`}</p>}
    </div>
    {schemaFor !== undefined && <SelectSchema database={schemaFor} lookup={open.databaseRoles?.get(schemaFor)} current={mappingOf(draft, schemaFor).defaultSchema}
      onCancel={() => setSchemaFor(undefined)} onOk={schema => { const database = schemaFor; setSchemaFor(undefined); dialogs.updateDraft(setMappingSchema(draft, database, schema)) }} />}
  </div>
}
