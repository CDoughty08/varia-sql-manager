/** Timer functions, injected so tests can drive time by hand. */
export interface Timers { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
export const browserTimers: Timers = { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }
