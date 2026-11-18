// Every grid copy, local or a result's, starts a copy generation: a local copy still formatting (LocalGrid, a page at a
// time) stops and writes nothing once a later copy has begun, as main's one copy job cancels a results copy. Any other
// text the page writes to the clipboard meanwhile (Script As, Copy Path) supersedes it too, as main's write cancels a
// results copy.
let generation = 0
const writes = (): number => (typeof window !== 'undefined' ? window.varia?.clipboardWrites?.() : undefined) ?? 0
export interface CopyGeneration { readonly generation: number; readonly writes: number }
export const beginCopy = (): CopyGeneration => ({ generation: ++generation, writes: writes() })
export const latestCopy = (copy: CopyGeneration): boolean => copy.generation === generation && copy.writes === writes()
