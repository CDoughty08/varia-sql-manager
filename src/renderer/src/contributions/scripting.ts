import { isCommandId } from '../../../shared/commands/catalog'
import { scriptAsTitles, scriptCommandId, scriptDestinations, scriptDestinationSpecs, scriptMenuState, scriptVerbs, scriptVerbSpecs, scriptVerbTitle } from '../../../shared/scripting/catalog.ts'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf } from '../menus/targets'
import type { QuickPickItem } from '../quickinput/QuickInputService'
import { scriptTarget } from '../scripting/ScriptingService'

/**
 * Scripting's commands. Script as › <verb> To › <destination> acts on the node its menu was opened for, otherwise on
 * the selected node (the palette's Script As… and Modify). Tools › Options… opens once main's stored options are in,
 * so OK never writes a draft that started from the defaults over options the user saved before.
 */
export function scriptingContribution({ commands, scriptingOptions, scripting, explorer, quickInput, context }: Pick<Workbench, 'commands' | 'scriptingOptions' | 'scripting' | 'explorer' | 'quickInput' | 'context'>): Disposable {
  const nodeOf = (args?: CommandArgs) => args?.target ? explorerNodeOf(args) : explorer.menuNode(explorer.getSnapshot().selected)
  const scriptCommands = scriptVerbs.flatMap(verb => scriptDestinations.map(destination => commands.register(scriptCommandId(verb, destination), {
    when: args => scripting.canRun(verb, nodeOf(args)),
    run: args => scripting.run(verb, destination, nodeOf(args))
  })))
  /** The verbs and destinations the selection can be scripted with now, grouped by verb as the menu shows them. */
  const scriptAs = () => {
    const key = context.getState().explorerScriptTitle, title = key ? scriptAsTitles[key] : 'Script As'
    const items: QuickPickItem[] = scriptVerbs.flatMap(verb => scriptDestinations.flatMap(destination => {
      const id = scriptCommandId(verb, destination)
      return commands.isEnabled(id) ? [{ id, label: `${scriptVerbSpecs[verb].name} to ${scriptDestinationSpecs[destination].title}`, group: scriptVerbTitle(verb), icon: scriptDestinationSpecs[destination].icon }] : []
    }))
    quickInput.show({
      title, ariaLabel: title, placeholder: 'Select a script type and destination', noun: 'scripts', sort: 'none', items,
      onDidAccept: item => { if (isCommandId(item.id)) void commands.execute(item.id, undefined, 'palette') }
    })
  }
  const registrations = [
    ...scriptCommands,
    commands.register('explorer.scriptAs', { run: scriptAs }),
    // SSMS's Modify is ALTER To › New Query Editor Window, for the kinds that offer it.
    commands.register('explorer.modify', {
      when: args => { const node = nodeOf(args); return !!node && scriptMenuState(scriptTarget(node)).modifiable && scripting.canRun('alter', node) },
      run: args => scripting.run('alter', 'newQuery', nodeOf(args))
    }),
    commands.register('explorer.cancelScripting', { run: () => scripting.cancelAll() }),
    // A draft started from the defaults would replace the user's options on OK, so a failed read opens nothing.
    commands.register('preferences.options', { run: async () => { if (await scriptingOptions.load()) scriptingOptions.openDialog() } })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
