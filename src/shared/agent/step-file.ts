// Load from file… for CmdExec and PowerShell job steps (AG-11, SSMS's Open… on the Job Step page): main shows the open dialog itself,
// filtered to the step type's scripts plus All files, reads the chosen file under a size limit and returns only its text. The page
// names the step type, never a path.
import { z } from 'zod'
import { agentLimits } from './catalog.ts'

/** The step types whose command can be loaded from a file, with the dialog's title and script filter. */
export const stepScriptFileKinds = {
  PowerShell: { title: 'Load PowerShell script', filter: { name: 'PowerShell scripts', extensions: ['ps1', 'psm1', 'psd1'] } },
  CmdExec: { title: 'Load command file', filter: { name: 'Batch files', extensions: ['bat', 'cmd'] } }
} as const satisfies Readonly<Record<string, { readonly title: string; readonly filter: { readonly name: string; readonly extensions: readonly string[] } }>>
export type StepScriptSubsystem = keyof typeof stepScriptFileKinds
export const stepScriptSubsystems = Object.keys(stepScriptFileKinds) as StepScriptSubsystem[]
export const isStepScriptSubsystem = (subsystem: string): subsystem is StepScriptSubsystem => Object.hasOwn(stepScriptFileKinds, subsystem)

/** The one parameter `agentStepScript.open` takes. */
export const stepScriptOpenSchema = z.object({ subsystem: z.enum(stepScriptSubsystems as [StepScriptSubsystem, ...StepScriptSubsystem[]]) }).strict()

export const stepScriptLimits = {
  /** A loaded command holds at most what one step's command may (the save's limit). */
  chars: agentLimits.stepCommandChars,
  /** Bytes read: the most `chars` characters can take as UTF-8 (three bytes each) plus a byte order mark; one byte more is read to tell. */
  bytes: agentLimits.stepCommandChars * 3 + 3
} as const

export const stepScriptText = {
  load: 'Load from file…',
  tooLarge: `The file is longer than a step's command may be (${agentLimits.stepCommandChars.toLocaleString('en-US')} characters).`,
  notText: 'This file is not a text file Varia can read. Use UTF-8 or UTF-16.',
  notFile: 'The selection is not a file.',
  unavailable: 'Load from file is not available here.',
  locked: 'The step could not be edited when the file was chosen, so it was not loaded.'
} as const
