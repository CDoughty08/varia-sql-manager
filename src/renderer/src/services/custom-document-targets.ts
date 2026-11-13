/** The target registry resolves a live backend handle to its durable target. Names and profile keys are never identity. */
export interface CustomDocumentTargetOptions {
  readonly targetIdOf?: (connectionId: string) => string | undefined
}

/** A custom document keeps the target it opened on even while its live handle is absent or replaced. */
export class CustomDocumentTargets {
  private readonly bindings = new Map<string, { readonly connectionId: string; readonly targetId?: string }>()
  constructor(private readonly options: CustomDocumentTargetOptions) {}

  bind(id: string, connectionId: string): void {
    this.bindings.set(id, { connectionId, targetId: this.options.targetIdOf?.(connectionId) })
  }
  canFollowTarget(id: string, targetId: string): boolean {
    const binding = this.bindings.get(id)
    return binding?.targetId !== undefined && binding.targetId === targetId
  }
  matchesConnection(id: string, connectionId: string | undefined): boolean {
    const binding = this.bindings.get(id)
    if (!binding || connectionId === undefined) return false
    // Legacy documents without durable identity stay on their original handle until explicitly reopened.
    return binding.targetId === undefined ? binding.connectionId === connectionId : binding.targetId === this.options.targetIdOf?.(connectionId)
  }
  forget(id: string): void { this.bindings.delete(id) }
  clear(): void { this.bindings.clear() }
}
