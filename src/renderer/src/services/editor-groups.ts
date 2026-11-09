import type { EditorGroupNode, EditorGroupsLayout, EditorTabRows } from '../../../shared/editor-groups'
import { editorGroupLimits } from '../../../shared/editor-groups'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { DocumentService } from './documents'

/** One editor group: its documents in tab order, the one it shows, and whether it floats. */
export interface EditorGroupInfo { readonly id: string; readonly documents: readonly string[]; readonly active?: string; readonly floating: boolean }
/** The editor groups in order (the grid's, then the floating ones), and the active one; '' while there is none. */
export interface EditorGroupSnapshot { readonly groups: readonly EditorGroupInfo[]; readonly activeGroup: string }
export type SplitDirection = 'right' | 'down'
/** Where a document goes: into a group (at a tab's place), into a new group beside one, or floating, or back into the grid. */
export type EditorMove =
  | { readonly group: string; readonly index?: number }
  | { readonly split: SplitDirection | 'left' | 'up'; readonly beside: string }
  | { readonly float: true }
  | { readonly dock: true }

/** What the editor area (EditorArea's Dockview) does for the service; it publishes its groups with `publish`. */
export interface EditorGroupHost {
  move(id: string, to: EditorMove): void
  /** Makes a group active and moves focus into what it shows. */
  focusGroup(group: string): void
  /** Every document into the first group, in order (Join All Editor Groups). */
  join(): void
  /** The groups as hot exit keeps them, each document by `place(id)`. */
  capture(place: (id: string) => number | undefined): EditorGroupsLayout | undefined
  /** Arranges the open documents as `layout` says, each place's document by `id(place)`. */
  restore(layout: EditorGroupsLayout, id: (place: number) => string | undefined): void
  /** The document whose tab has focus, if one does. */
  focusedDocument(): string | undefined
  /** Moves keyboard focus to a document's native tab after it is activated. */
  focusTab(id: string): void
}

/** The group holding document `id`. */
export const groupOf = (snapshot: EditorGroupSnapshot, id: string): EditorGroupInfo | undefined => snapshot.groups.find(group => group.documents.includes(id))
/** The group `delta` places from `group` in group order, or undefined past either end. */
export function neighbour(snapshot: EditorGroupSnapshot, group: string, delta: 1 | -1): EditorGroupInfo | undefined {
  const index = snapshot.groups.findIndex(item => item.id === group)
  return index < 0 ? undefined : snapshot.groups[index + delta]
}

/**
 * The editor groups (docs/editor-groups.md): which documents each holds, and the moves between them that commands make.
 * The editor area's Dockview is the arrangement's source of truth; it publishes the groups here as they change, and does
 * the moves asked here. Without an editor area (tests), the documents form one group in DocumentService's order.
 */
export class EditorGroupService extends SnapshotStore<EditorGroupSnapshot> implements Disposable {
  private host?: EditorGroupHost
  private readonly tabRows = new Map<string, { adjust(pinned: boolean, delta: 1 | -1): void; canAdjust?(pinned: boolean, delta: 1 | -1): boolean }>()
  private readonly savedTabRows = new Map<string, EditorTabRows>()
  /** A layout to restore once the editor area is there, with how to name each place's document. */
  private pending?: { layout: EditorGroupsLayout; id: (place: number) => string | undefined }
  constructor(private readonly documents: Pick<DocumentService, 'getSnapshot' | 'move' | 'get'>) { super({ groups: [], activeGroup: '' }) }

  /** The editor area: it does the moves from now on, and a restore waiting for it happens now. */
  attach(host: EditorGroupHost): Disposable {
    this.host = host
    const pending = this.pending
    this.pending = undefined
    if (pending) host.restore(pending.layout, pending.id)
    return { dispose: () => { if (this.host === host) { this.host = undefined; this.publish({ groups: [], activeGroup: '' }) } } }
  }
  /** The editor area's groups, as they are now. */
  update(snapshot: EditorGroupSnapshot): void {
    const current = this.getSnapshot()
    if (current.activeGroup === snapshot.activeGroup && current.groups.length === snapshot.groups.length && current.groups.every((group, index) => sameGroup(group, snapshot.groups[index]))) return
    this.publish(snapshot)
  }
  /** The groups as commands see them: the editor area's, or one group of every document when there is none. */
  private view(): EditorGroupSnapshot {
    const snapshot = this.getSnapshot()
    if (snapshot.groups.length || this.host) return snapshot
    const { documents, activeId } = this.documents.getSnapshot()
    return documents.length ? { groups: [{ id: 'g1', documents: documents.map(document => document.id), active: activeId || undefined, floating: false }], activeGroup: 'g1' } : snapshot
  }
  groupOf(id: string): EditorGroupInfo | undefined { return groupOf(this.view(), id) }
  get count(): number { return this.view().groups.length }

  /** The group's tab layout supplies the keyboard equivalent of Control+wheel. */
  registerTabRows(group: string, adjust: (pinned: boolean, delta: 1 | -1) => void, canAdjust?: (pinned: boolean, delta: 1 | -1) => boolean): Disposable {
    const control = { adjust, canAdjust }
    this.tabRows.set(group, control)
    return { dispose: () => { if (this.tabRows.get(group) === control) this.tabRows.delete(group) } }
  }
  canChangeTabRows(id: string, delta?: 1 | -1): boolean {
    const group = this.groupOf(id), document = this.documents.get(id), control = group && this.tabRows.get(group.id)
    return !!document && !!control && (delta === undefined || !control.canAdjust || control.canAdjust(!!document.pinned, delta))
  }
  /** Changes only the shelf holding the requested document, in its own editor group. */
  changeTabRows(id: string, delta: 1 | -1): void {
    const group = this.groupOf(id), document = this.documents.get(id)
    if (group && document) this.tabRows.get(group.id)?.adjust(!!document.pinned, delta)
  }

  getTabRows(group: string): EditorTabRows { return this.savedTabRows.get(group) ?? { pinned: 1, unpinned: 1 } }
  /** Keeps the requested heights, including when fewer rows currently fit the tabs. */
  setTabRows(group: string, rows: EditorTabRows): void {
    const next = normalizedTabRows(rows), previous = this.getTabRows(group)
    if (previous.pinned === next.pinned && previous.unpinned === next.unpinned) return
    if (next.pinned === 1 && next.unpinned === 1) this.savedTabRows.delete(group)
    else this.savedTabRows.set(group, next)
    this.publish({ ...this.getSnapshot() })
  }
  /** Restored group ids may replace existing ones; replace their preferences before the layout mounts them. */
  restoreTabRows(groups: ReadonlyMap<string, EditorTabRows>): void {
    this.savedTabRows.clear()
    for (const [group, rows] of groups) {
      const next = normalizedTabRows(rows)
      if (next.pinned !== 1 || next.unpinned !== 1) this.savedTabRows.set(group, next)
    }
    this.publish({ ...this.getSnapshot() })
  }
  forgetTabRows(group: string): void { this.savedTabRows.delete(group) }

  /** Whether the document can move `delta` tabs along its group's strip. */
  canMoveInGroup(id: string, delta: 1 | -1): boolean {
    const group = this.groupOf(id), index = group?.documents.indexOf(id) ?? -1, target = group?.documents[index + delta]
    // Pinned tabs come first in each group: a move stays on its own side of the pins.
    return !!group && index >= 0 && !!target && !!this.documents.get(target)?.pinned === !!this.documents.get(id)?.pinned
  }
  /** Move Left and Move Right: along the document's own group's strip. */
  moveInGroup(id: string, delta: 1 | -1): void {
    if (!this.canMoveInGroup(id, delta)) return
    const group = this.groupOf(id)!, index = group.documents.indexOf(id) + delta
    if (this.host) { this.host.move(id, { group: group.id, index }); return }
    const order = this.documents.getSnapshot().documents.map(document => document.id)
    this.documents.move(id, order.indexOf(group.documents[index]))
  }
  /** Whether Split Editor can move the document into a new group: its group keeps another tab, and the cap allows one more. */
  canSplit(id: string): boolean {
    const group = this.groupOf(id)
    return !!this.host && !!group && group.documents.length > 1 && this.count < editorGroupLimits.groups
  }
  /** Split Editor Right and Down: the document moves into a new group beside its own (one view per document). */
  split(id: string, direction: SplitDirection): void {
    const group = this.groupOf(id)
    if (this.canSplit(id) && group) this.host!.move(id, { split: direction, beside: group.id })
  }
  /** Whether Move Editor into Next (or Previous) Group can move the document: a group is there, or one can open after it. */
  canMoveToGroup(id: string, delta: 1 | -1): boolean {
    const view = this.view(), group = groupOf(view, id)
    if (!this.host || !group) return false
    return !!neighbour(view, group.id, delta) || (delta === 1 && this.canSplit(id))
  }
  /** Moves the document into the next or previous group, as its last tab, where it shows; past the last group, into a new one on the right. */
  moveToGroup(id: string, delta: 1 | -1): void {
    if (!this.canMoveToGroup(id, delta)) return
    const view = this.view(), group = groupOf(view, id)!, target = neighbour(view, group.id, delta)
    if (target) this.host!.move(id, { group: target.id })
    else this.split(id, 'right')
  }
  /** Focus Next and Previous Editor Group, wrapping around. */
  focusGroup(delta: 1 | -1): void {
    const view = this.view(), index = view.groups.findIndex(group => group.id === view.activeGroup)
    if (!this.host || view.groups.length < 2) return
    const next = view.groups[((index < 0 ? 0 : index) + delta + view.groups.length) % view.groups.length]
    this.host.focusGroup(next.id)
  }
  /**
   * The document whose tab has focus. It is not always the active one (a closing menu gives focus back to the tab it was
   * opened on without choosing it), so a key pressed on a tab acts on this one.
   */
  focusedDocument(): string | undefined { return this.host?.focusedDocument() }
  /** Query cycling that began in a tab keeps focus in the selected tab's strip. */
  focusTab(id: string): void { if (this.documents.get(id)) this.host?.focusTab(id) }
  isFloating(id: string): boolean { return !!this.groupOf(id)?.floating }
  /**
   * Whether Float Editor can move the document into a floating group: it is docked, the grid keeps another document (a
   * floating query over an empty editor area would sit on "No open queries"), and the cap allows one more group.
   */
  canFloat(id: string): boolean {
    const view = this.view(), group = groupOf(view, id)
    if (!this.host || !group || group.floating || this.count >= editorGroupLimits.groups) return false
    return group.documents.length > 1 || view.groups.some(other => other !== group && !other.floating && other.documents.length > 0)
  }
  /**
   * The document that shows when `closing`, the active one, closes: the next tab in its own group (the one before at the
   * strip's end), as VS Code does; undefined when it is its group's only document, so DocumentService's order decides.
   */
  successor(closing: string): string | undefined {
    const documents = this.groupOf(closing)?.documents ?? [], index = documents.indexOf(closing)
    if (!this.host || index < 0 || documents.length < 2) return undefined
    return documents[index + 1] ?? documents[index - 1]
  }
  /** Float Editor: the document moves into a floating group of its own over the editor area. */
  float(id: string): void { if (this.canFloat(id)) this.host!.move(id, { float: true }) }
  /** Dock Editor: a floating document goes back into the grid. */
  dock(id: string): void { if (this.host && this.isFloating(id)) this.host.move(id, { dock: true }) }
  /** Join All Editor Groups. */
  join(): void { if (this.host && this.count > 1) this.host.join() }

  /** The groups as hot exit keeps them; an ordinary single group needs only the documents' order. */
  capture(place: (id: string) => number | undefined): EditorGroupsLayout | undefined {
    const layout = this.host?.capture(place)
    if (!layout) return undefined
    let groups = 0, hasRows = false
    const visit = (node: EditorGroupNode) => {
      if (node.type === 'branch') { node.children.forEach(visit); return }
      groups++
      if (node.tabRows && (node.tabRows.pinned !== 1 || node.tabRows.unpinned !== 1)) hasRows = true
    }
    visit(layout.root)
    for (const floating of layout.floating ?? []) visit(floating.root)
    return groups > 1 || hasRows || layout.floating?.length ? layout : undefined
  }
  /** Arranges the reopened documents as hot exit kept them, now or once the editor area is there. */
  restore(layout: EditorGroupsLayout, id: (place: number) => string | undefined): void {
    if (this.host) this.host.restore(layout, id)
    else this.pending = { layout, id }
  }
  dispose(): void { this.host = undefined; this.pending = undefined; this.tabRows.clear(); this.savedTabRows.clear(); this.clearListeners() }
}

function sameGroup(a: EditorGroupInfo, b: EditorGroupInfo): boolean {
  return a.id === b.id && a.active === b.active && a.floating === b.floating && a.documents.length === b.documents.length && a.documents.every((id, index) => id === b.documents[index])
}

function normalizedTabRows(rows: EditorTabRows): EditorTabRows {
  const normalize = (value: number) => Number.isSafeInteger(value) && value > 0 ? value : 1
  return { pinned: normalize(rows.pinned), unpinned: normalize(rows.unpinned) }
}
