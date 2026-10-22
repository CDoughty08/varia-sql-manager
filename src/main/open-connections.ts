// SSMS's Open Connections prompt for Database Properties, as main shows it. The page sends nothing but the request to
// ask, so it cannot word the prompt or pick its default; Yes alone lets OK close the other connections.
import type { MessageBoxOptions } from 'electron'
import { z } from 'zod'
import { openConnectionsPrompt } from '../shared/actions/database.ts'

/** varia:confirm-open-connections takes no payload. */
export const confirmOpenConnectionsSchema = z.undefined()

export const openConnectionsBox = (signal?: AbortSignal): MessageBoxOptions => ({
  type: 'question', title: openConnectionsPrompt.title, message: openConnectionsPrompt.message, buttons: [...openConnectionsPrompt.buttons],
  defaultId: openConnectionsPrompt.defaultId, cancelId: openConnectionsPrompt.cancelId, noLink: true, ...signal ? { signal } : {}
})

/** Only Yes closes the other connections; No, Escape, a closed box and a page that went away do not. */
export const openConnectionsAnswer = (response: number): boolean => response === 0
