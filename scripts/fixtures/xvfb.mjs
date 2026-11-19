/** Whether this process runs under xvfb-run, which points XAUTHORITY into its own `xvfb-run.XXXXXX` temporary folder. */
export function underXvfb(env = process.env, platform = process.platform) {
  return platform === 'linux' && /(^|\/)xvfb-run\.[^/]+\/Xauthority$/.test(env.XAUTHORITY ?? '')
}

export const gpuSwitch = '--disable-gpu'

/**
 * A smoke launch's arguments: under xvfb, with `--disable-gpu`. A virtual display has no GPU, so Chromium's first GPU
 * process failed to start on almost every CI launch and was replaced by a software one; about one launch in 1,400 the failed
 * process never finished exiting, no replacement started, and the window ran no animation frames at all ("animationFrame":
 * "none within 2 s", the editor hidden for 30 s). Starting in software skips that process, and the first frame comes sooner.
 */
export function xvfbArgs(args, env = process.env, platform = process.platform) {
  return underXvfb(env, platform) && !args.includes(gpuSwitch) ? [...args, gpuSwitch] : args
}
