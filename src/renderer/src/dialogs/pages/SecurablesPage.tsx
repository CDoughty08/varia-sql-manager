import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type UIEvent } from 'react'
import { loginLimits, loginMessages, permissionsProtected, type LoginFacts } from '../../../../shared/actions/logins.ts'
import {
  addObjectsChoices, addObjectsText, effectiveUnavailableSubtypes, objectTypeOrder, permissionCascades, permissionChecked, permissionColumns, reservedPermission, securableKey, securablesMessages,
  securableSpecs, toggledPermission,
  type AddObjectsChoice, type NamedSecurableType, type PermissionColumn, type PermissionState, type SecurableRef, type SecurableType
} from '../../../../shared/actions/securables.ts'
import { displayText } from '../../../../shared/explorer/refs.ts'
import { useWorkbench } from '../../core/WorkbenchContext'
import Icon from '../../Icon'
import type { PageProps } from '../ObjectDialog'
import type { EffectiveLookup } from '../ObjectDialogService'
import type { NewLoginDraft } from '../new-login'
import {
  addSecurables, grantorOf, objectsOfTypes, offeredPermissions, permissionChoices, permissionStateOf, removeSecurable, securableName, securablesFull, securableTypeLabel, serverRef,
  setPermission,
  type SecurablesModelOf
} from '../securables'
import SubDialog from '../SubDialog'
import { loginBlocked, LoginBlockedNote } from './NewLoginPages'
import { mappingRange, userMappingRowHeight } from './UserMappingPage'

/** The upper grid shows this many rows before it scrolls; the Explicit grid this many. */
const shownRows = 6
const permissionRows = 8
const columnTitles: Readonly<Record<PermissionColumn, string>> = { grant: 'Grant', withGrant: 'With Grant', deny: 'Deny' }
/** The hidden text that tells assistive technology why CONNECT SQL's boxes are greyed. */
const reservedNote = 'securables-reserved-note'

/** "Securables:": Name and Type, one focusable grid whose arrows, Home, End and Page keys move the selected row; Delete removes it. */
function SecurablesGrid({ model, draft, onSelect, onRemove }: { model: SecurablesModelOf; draft: NewLoginDraft; onSelect(key: string): void; onRemove(key: string): void }) {
  const root = useRef<HTMLDivElement | null>(null), body = useRef<HTMLDivElement | null>(null)
  const [top, setTop] = useState(0)
  const rows = draft.securables, count = rows.length
  const row = draft.securable === undefined ? -1 : rows.findIndex(ref => securableKey(ref) === draft.securable)
  const height = Math.min(Math.max(count, 1), shownRows) * userMappingRowHeight
  useLayoutEffect(() => {
    const element = body.current
    if (!element || row < 0) return
    const at = row * userMappingRowHeight
    if (at < element.scrollTop) element.scrollTop = at
    else if (at + userMappingRowHeight > element.scrollTop + element.clientHeight) element.scrollTop = at + userMappingRowHeight - element.clientHeight
  }, [row])
  const select = (index: number) => { const ref = rows[Math.max(0, Math.min(count - 1, index))]; if (ref && securableKey(ref) !== draft.securable) onSelect(securableKey(ref)) }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || !count) return
    const current = Math.max(row, 0)
    switch (event.key) {
      case 'ArrowDown': select(row < 0 ? 0 : current + 1); break
      case 'ArrowUp': select(row < 0 ? 0 : current - 1); break
      case 'Home': select(0); break
      case 'End': select(count - 1); break
      case 'PageDown': select(current + shownRows - 1); break
      case 'PageUp': select(current - shownRows + 1); break
      case 'Delete': if (row >= 0) onRemove(securableKey(rows[row])); break
      default: return
    }
    event.preventDefault()
  }
  const { first, last } = mappingRange(top, height, count)
  const rowId = (index: number) => `securables-row-${index}`
  return <div ref={root} className="user-mapping-grid securables-grid" role="grid" aria-labelledby="securables-label" aria-rowcount={count + 1} aria-colcount={2} tabIndex={0}
    aria-activedescendant={row < 0 ? undefined : rowId(row)} onKeyDown={keyDown}>
    <div className="user-mapping-head" role="row" aria-rowindex={1}>
      <span className="user-mapping-cell" role="columnheader">Name</span><span className="user-mapping-cell" role="columnheader">Type</span>
    </div>
    {/* A click lands on the scrolling body (out of the tab order, as on User Mapping): it focuses the grid, whose outline and
        aria-activedescendant then show the selected row. */}
    <div ref={body} className="user-mapping-body" style={{ height }} tabIndex={-1} onFocus={event => { if (event.target === event.currentTarget) root.current?.focus({ preventScroll: true }) }}
      onScroll={(event: UIEvent<HTMLDivElement>) => { const value = event.currentTarget.scrollTop; setTop(now => now === value ? now : value) }}>
      <div style={{ height: count * userMappingRowHeight, position: 'relative' }}>
        {rows.slice(first, last).map((ref, offset) => {
          const index = first + offset, selected = index === row, name = securableName(model, ref)
          return <div key={securableKey(ref)} id={rowId(index)} className="user-mapping-row" role="row" aria-rowindex={index + 2} aria-selected={selected} data-selected={selected || undefined}
            style={{ top: index * userMappingRowHeight, height: userMappingRowHeight }} onPointerDown={() => select(index)}>
            <span className="user-mapping-cell" role="gridcell" aria-colindex={1}><span className="user-mapping-text" title={name}><bdi>{name}</bdi></span></span>
            <span className="user-mapping-cell" role="gridcell" aria-colindex={2}><span className="user-mapping-text">{securableTypeLabel(ref)}</span></span>
          </div>
        })}
      </div>
    </div>
  </div>
}

/** The Explicit tab: the selected securable's permissions with their Grantor and Grant, With Grant and Deny boxes (Grant and Deny
 *  exclude each other; With Grant implies Grant). One focusable grid: arrows move the active box and Space toggles it. CONNECT SQL
 *  shows the Status page's choice, greyed. */
function ExplicitGrid({ model, draft, securable, editable, onChange }: {
  model: SecurablesModelOf; draft: NewLoginDraft; securable: SecurableRef; editable: boolean; onChange(permission: string, state: PermissionState | undefined): void
}) {
  const permissions = offeredPermissions(model, securable.type)
  const [active, setActive] = useState<{ readonly row: number; readonly column: PermissionColumn }>({ row: 0, column: 'grant' })
  const root = useRef<HTMLDivElement | null>(null), body = useRef<HTMLDivElement | null>(null)
  const row = Math.min(active.row, permissions.length - 1)
  useLayoutEffect(() => {
    const element = body.current
    if (!element || row < 0) return
    const at = row * userMappingRowHeight
    if (at < element.scrollTop) element.scrollTop = at
    else if (at + userMappingRowHeight > element.scrollTop + element.clientHeight) element.scrollTop = at + userMappingRowHeight - element.clientHeight
  }, [row])
  const stateOf = (permission: string): PermissionState | undefined => reservedPermission(securable.type, permission)
    ? draft.connect === 'deny' ? 'deny' : permissionStateOf(model, draft, securable, permission) === 'withGrant' ? 'withGrant' : 'grant'
    : permissionStateOf(model, draft, securable, permission)
  const toggle = (index: number, column: PermissionColumn) => {
    const permission = permissions[index]
    if (!permission || !editable || reservedPermission(securable.type, permission)) return
    const current = stateOf(permission)
    onChange(permission, toggledPermission(current, column, !permissionChecked(current, column)))
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || !permissions.length) return
    const col = permissionColumns.indexOf(active.column), current = Math.max(row, 0)
    switch (event.key) {
      case 'ArrowDown': setActive({ row: Math.min(permissions.length - 1, current + 1), column: active.column }); break
      case 'ArrowUp': setActive({ row: Math.max(0, current - 1), column: active.column }); break
      case 'ArrowLeft': setActive({ row: current, column: permissionColumns[Math.max(0, col - 1)] }); break
      case 'ArrowRight': setActive({ row: current, column: permissionColumns[Math.min(permissionColumns.length - 1, col + 1)] }); break
      case 'Home': setActive({ row: event.ctrlKey || event.metaKey ? 0 : current, column: event.ctrlKey || event.metaKey ? active.column : 'grant' }); break
      case 'End': setActive({ row: event.ctrlKey || event.metaKey ? permissions.length - 1 : current, column: event.ctrlKey || event.metaKey ? active.column : 'deny' }); break
      case 'PageDown': setActive({ row: Math.min(permissions.length - 1, current + permissionRows - 1), column: active.column }); break
      case 'PageUp': setActive({ row: Math.max(0, current - permissionRows + 1), column: active.column }); break
      case ' ': toggle(current, active.column); break
      default: return
    }
    event.preventDefault()
  }
  if (!permissions.length) return <p className="field-note">{securablesMessages.noPermissions}</p>
  const cellId = (index: number, column: PermissionColumn) => `securables-permission-${index}-${column}`
  return <div ref={root} className="user-mapping-grid securables-permissions" role="grid" aria-label="Explicit permissions" aria-rowcount={permissions.length + 1} aria-colcount={5} tabIndex={0}
    aria-activedescendant={row < 0 ? undefined : cellId(row, active.column)} onKeyDown={keyDown}>
    <div className="user-mapping-head" role="row" aria-rowindex={1}>
      <span className="user-mapping-cell" role="columnheader">Permission</span><span className="user-mapping-cell" role="columnheader">Grantor</span>
      {permissionColumns.map(column => <span key={column} className="user-mapping-cell securables-box" role="columnheader">{columnTitles[column]}</span>)}
    </div>
    <div ref={body} className="user-mapping-body" style={{ height: Math.min(permissions.length, permissionRows) * userMappingRowHeight }} tabIndex={-1}
      onFocus={event => { if (event.target === event.currentTarget) root.current?.focus({ preventScroll: true }) }}>
      <div style={{ height: permissions.length * userMappingRowHeight, position: 'relative' }}>
        {permissions.map((permission, index) => {
          const state = stateOf(permission), reserved = reservedPermission(securable.type, permission), selected = index === row
          const described = reserved ? reservedNote : undefined, grantor = displayText(grantorOf(model, securable, permission))
          // A click on the name or the grantor makes this row the active one, in the column already active, so Space acts on it.
          const pick = () => setActive(now => now.row === index ? now : { row: index, column: now.column })
          return <div key={permission} className="user-mapping-row" role="row" aria-rowindex={index + 2} aria-selected={selected} data-selected={selected || undefined} data-unavailable={reserved || undefined}
            style={{ top: index * userMappingRowHeight, height: userMappingRowHeight }} title={reserved ? securablesMessages.reserved : undefined}>
            <span className="user-mapping-cell" role="gridcell" aria-colindex={1} aria-describedby={described} onPointerDown={pick}><span className="user-mapping-text" title={permission}>{permission}</span></span>
            <span className="user-mapping-cell" role="gridcell" aria-colindex={2} onPointerDown={pick}><span className="user-mapping-text" title={grantor || undefined}><bdi>{grantor}</bdi></span></span>
            {permissionColumns.map((column, at) => <span key={column} id={cellId(index, column)} className="user-mapping-cell securables-box" role="gridcell" aria-colindex={at + 3}
              aria-selected={selected && column === active.column} aria-describedby={described} data-active={(selected && column === active.column) || undefined} onPointerDown={() => setActive({ row: index, column })}>
              <input type="checkbox" tabIndex={-1} aria-label={`${columnTitles[column]} ${permission}`} aria-describedby={described} checked={permissionChecked(state, column)} disabled={!editable || reserved}
                onChange={() => { setActive({ row: index, column }); toggle(index, column); root.current?.focus({ preventScroll: true }) }} />
            </span>)}
          </div>
        })}
      </div>
    </div>
    {permissions.some(permission => reservedPermission(securable.type, permission)) && <span id={reservedNote} hidden>{securablesMessages.reserved}</span>}
  </div>
}

/** The Effective tab: what the login may do on the selected securable, read as the login when the tab shows it; for a login SQL Server
 *  cannot impersonate, `unavailable` says why instead. */
export function EffectiveList({ lookup, unavailable, onRetry }: { lookup: EffectiveLookup | undefined; unavailable?: string; onRetry(): void }) {
  if (unavailable) return <p className="field-note">{unavailable}</p>
  if (!lookup || lookup.state === 'loading') return <p className="field-note" role="status">{securablesMessages.effectiveLoading}</p>
  if (lookup.state === 'failed') return <div className="user-mapping-failed" role="alert"><span>{lookup.error.message}</span><button type="button" onClick={onRetry}>Retry</button></div>
  const { permissions, truncated } = lookup.value
  return <>
    {permissions.length ? <ul className="securables-effective" aria-label="Effective permissions">{permissions.map(permission => <li key={permission}>{permission}</li>)}</ul>
      : <p className="field-note">{securablesMessages.effectiveNone}</p>}
    {truncated && <p className="field-note">{securablesMessages.effectiveTruncated(loginLimits.effectivePermissions)}</p>}
  </>
}

type AddStep = { readonly step: 'choose' } | { readonly step: 'types'; readonly then: 'specific' | 'all' } | { readonly step: 'objects'; readonly types: readonly SecurableType[] }

/**
 * Add Objects (SSMS's, from Search…): Specific objects… (Select Object Types, then Select Objects among those the describe listed), All
 * objects of the types… (Select Object Types, then every object of them), or The server. Each step is one sub-dialog; OK adds to the
 * grid, which keeps at most loginLimits.securableObjects rows.
 */
function AddObjects({ model, draft, onAdd, onCancel }: { model: SecurablesModelOf; draft: NewLoginDraft; onAdd(refs: readonly SecurableRef[]): void; onCancel(): void }) {
  const [step, setStep] = useState<AddStep>({ step: 'choose' })
  const [choice, setChoice] = useState<AddObjectsChoice>('specific')
  const [types, setTypes] = useState<readonly SecurableType[]>([])
  const [chosen, setChosen] = useState<readonly string[]>([])
  const full = (refs: readonly SecurableRef[]) => securablesFull(draft, refs)
  if (step.step === 'choose') {
    const server = displayText(model.securables.server)
    const ok = () => choice === 'server' ? (full([serverRef]) ? undefined : onAdd([serverRef])) : setStep({ step: 'types', then: choice })
    return <SubDialog key="choose" title={addObjectsText.title} onOk={ok} onCancel={onCancel} initialFocus={`add-objects-${choice}`}>
      <div className="securables-choices" role="radiogroup" aria-label={addObjectsText.prompt}>
        <p className="user-mapping-label">{addObjectsText.prompt}</p>
        {addObjectsChoices.map(value => <label key={value} className="checkbox-label"><input id={`add-objects-${value}`} type="radio" name="add-objects" checked={choice === value} onChange={() => setChoice(value)} />
          {value === 'server' ? <bdi>{addObjectsText.server(server)}</bdi> : addObjectsText[value]}</label>)}
      </div>
      {choice === 'server' && full([serverRef]) && <p className="field-note" role="alert">{securablesMessages.securablesLimit(loginLimits.securableObjects)}</p>}
    </SubDialog>
  }
  if (step.step === 'types') {
    const refs = step.then === 'all' ? objectsOfTypes(model, types) : []
    const tooMany = step.then === 'all' && full(refs)
    const ok = () => step.then === 'all' ? onAdd(refs) : (setChosen([]), setStep({ step: 'objects', types }))
    return <SubDialog key="types" title={addObjectsText.selectTypes} okDisabled={!types.length || tooMany} onOk={ok} onCancel={onCancel}>
      <fieldset className="securables-types" aria-describedby={types.length ? undefined : 'securables-types-note'}>
        <legend className="user-mapping-label">{addObjectsText.typesPrompt}</legend>
        {objectTypeOrder.map(type => <label key={type} className="checkbox-label"><input type="checkbox" checked={types.includes(type)}
          onChange={event => setTypes(event.target.checked ? objectTypeOrder.filter(item => item === type || types.includes(item)) : types.filter(item => item !== type))} />{securableSpecs[type].plural}</label>)}
      </fieldset>
      {!types.length && <p className="field-note" id="securables-types-note">{securablesMessages.addNone}</p>}
      {tooMany && <p className="field-note" role="alert">{securablesMessages.securablesLimit(loginLimits.securableObjects)}</p>}
      {step.then === 'all' && model.securables.truncated && <p className="field-note">{securablesMessages.objectsTruncated(loginLimits.securableObjects)}</p>}
    </SubDialog>
  }
  // Select Objects: the chosen types' objects, the server among them as its own entry, by type and then by name as the describe read them.
  const listed = objectsOfTypes(model, step.types), byKey = new Map(listed.map(ref => [securableKey(ref), ref]))
  const picked = chosen.flatMap(key => byKey.get(key) ?? [])
  const tooMany = full(picked)
  return <SubDialog key="objects" title={addObjectsText.selectObjects} okDisabled={!picked.length || tooMany} onOk={() => onAdd(picked)} onCancel={onCancel} initialFocus="securables-objects">
    <label htmlFor="securables-objects" className="user-mapping-label">{addObjectsText.objectsPrompt}</label>
    {listed.length ? <select id="securables-objects" className="database-owner-list" multiple size={12} value={[...chosen]}
      onChange={event => setChosen([...event.target.selectedOptions].map(option => option.value))} onDoubleClick={() => picked.length && !tooMany && onAdd(picked)}>
      {step.types.map(type => {
        const of = listed.filter(ref => ref.type === type)
        return of.length ? <optgroup key={type} label={securableSpecs[type].plural}>
          {of.map(ref => <option key={securableKey(ref)} value={securableKey(ref)} title={securableName(model, ref)}>{securableName(model, ref)}</option>)}
        </optgroup> : null
      })}
    </select> : <p className="field-note">{securablesMessages.noObjects}</p>}
    {tooMany && <p className="field-note" role="alert">{securablesMessages.securablesLimit(loginLimits.securableObjects)}</p>}
    {model.securables.truncated && step.types.some(type => type !== 'server' && model.securables.objects[type as NamedSecurableType].length >= loginLimits.securableObjects)
      && <p className="field-note">{securablesMessages.objectsTruncated(loginLimits.securableObjects)}</p>}
  </SubDialog>
}

/**
 * New Login's and Login Properties' Securables page (D2d), in SSMS's layout: "Securables:" (Name, Type) with Search… (Add Objects) and
 * Remove; then "Permissions for" the selected one, on two tabs: Explicit (Permission, Grantor, Grant, With Grant, Deny) and, for an
 * existing login, Effective. Login Properties starts with each securable the login has an explicit permission on. OK sends only the
 * boxes that changed (securables.ts permissionChoices).
 */
export default function SecurablesPage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const model = open.model as SecurablesModelOf | undefined, draft = open.draft as NewLoginDraft | undefined
  const properties = open.dialog === 'loginProperties'
  const [tab, setTab] = useState<'explicit' | 'effective'>('explicit')
  const [adding, setAdding] = useState(false)
  const search = useRef<HTMLButtonElement | null>(null)
  const selected = draft?.securables.find(ref => securableKey(ref) === draft.securable)
  const facts = properties ? (open.model as { login?: Pick<LoginFacts, 'subtype' | 'own'> } | undefined)?.login : undefined
  const unavailable = facts && effectiveUnavailableSubtypes.includes(facts.subtype) ? securablesMessages.effectiveUnavailable : undefined
  const effective = properties && tab === 'effective' && !unavailable ? selected : undefined
  // Read again whenever the shown securable has no answer: a partial run's reload forgets every answer while the tab shows.
  const unread = !!effective && open.effective?.get(securableKey(effective)) === undefined
  useEffect(() => { if (effective && unread) dialogs.loadEffective(effective) }, [dialogs, effective, unread])
  if (!model || !draft) return null
  const blocked = !!loginBlocked(open), usable = editable && !blocked
  // SQL Server changes no permission of sa or of the login this connection uses (4624): the boxes only show them.
  const fixed = facts && permissionsProtected(facts) ? loginMessages.permissionsProtected : undefined
  const cascades = properties && open.target.name !== undefined ? permissionChoices(model, draft).filter(permissionCascades)
    .map(choice => securablesMessages.cascades(choice.permission, open.target.name!, choice.securable.name)) : []
  const add = (refs: readonly SecurableRef[]) => { setAdding(false); dialogs.updateDraft(addSecurables(draft, refs)); queueMicrotask(() => search.current?.focus()) }
  const tabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!properties || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End')) return
    event.preventDefault()
    const next = event.key === 'ArrowLeft' || event.key === 'Home' ? 'explicit' : 'effective'
    setTab(next)
    queueMicrotask(() => document.getElementById(`securables-tab-${next}`)?.focus())
  }
  const permissionsTruncated = properties && (open.model as { properties?: { permissionsTruncated?: boolean } }).properties?.permissionsTruncated
  return <div className="new-login-page securables-page">
    <LoginBlockedNote open={open} />
    {fixed && !blocked && <ul className="object-dialog-warnings" aria-label="Notes"><li><Icon name="info" /><span>{fixed}</span></li></ul>}
    <p className="user-mapping-label" id="securables-label">Securables:</p>
    <SecurablesGrid model={model} draft={draft} onSelect={key => dialogs.updateDraft({ securable: key })} onRemove={key => usable && dialogs.updateDraft(removeSecurable(draft, key))} />
    <div className="securables-actions">
      <button ref={search} type="button" disabled={!usable} onClick={() => setAdding(true)}>Search…</button>
      <button type="button" disabled={!usable || !selected} onClick={() => selected && dialogs.updateDraft(removeSecurable(draft, securableKey(selected)))}>Remove</button>
    </div>
    {permissionsTruncated && <ul className="object-dialog-warnings" aria-label="Notes"><li><Icon name="warning" /><span>{securablesMessages.explicitTruncated(loginLimits.explicitPermissions)}</span></li></ul>}
    {cascades.length > 0 && <ul className="object-dialog-warnings" aria-label="Warnings">{cascades.map(text => <li key={text}><Icon name="warning" /><span>{text}</span></li>)}</ul>}
    <p className="user-mapping-label" id="securables-permissions-label">{selected ? <>Permissions for <bdi>{securableName(model, selected)}</bdi>:</> : 'Permissions:'}</p>
    <div className="activity-pane-tabs securables-tabs" role="tablist" aria-labelledby="securables-permissions-label" onKeyDown={tabKey}>
      <button type="button" role="tab" id="securables-tab-explicit" aria-selected={tab === 'explicit'} aria-controls="securables-panel" tabIndex={tab === 'explicit' ? 0 : -1} onClick={() => setTab('explicit')}>Explicit</button>
      <button type="button" role="tab" id="securables-tab-effective" aria-selected={tab === 'effective'} aria-controls="securables-panel" tabIndex={tab === 'effective' ? 0 : -1} disabled={!properties}
        title={properties ? undefined : securablesMessages.effectiveNewLogin} onClick={() => setTab('effective')}>Effective</button>
    </div>
    <div className="securables-panel" id="securables-panel" role="tabpanel" aria-labelledby={`securables-tab-${tab}`}>
      {!selected ? <p className="field-note">{securablesMessages.noSecurable}</p>
        : tab === 'explicit' ? <ExplicitGrid key={securableKey(selected)} model={model} draft={draft} securable={selected} editable={usable && !fixed}
          onChange={(permission, state) => dialogs.updateDraft(setPermission(model, draft, selected, permission, state))} />
          : <EffectiveList lookup={open.effective?.get(securableKey(selected))} unavailable={unavailable} onRetry={() => dialogs.loadEffective(selected)} />}
    </div>
    {adding && <AddObjects model={model} draft={draft} onAdd={add} onCancel={() => { setAdding(false); queueMicrotask(() => search.current?.focus()) }} />}
  </div>
}
