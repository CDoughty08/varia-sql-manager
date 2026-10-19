/**
 * Runs `callback` on the next animation frame, or after 50 ms when frames are throttled: a hidden window (the smoke
 * tests') gets about one frame a second, which would hold every grid update back that long. Returns a cancel function.
 */
export function nextFrame(callback: () => void): () => void {
  let done = false
  const run = () => { if (done) return; done = true; cancelAnimationFrame(frame); clearTimeout(timer); callback() }
  const frame = requestAnimationFrame(run)
  const timer = setTimeout(run, 50)
  return () => { done = true; cancelAnimationFrame(frame); clearTimeout(timer) }
}
