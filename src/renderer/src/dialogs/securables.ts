// The Securables page of New Login and Login Properties (D2d): its draft (the securables listed, the selected one, and the Explicit
// tab's boxes as the user set them), Add Objects, and the permission statements OK and Script send. No React here.
import { loginLimits, type NewLoginModel } from '../../../shared/actions/logins.ts'
import {
  explicitStates, permissionChange, reservedPermission, securableKey, securableSpecs, securableTypes, type ExplicitPermission, type NamedSecurableType, type PermissionChoice,
  type PermissionState, type SecurableRef, type SecurableType
} from '../../../shared/actions/securables.ts'
import { displayText } from '../../../shared/explorer/refs.ts'

/** One permission as the user set it on the Explicit tab: `state` undefined clears it. */
export interface PermissionDraft { readonly securable: SecurableRef; readonly permission: string; readonly state?: PermissionState }
/** The page's part of New Login's and Login Properties' drafts. */
export interface SecurablesDraft {
  /** The upper grid's rows, in the order they were added (Login Properties starts with those the login has permissions on). */
  readonly securables: readonly SecurableRef[]
  /** The selected row's key (securableKey), whose permissions show below. */
  readonly securable?: string
  /** The boxes the user changed, by securable and permission; the others show what the describe read. */
  readonly permissions: readonly PermissionDraft[]
}
/** What the page reads of a model: New Login's lists, and Login Properties' explicit permissions (none for New Login). */
export type SecurablesModelOf = Pick<NewLoginModel, 'securables'> & { readonly properties?: { readonly permissions: readonly ExplicitPermission[] } }

export const explicitRows = (model: SecurablesModelOf): readonly ExplicitPermission[] => model.properties?.permissions ?? []
const typeOrder = (type: SecurableType) => securableTypes.indexOf(type)
const byName = (a: SecurableRef, b: SecurableRef) => typeOrder(a.type) - typeOrder(b.type) || ((a.name ?? '') < (b.name ?? '') ? -1 : (a.name ?? '') > (b.name ?? '') ? 1 : 0)

/** Login Properties' first rows: each securable the login has an explicit permission on, by type, then name. */
export function initialSecurables(rows: readonly ExplicitPermission[]): SecurablesDraft {
  const seen = new Map<string, SecurableRef>()
  for (const row of rows) if (!seen.has(securableKey(row.securable))) seen.set(securableKey(row.securable), row.securable)
  const securables = [...seen.values()].sort(byName)
  return { securables, ...(securables[0] ? { securable: securableKey(securables[0]) } : {}), permissions: [] }
}

/** The permissions the Explicit tab lists for a type: the catalogue's that this server lists (the describe's), alphabetical. */
export const offeredPermissions = (model: SecurablesModelOf, type: SecurableType): readonly string[] => model.securables.permissions[type] ?? []

/** A permission's state as the page shows it: the user's change, else what the describe read. */
export function permissionStateOf(model: SecurablesModelOf, draft: SecurablesDraft, ref: SecurableRef, permission: string): PermissionState | undefined {
  const key = securableKey(ref), changed = draft.permissions.find(item => securableKey(item.securable) === key && item.permission === permission)
  return changed ? changed.state : explicitStates(explicitRows(model)).get(key)?.get(permission)?.state
}
/** The grantor the describe read for a permission (empty for none, or for one set in this dialog only). */
export const grantorOf = (model: SecurablesModelOf, ref: SecurableRef, permission: string): string => explicitStates(explicitRows(model)).get(securableKey(ref))?.get(permission)?.grantor ?? ''

/** A box of the Explicit tab changed: the permission's new state, dropped again once it equals what the describe read. */
export function setPermission(model: SecurablesModelOf, draft: SecurablesDraft, ref: SecurableRef, permission: string, state: PermissionState | undefined): Pick<SecurablesDraft, 'permissions'> {
  const key = securableKey(ref), rest = draft.permissions.filter(item => !(securableKey(item.securable) === key && item.permission === permission))
  const read = explicitStates(explicitRows(model)).get(key)?.get(permission)?.state
  return { permissions: read === state ? rest : [...rest, { securable: ref, permission, ...(state ? { state } : {}) }] }
}

/** Add Objects' rows joined to the grid (those already listed are not repeated), the first new one selected when none is; at most
 *  loginLimits.securableObjects rows. */
export function addSecurables(draft: SecurablesDraft, refs: readonly SecurableRef[]): Pick<SecurablesDraft, 'securables' | 'securable'> {
  const listed = new Set(draft.securables.map(securableKey)), fresh: SecurableRef[] = []
  for (const ref of refs) if (!listed.has(securableKey(ref))) { listed.add(securableKey(ref)); fresh.push(ref) }
  const securables = [...draft.securables, ...fresh].slice(0, loginLimits.securableObjects)
  const selected = draft.securable ?? (fresh[0] ? securableKey(fresh[0]) : undefined)
  return { securables, ...(selected !== undefined ? { securable: selected } : {}) }
}
/** Whether adding `refs` would pass the grid's limit. */
export const securablesFull = (draft: SecurablesDraft, refs: readonly SecurableRef[]) =>
  new Set([...draft.securables, ...refs].map(securableKey)).size > loginLimits.securableObjects

/** Remove: the row leaves the grid with the changes made to it here; what the login already has stays (clear its boxes to revoke it). */
export function removeSecurable(draft: SecurablesDraft, key: string): Pick<SecurablesDraft, 'securables' | 'securable' | 'permissions'> {
  const index = draft.securables.findIndex(ref => securableKey(ref) === key)
  const securables = draft.securables.filter(ref => securableKey(ref) !== key)
  const next = securables[Math.min(Math.max(index, 0), securables.length - 1)]
  return { securables, ...(next ? { securable: securableKey(next) } : { securable: undefined }), permissions: draft.permissions.filter(item => securableKey(item.securable) !== key) }
}

/** Add Objects' The server row, and All objects of the types… rows: every object the describe listed of each type chosen. */
export const serverRef: SecurableRef = { type: 'server' }
export function objectsOfTypes(model: SecurablesModelOf, types: readonly SecurableType[]): SecurableRef[] {
  return types.flatMap(type => type === 'server' ? [serverRef] : model.securables.objects[type as NamedSecurableType].map(name => ({ type, name })))
}

/** A row's Name as the grid shows it: the server's name for the server. */
export const securableName = (model: SecurablesModelOf, ref: SecurableRef) => displayText(ref.type === 'server' ? model.securables.server : ref.name ?? '')
export const securableTypeLabel = (ref: SecurableRef) => securableSpecs[ref.type].label

/**
 * The statements OK and Script send: per listed securable in the grid's order, each permission whose box differs from what the describe
 * read, as permissionChange writes it (CASCADE after a grant with grant option). Permissions this server does not list, and the Status
 * page's CONNECT SQL, are never sent.
 */
export function permissionChoices(model: SecurablesModelOf, draft: SecurablesDraft): PermissionChoice[] {
  const states = explicitStates(explicitRows(model)), choices: PermissionChoice[] = []
  for (const ref of draft.securables) {
    const key = securableKey(ref), offered = offeredPermissions(model, ref.type)
    for (const permission of offered) {
      if (reservedPermission(ref.type, permission)) continue
      const changed = draft.permissions.find(item => securableKey(item.securable) === key && item.permission === permission)
      if (!changed) continue
      const change = permissionChange(states.get(key)?.get(permission)?.state, changed.state)
      if (change) choices.push({ securable: ref.type === 'server' ? { type: 'server' } : { type: ref.type, name: ref.name! }, permission, ...change })
    }
  }
  return choices
}
