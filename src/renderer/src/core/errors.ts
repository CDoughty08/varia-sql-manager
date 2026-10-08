/** Reports a failure in a listener or contribution without interrupting the workbench operation that triggered it. */
export function onUnexpectedError(error: unknown): void {
  console.error('Unexpected workbench error', error)
}
