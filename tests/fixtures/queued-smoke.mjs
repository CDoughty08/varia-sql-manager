import { writeFileSync } from 'node:fs'
import { holdForEntry } from '../../scripts/machine-lock.mjs'

await holdForEntry()
writeFileSync(process.argv[2], process.env.VARIA_LOCK_HELD ?? 'missing')
process.exitCode = Number(process.argv[3] ?? 0)
