// What the Electron benchmarks decide about a measured segment (scripts/grid-bench.mjs), apart from measuring it.

/**
 * Whether a segment is measured once more. One with a long task always was, as results-smoke's segments are. One whose
 * figure is within a factor of two of its floor is too: a p95 over 40 jumps is its third-largest value, and a shared
 * runner that stalls for three of them reads twice what the same build read a minute earlier. A build that is really
 * that slow reads so both times, so the floor is not loosened: only a single unlucky run stops failing a pull request.
 * `floor` is the metric's floor in tests/bench/floors.json, or null when it has none.
 */
export const measuresAgain = (attempt, floor) => attempt.long.length > 0 || (floor !== null && attempt.value > floor / 2)

/** Of two attempts at a segment, the one that counts: the one with fewer long tasks, then the lower figure, then the later. */
export function betterAttempt(first, second) {
  if (first.long.length !== second.long.length) return first.long.length < second.long.length ? first : second
  return first.value < second.value ? first : second
}
