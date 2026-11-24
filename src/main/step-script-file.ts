// Load from file… for CmdExec and PowerShell job steps (AG-11): reads the file main's own open dialog returned, under the step command's
// limit, with Open's encoding detection, and hands back only its text. No path ever comes from the page.
import { isAbsolute } from 'node:path'
import { stepScriptLimits, stepScriptText } from '../shared/agent/step-file'
import { readRegularFile } from './json-file'
import { detectAndDecode, type DecoderFactory } from './text-encoding'

export interface StepScriptReadOptions {
  /** The system's ANSI code page, read when the file is neither UTF-8 nor UTF-16 (Open's fallback). */
  readonly legacyLabel: string
  readonly decoder?: DecoderFactory
  readonly limits?: { readonly chars: number; readonly bytes: number }
}

/** The text of the file at `path` (an absolute path from main's open dialog), or an Error saying why it cannot be a step's command. */
export async function readStepScript(path: string, { legacyLabel, decoder, limits = stepScriptLimits }: StepScriptReadOptions): Promise<string> {
  if (!isAbsolute(path)) throw new Error(stepScriptText.notFile)
  let bytes: Buffer | undefined
  try { bytes = await readRegularFile(path, limits.bytes) } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    throw new Error(code === 'ENOENT' ? 'The file does not exist.' : code === 'EACCES' || code === 'EPERM' ? 'Access to the file was denied.' : code === 'EISDIR' ? stepScriptText.notFile : code === 'EBUSY' ? 'The file is in use by another program.' : 'The file could not be read.')
  }
  // A folder, FIFO or device is refused without blocking, and at most one byte past the limit is read.
  if (!bytes) throw new Error(stepScriptText.notFile)
  if (bytes.length > limits.bytes) throw new Error(stepScriptText.tooLarge)
  let text: string
  try { text = detectAndDecode(bytes, legacyLabel, decoder).text } catch (error) {
    // Open's own messages name SQL files; a step's script is any text, so the NUL refusal is said for it.
    const message = error instanceof Error ? error.message : ''
    throw new Error(/SQL text file/.test(message) || !message ? stepScriptText.notText : message)
  }
  if (text.length > limits.chars) throw new Error(stepScriptText.tooLarge)
  return text
}
