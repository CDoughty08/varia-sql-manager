/** Whether this process runs under xvfb-run, which points XAUTHORITY into its own `xvfb-run.XXXXXX` temporary folder. */
export function underXvfb(env = process.env, platform = process.platform) {
  return platform === 'linux' && /(^|\/)xvfb-run\.[^/]+\/Xauthority$/.test(env.XAUTHORITY ?? '')
}

export const gpuSwitch = '--disable-gpu'

/**
 * An Electron launch's arguments: under xvfb, with `--disable-gpu`. A virtual display has no GPU, so Chromium's first GPU
 * process failed to start on almost every CI launch and was replaced by a software one. Rarely (2 of about 4,700 launches
 * under load) the failed process never exited and nothing replaced it, so the window ran no animation frames and the editor
 * stayed hidden. Starting in software never runs that process.
 */
export function xvfbArgs(args, env = process.env, platform = process.platform) {
  return underXvfb(env, platform) && !args.includes(gpuSwitch) ? [...args, gpuSwitch] : args
}
