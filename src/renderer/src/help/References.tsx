import { commandDescriptor, type CommandId } from '../../../shared/commands/catalog'
import { gestureAvailable, gestureDescriptor, type GestureId } from '../../../shared/commands/gestures'
import type { LessonContext } from '../../../shared/help/catalog'
import { lessonCommand, lessonContexts, lessonShortcut, settingValueLabel } from '../../../shared/help/references'
import { pagePath, settingDef, type SettingKey } from '../../../shared/settings/catalog'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { useCommandEnabled, useKeybindingsRevision } from '../core/useCommand'

export function CommandRef({ id, context }: { readonly id: CommandId; readonly context: LessonContext }) {
  const { platform, keybindings, settings } = useWorkbench()
  const { values } = useServiceSnapshot(settings)
  useKeybindingsRevision()
  const command = lessonCommand(id, platform, values), shortcut = lessonShortcut(id, context, platform, keybindings.getRules())
  return <span className="help-reference" data-help-command={id} data-help-context={context}>
    <strong>{command.path ?? command.title}</strong>{' '}
    {shortcut ? <kbd>{shortcut}</kbd> : <span className="help-muted">No shortcut assigned in this context</span>}
    {' '}<span className="help-muted">({lessonContexts[context].title})</span>
  </span>
}

export function SettingRef({ id }: { readonly id: SettingKey }) {
  const { settings, commands } = useWorkbench(), { values } = useServiceSnapshot(settings), def = settingDef(id)
  return <span className="help-reference" data-help-setting={id}><strong>{def.label}: {settingValueLabel(id, values)}</strong>{' '}
    <span className="help-muted">{pagePath(def.page).map(page => page.title).join(' › ')}</span>{' '}
    <button type="button" onClick={() => { void commands.execute('preferences.options', { settingsPage: def.page }, 'toolbar') }}>Open this Options page</button>
  </span>
}

export function GestureRef({ id }: { readonly id: GestureId }) {
  const { gestures, platform, commands } = useWorkbench()
  useServiceSnapshot(gestures)
  return <span className="help-reference" data-help-gesture={id}><strong>{gestureDescriptor(id).title}</strong>{' '}
    <span>{gestureAvailable(id, platform) ? gestures.label(id) : 'Unavailable on this platform'}</span>{' '}
    <button type="button" onClick={() => { void commands.execute('preferences.options', { settingsPage: 'environment.shortcuts' }, 'toolbar') }}>Open Shortcuts</button></span>
}

/** Only explicit, non-executing entry points. Sample controls never dispatch application commands. */
export function GuideAction({ command, label }: { readonly command: 'connection.connect' | 'file.new'; readonly label: string }) {
  const { commands } = useWorkbench(), enabled = useCommandEnabled(command)
  const reason = enabled ? undefined : commands.unavailableReason(command) ?? commandDescriptor(command).unavailableHint
  return <button type="button" className="document-verb outline" data-help-action={command} disabled={!enabled} title={reason} onClick={() => { void commands.execute(command, undefined, 'toolbar') }}>{label}</button>
}
