import type { SettingsValues } from '../../../shared/settings/catalog'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { SettingsService } from '../settings/SettingsService'

/**
 * How the shell is laid out, from Tools › Options: the classic toolbar and the query window status bar (both kept for
 * one release), and Window › Panel Tabs, which also feeds the panelTabsVisible context key.
 */
export interface ShellOptions {
  readonly classicToolbar: boolean
  readonly queryStatusBar: boolean
  readonly panelTabs: boolean
}
const fromSettings = (values: SettingsValues): ShellOptions => ({
  classicToolbar: values['environment.layout.classicToolbar'],
  queryStatusBar: values['textEditor.statusBar.queryWindow'],
  panelTabs: values['environment.layout.panelTabs']
})
const same = (a: ShellOptions, b: ShellOptions) => a.classicToolbar === b.classicToolbar && a.queryStatusBar === b.queryStatusBar && a.panelTabs === b.panelTabs

/** The shell's layout options, backed by settings: the Panel Tabs toggle is saved there, and every change reaches the shell. */
export class ShellOptionsService extends SnapshotStore<ShellOptions> implements Disposable {
  private readonly unsubscribe: () => void
  constructor(private readonly settings: Pick<SettingsService, 'getSnapshot' | 'subscribe' | 'toggle'>) {
    super(fromSettings(settings.getSnapshot().values))
    this.unsubscribe = settings.subscribe(() => {
      const next = fromSettings(settings.getSnapshot().values)
      if (!same(next, this.getSnapshot())) this.publish(next)
    })
  }
  /** Window › Panel Tabs. Saved, or applied for this session when the save fails; it never throws. */
  togglePanelTabs(): Promise<void> { return this.settings.toggle('environment.layout.panelTabs') }
  dispose(): void {
    this.unsubscribe()
    this.clearListeners()
  }
}
