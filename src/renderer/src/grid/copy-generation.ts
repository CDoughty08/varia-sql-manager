// Every grid copy, local or a result's, starts a copy generation: a local copy still formatting (LocalGrid, a page at a
// time) stops and writes nothing once a later copy has begun, as main's one copy job cancels a results copy.
let generation = 0
export const beginCopy = (): number => ++generation
export const latestCopy = (copy: number): boolean => copy === generation
