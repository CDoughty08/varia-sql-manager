// Test mode only (start.tsx): opens the server file picker as a dialog's "…" button will (D1b, D1d, D1e), on the first
// live connection, and keeps what it answered. No menu item opens it until a dialog's OK can use the path (A17).
import { serverFilePurposes, type ServerFilePurpose } from '../../../shared/actions/catalog.ts'
import type { ExternalStore } from '../core/types'
import type { LiveConnection } from '../services/connections'
import type { ServerFilePickerService } from './ServerFilePickerService'

/** The picker's answers in order: a path, or null for Cancel. */
export interface ServerFilesTestHook {
  pick(purpose: ServerFilePurpose, initialPath?: string, mustExist?: boolean): boolean
  answers(): (string | null)[]
}

export function serverFilesTestHook(service: ServerFilePickerService, connections: ExternalStore<readonly LiveConnection[]>): ServerFilesTestHook {
  const answers: (string | null)[] = []
  return {
    pick(purpose, initialPath, mustExist) {
      const connection = connections.getSnapshot().find(item => !item.lost)
      if (!connection || !serverFilePurposes.includes(purpose) || service.current) return false
      void service.pick({ connectionId: connection.id, purpose, ...(initialPath === undefined ? {} : { initialPath }), ...(mustExist === undefined ? {} : { mustExist }) }).then(path => { answers.push(path ?? null) })
      return true
    },
    answers: () => [...answers]
  }
}
