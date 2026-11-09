import { isCommandId } from '../../../shared/commands/catalog'
import { scriptAsTitles, scriptCommandId, scriptDestinations, scriptDestinationSpecs, scriptMenuState, scriptVerbs, scriptVerbSpecs, scriptVerbTitle } from '../../../shared/scripting/catalog.ts'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { objectNodeOf } from '../menus/targets'
import type { QuickPickItem } from '../quickinput/QuickInputService'
import { scriptTarget } from '../scripting/ScriptingService'

/**
 * Scripting's commands. Script as › <verb> To › <destination> acts on the node (or Search Objects result) its menu was opened
 * for, otherwise on the selected node (the palette's Script As… and Modify).
 */
export function scriptingContribution({ commands, scripting, explorer, quickInput, context }: Pick<Workbench, 'commands' | 'scripting' | 'explorer' | 'quickInput' | 'context'>): Disposable {
  // A Search Objects result's menu scripts the result's object, which Object Explorer may not have loaded.
  const nodeOf = (args?: CommandArgs) => args?.target ? objectNodeOf(args) : explorer.menuNode(explorer.getSnapshot().selected)
  const scriptCommands = scriptVerbs.flatMap(verb => scriptDestinations.map(destination => commands.register(scriptCommandId(verb, destination), {
    when: args => scripting.canRun(verb, nodeOf(args)),
    run: args => scripting.run(verb, destination, nodeOf(args))
  })))
  /**
   * The verbs and destinations the selection (or the object  names, with the selection keys it stands in: a Peek tab's)
   * can be scripted with now, grouped by verb as the menu shows them.
   */
  const scriptAs = (args?: CommandArgs) => {
    const key = args?.state?.explorerScriptTitle ?? context.getState().explorerScriptTitle, title = key ? scriptAsTitles[key] : 'Script As'
    const items: QuickPickItem[] = scriptVerbs.flatMap(verb => scriptDestinations.flatMap(destination => {
      const id = scriptCommandId(verb, destination)
      return commands.isEnabled(id, args) ? [{ id, label: `${scriptVerbSpecs[verb].name} to ${scriptDestinationSpecs[destination].title}`, group: scriptVerbTitle(verb), icon: scriptDestinationSpecs[destination].icon }] : []
    }))
    quickInput.show({
      title, ariaLabel: title, placeholder: 'Select a script type and destination', noun: 'scripts', sort: 'none', items,
      onDidAccept: item => { if (isCommandId(item.id)) void commands.execute(item.id, args, 'palette') }
    })
  }
  const registrations = [
    ...scriptCommands,
    commands.register('explorer.scriptAs', { run: args => scriptAs(args?.target ? args : undefined) }),
    // SSMS's Modify is ALTER To › New Query Editor Window, for the kinds that offer it.
    commands.register('explorer.modify', {
      when: args => { const node = nodeOf(args); return !!node && scriptMenuState(scriptTarget(node)).modifiable && scripting.canRun('alter', node) },
      run: args => scripting.run('alter', 'newQuery', nodeOf(args))
    }),
    commands.register('explorer.cancelScripting', { run: () => scripting.cancelAll() })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
