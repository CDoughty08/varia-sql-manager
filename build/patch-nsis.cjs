const fs = require('node:fs/promises')
const path = require('node:path')

// Backport the upstream bounded path copy until the project's electron-builder pin includes it:
// https://github.com/electron-userland/electron-builder/pull/9769
// Patching the installed template before NSIS runs retains electron-builder's standard installer and uninstaller scripts.
const original = `      System::Store S
      # Win7 has a per-user programfiles known folder and this can be a non-default location
      System::Call 'SHELL32::SHGetKnownFolderPath(g "${'${FOLDERID_UserProgramFiles}'}", i ${'${KF_FLAG_CREATE}'}, p 0, *p .r2)i.r1'
      ${'${If}'} $1 == 0
        System::Call '*$2(&w${'${NSIS_MAX_STRLEN}'} .s)'
        StrCpy $0 $1
        System::Call 'OLE32::CoTaskMemFree(p r2)'
      ${'${endif}'}
      System::Store L`

const fixed = `      # Varia backport of electron-builder #9769: copy the NUL-terminated shell path safely.
      Push $1
      Push $2
      StrCpy $2 0
      System::Call 'SHELL32::SHGetKnownFolderPath(g "${'${FOLDERID_UserProgramFiles}'}", i ${'${KF_FLAG_CREATE}'}, p 0, *p .r2)i.r1'
      ${'${If}'} $1 == 0
        System::Call 'KERNEL32::lstrcpynW(w .r0, p r2, i ${'${NSIS_MAX_STRLEN}'})p'
      ${'${endif}'}
      ${'${If}'} $2 != 0
        System::Call 'OLE32::CoTaskMemFree(p r2)'
      ${'${endif}'}
      Pop $2
      Pop $1`

module.exports = async function patchNsis(context) {
  if (context.electronPlatformName !== 'win32') return
  const packagePath = require.resolve('app-builder-lib/package.json')
  const version = require(packagePath).version
  if (version !== '26.8.1') throw new Error(`Review the NSIS backport before using app-builder-lib ${version}.`)
  const template = path.join(path.dirname(packagePath), 'templates/nsis/multiUser.nsh')
  const source = (await fs.readFile(template, 'utf8')).replace(/\r\n/g, '\n')
  if (source.includes(fixed)) return
  if (source.split(original).length !== 2) throw new Error('NSIS per-user template changed; refusing to build without the installer fix.')
  await fs.writeFile(template, source.replace(original, fixed), 'utf8')
  console.log('Applied the electron-builder #9769 per-user installer path fix.')
}
