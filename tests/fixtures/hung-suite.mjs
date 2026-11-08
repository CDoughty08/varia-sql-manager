// A smoke suite that hangs with a long-lived grandchild, as a suite stuck with its Electron app open does: smoke-shards'
// runSuite must end both at its limit (tests/smoke-shards.test.ts). The grandchild writes its own pid to the file argv names.
import { spawn } from 'node:child_process'

// With --exit <code> it ends at once instead, for the check that a suite ending in time keeps its exit code.
if (process.argv[2] === '--exit') process.exit(Number(process.argv[3]))

// No double quotes or > in the code, so cmd.exe passes it through one quoted argument.
const code = "require('fs').writeFileSync(process.env.HUNG_SUITE_PID_FILE,String(process.pid));setInterval(function(){},1000)"
const env = { ...process.env, HUNG_SUITE_PID_FILE: process.argv[2] }
// Windows runs Electron under cmd.exe, so there the grandchild sits under a shell, as Electron does. POSIX: Playwright starts
// Electron detached, leading its own process group, which a kill of the suite's group never reaches; and a wedged app's
// close never finishes, so the suite ignores the signals Playwright's handlers would answer with a close.
if (process.platform === 'win32') spawn(`"${process.execPath}" -e "${code}"`, { stdio: 'ignore', shell: true, env })
else {
  spawn(process.execPath, ['-e', code], { stdio: 'ignore', env, detached: true })
  for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => {})
}
setInterval(() => {}, 1000)
