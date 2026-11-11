/** Types for the cleanup the smoke scripts that start the packaged app share. */
import type { EventEmitter } from 'node:events'
import type { RmOptions } from 'node:fs'

export function exited(child: Pick<EventEmitter, 'once' | 'off'> & { exitCode: number | null; signalCode: NodeJS.Signals | null }, ms: number): Promise<boolean>
export function removeProfile(directory: string, remove?: (path: string, options: RmOptions) => void): boolean
