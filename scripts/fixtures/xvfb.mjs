/**
 * Whether this process runs under xvfb-run, which points XAUTHORITY into its own `xvfb-run.XXXXXX` temporary folder.
 *
 * Smoke windows stay hidden so a desktop's own pointer and focus never reach them, but Chromium on Linux sometimes stops
 * running a never-shown window's animation frames altogether: Dockview then never places its panels and the editor stays
 * hidden (CI's launch report read "animationFrame": "none within 2 s"). A virtual display has no pointer and no user, so
 * there the window is shown, inactive (VARIA_TEST_SHOW_WINDOW, a test seam main honours only in an unpackaged smoke run).
 */
export function underXvfb(env = process.env, platform = process.platform) {
  return platform === 'linux' && /(^|\/)xvfb-run\.[^/]+\/Xauthority$/.test(env.XAUTHORITY ?? '')
}
