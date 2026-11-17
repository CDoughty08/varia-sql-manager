import type { DockviewApi, DockviewGroupPanel } from 'dockview-react'
import { isOutputPane, withGroupShown, type WorkspaceLayout } from '../../shared/layouts'

type Box = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>
export type Measure = (element: HTMLElement) => Box
const measureElement: Measure = element => element.getBoundingClientRect()
// A sash sits between the editor and the group below it.
const gap = 8

/**
 * The group whose space a document that is not a query takes: docked in the grid directly below the query editor, at the
 * bottom of the dock, and holding only output panels, as the default layout's Results, Messages and Execution plan do.
 * At the bottom, Dockview gives its space to the editor above it (a hidden view's space goes to its last visible
 * sibling); a group with another one below it would give its space to that one. Output panels the user moved elsewhere,
 * floated or popped out keep their place. None while a group is maximized.
 */
export function yieldingGroup(api: DockviewApi, measure: Measure = measureElement): DockviewGroupPanel | undefined {
  const editor = api.getPanel('editor')
  if (!editor || editor.api.location.type !== 'grid' || api.hasMaximizedGroup()) return undefined
  const above = measure(editor.group.element)
  const docked = api.groups.filter(group => group.api.location.type === 'grid' && group.api.isVisible)
  const bottom = Math.max(...docked.map(group => measure(group.element).bottom))
  return docked.find(group => {
    if (group === editor.group || !group.panels.length || !group.panels.every(panel => isOutputPane(panel.id))) return false
    const box = measure(group.element)
    return Math.abs(box.top - above.bottom) <= gap && box.bottom >= bottom - gap && box.left < above.right - gap && box.right > above.left + gap
  })
}

/**
 * Hides the output group below the query editor while a document that is not a query is active, and shows it again at its
 * size when a query is (Dockview keeps a hidden view's size). The layout saved meanwhile shows the group, so a restart or a
 * saved layout never comes back without the output.
 */
export class OutputYield {
  private hidden: string | undefined
  constructor(private readonly measure: Measure = measureElement) {}

  /** The group hidden now, if any. */
  get groupId(): string | undefined { return this.hidden }

  /** Hides the output group below the editor; returns it, or undefined when one is already hidden or there is none. */
  yieldSpace(api: DockviewApi): DockviewGroupPanel | undefined {
    if (this.hidden !== undefined && api.groups.some(group => group.id === this.hidden && !group.api.isVisible)) return undefined
    this.hidden = undefined
    const group = yieldingGroup(api, this.measure)
    if (!group) return undefined
    this.hidden = group.id
    group.api.setVisible(false)
    return group
  }

  /** Shows the hidden group again at its size; returns whether it hid one. */
  restore(api: DockviewApi): boolean {
    const id = this.hidden
    this.hidden = undefined
    const group = id === undefined ? undefined : api.groups.find(item => item.id === id)
    if (!group || group.api.isVisible) return false
    group.api.setVisible(true)
    return true
  }

  /**
   * Shows the hidden group again once it holds a panel that is not an output panel: a command moved one there (Tab with
   * Results), and it would otherwise vanish with it. Returns whether it did.
   */
  check(api: DockviewApi): boolean {
    const group = this.hidden === undefined ? undefined : api.groups.find(item => item.id === this.hidden)
    if (!group || group.panels.every(panel => isOutputPane(panel.id))) return false
    return this.restore(api)
  }

  /** The user showed a panel of `groupId` (Window › Results, Ctrl+R): it stays shown, no longer this one's to restore or hide. */
  release(groupId: string): void { if (this.hidden === groupId) this.hidden = undefined }

  /** `layout` as it is saved: with the hidden group shown at its size. */
  saved(layout: WorkspaceLayout): WorkspaceLayout { return this.hidden === undefined ? layout : withGroupShown(layout, this.hidden) }
}
