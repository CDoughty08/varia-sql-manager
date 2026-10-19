// INS/OVR. Monaco 0.57 types over text in overtype mode, but its mode has no public setter and no command, so this is
// the one file that reaches into Monaco's InputMode. Every editor shares the mode, as Visual Studio's Insert key does.
import { InputMode } from 'monaco-editor/editor/common/inputMode.js'
import { SnapshotStore } from './store'
import type { Disposable } from './types'

export type InputModeName = 'insert' | 'overtype'
/** The members of Monaco's InputMode this relies on. */
export interface MonacoInputMode {
  _inputMode: InputModeName
  readonly _onDidChangeInputMode: { fire(mode: InputModeName): void }
  getInputMode(): InputModeName
  onDidChangeInputMode(listener: (mode: InputModeName) => void): Disposable
}
export interface InputModeSnapshot { readonly mode: InputModeName; readonly available: boolean }

/** `value` as Monaco's InputMode, or undefined when an upgrade changed what this relies on. */
export function asInputMode(value: unknown): MonacoInputMode | undefined {
  const candidate = value as Partial<MonacoInputMode> | null | undefined
  const usable = !!candidate && (candidate._inputMode === 'insert' || candidate._inputMode === 'overtype') && typeof candidate.getInputMode === 'function'
    && typeof candidate.onDidChangeInputMode === 'function' && typeof candidate._onDidChangeInputMode?.fire === 'function'
  return usable ? candidate as MonacoInputMode : undefined
}

/**
 * Reads and sets the editors' input mode. Without a usable InputMode the mode stays Insert, `available` is false (the
 * toggle command is disabled), and nothing throws.
 */
export class InputModeService extends SnapshotStore<InputModeSnapshot> implements Disposable {
  private readonly subscription?: Disposable
  private readonly target?: MonacoInputMode
  /** `source` is Monaco's InputMode; tests pass a stand-in, or what an upgrade might leave. */
  constructor(source: unknown = InputMode) {
    const target = asInputMode(source)
    super({ mode: target?.getInputMode() ?? 'insert', available: !!target })
    this.target = target
    this.subscription = target?.onDidChangeInputMode(mode => { if (mode !== this.getSnapshot().mode) this.publish({ mode, available: true }) })
  }
  get(): InputModeName { return this.getSnapshot().mode }
  set(mode: InputModeName): void {
    const target = this.target
    if (!target || target.getInputMode() === mode) return
    target._inputMode = mode
    // Editors recompute their cursor style from this event, and the store publishes from it.
    target._onDidChangeInputMode.fire(mode)
  }
  /** The Insert key. */
  toggle(): void { this.set(this.get() === 'insert' ? 'overtype' : 'insert') }
  dispose(): void {
    this.subscription?.dispose()
    this.clearListeners()
  }
}
