import type { ErrorCode } from '../../shared/ipc/wire/protocol'

/** A failed backend request. The code reaches the renderer as `ApiResult.code`; the message is shown as is. */
export class BackendError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'BackendError'
    this.code = code
  }
}

/** Fixed sentences (docs/ipc.md). None of them includes SQL text, server names, or anything the backend sent. */
export const sentences = {
  lost: 'The SQL backend stopped before answering. The request was not retried.',
  lostQuery: "The SQL backend stopped while this script was running. It was not re-run. Statements that finished before the failure may have taken effect; SQL Server rolls back the session's open transaction when it detects the closed connection.",
  closing: 'The application is closing.',
  reloaded: 'The workbench was reloaded.',
  stopped: 'The SQL backend stopped. Reload the workbench or restart the application.',
  tooLarge: 'The request is too large to send to the backend. Execute a smaller script or selection.',
  tooMany: 'Too many pending backend requests.',
  invalid: 'The SQL backend sent an invalid response. The request was cancelled.',
  spawnDevelopment: 'Could not start the .NET backend. Install .NET 10 and run npm run backend:build.',
  spawnPackaged: 'Could not start the SQL backend. Reinstall Varia SQL Manager.',
  incompatible: (detail: string, packaged: boolean) => `The SQL backend is from a different build (${detail}). ${packaged ? 'Reinstall Varia SQL Manager.' : 'Run npm run backend:build, then restart.'}`,
  timeout: (seconds: number) => `The SQL backend did not answer within ${seconds} seconds. The request was cancelled.`
} as const
