const fs = require('node:fs/promises')
const path = require('node:path')

// electron-builder 26.18 ships the bounded per-user path copy (https://github.com/electron-userland/electron-builder/pull/9769)
// that build/patch-nsis.cjs used to backport: the unbounded copy intermittently crashed the installer at startup. Refuse to
// build an installer from a template that lacks it, so a downgrade or a template change cannot bring the crash back.
//
// The whole fix is compared, not one line of it: $2 starts at 0, the shell path is copied only with lstrcpynW bounded by
// NSIS_MAX_STRLEN, CoTaskMemFree runs only on a pointer SHGetKnownFolderPath set, and $1 and $2 are saved and restored.
// Lines are compared trimmed, with runs of spaces collapsed and comments and blank lines left out.
const boundedBlock = [
  'Push $1',
  'Push $2',
  'StrCpy $2 0',
  'System::Call \'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1\'',
  '${If} $1 == 0',
  'System::Call \'KERNEL32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN})p\'',
  '${endif}',
  '${If} $2 != 0',
  'System::Call \'OLE32::CoTaskMemFree(p r2)\'',
  '${endif}',
  'Pop $2',
  'Pop $1'
]

const normalise = source => source.split(/\r?\n/).map(line => line.trim().replace(/\s+/g, ' ')).filter(line => line && !line.startsWith('#') && !line.startsWith(';'))

/** Why a multiUser.nsh source is unsafe to build from, or null. */
function nsisTemplateProblem(source) {
  const lines = normalise(source)
  // A struct read through System::Call ('*addr(...)', however quoted or sized) copies a string with no bound. The template's
  // only struct read was the unbounded copy of SHGetKnownFolderPath's result.
  if (lines.some(line => /^System::Call\s*['"`]\s*\*/i.test(line))) return 'NSIS per-user template copies the shell path without a bound (electron-builder #9769).'
  const calls = lines.filter(line => /SHGetKnownFolderPath/i.test(line)).length
  const starts = lines.flatMap((line, index) => line === boundedBlock[0] && boundedBlock.every((expected, offset) => lines[index + offset] === expected) ? [index] : [])
  if (starts.length !== 1 || calls !== 1) return 'NSIS per-user template changed; review the per-user path copy before building.'
  return null
}

/** The per-user template of the app-builder-lib electron-builder itself loads, even if another copy is nested elsewhere. */
function nsisTemplatePath() {
  const builder = path.dirname(require.resolve('electron-builder/package.json'))
  return path.join(path.dirname(require.resolve('app-builder-lib/package.json', { paths: [builder] })), 'templates/nsis/multiUser.nsh')
}

async function checkNsis(context) {
  if (context.electronPlatformName !== 'win32') return
  const problem = nsisTemplateProblem(await fs.readFile(nsisTemplatePath(), 'utf8'))
  if (problem) throw new Error(problem)
}

module.exports = { checkNsis, nsisTemplateProblem, nsisTemplatePath }
