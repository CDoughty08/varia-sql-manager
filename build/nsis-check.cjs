const fs = require('node:fs/promises')
const path = require('node:path')

// electron-builder 26.18 ships the bounded per-user path copy (https://github.com/electron-userland/electron-builder/pull/9769)
// that build/patch-nsis.cjs used to backport: the unbounded copy intermittently crashed the installer at startup. Refuse to
// build an installer from a template that lacks it, so a downgrade or a template change cannot bring the crash back.
const unbounded = "System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'"
const bounded = "System::Call 'KERNEL32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN})p'"

/** Why a multiUser.nsh source is unsafe to build from, or null. */
function nsisTemplateProblem(source) {
  if (source.includes(unbounded)) return 'NSIS per-user template copies the shell path without a bound (electron-builder #9769).'
  if (source.split(bounded).length !== 2) return 'NSIS per-user template changed; review the per-user path copy before building.'
  return null
}

/** The installed app-builder-lib's per-user template. */
function nsisTemplatePath() {
  return path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/multiUser.nsh')
}

async function checkNsis(context) {
  if (context.electronPlatformName !== 'win32') return
  const problem = nsisTemplateProblem(await fs.readFile(nsisTemplatePath(), 'utf8'))
  if (problem) throw new Error(problem)
}

module.exports = { checkNsis, nsisTemplateProblem, nsisTemplatePath }
