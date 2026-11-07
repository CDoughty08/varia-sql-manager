import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { planLimits } from '../shared/plans'

const compress = promisify(gzip)
let pending = 0
/** Compression runs in libuv, not on Electron's UI thread. Never change the protocol's request limit for plan XML. */
export async function preparePlan(xml: string): Promise<{ xml: string; encoding: 'gzip' }> {
  if (!xml.length || xml.length > planLimits.characters) throw new Error('Execution plans are limited to 8,388,608 characters.')
  if (pending >= 2) throw new Error('Two execution plans are already being prepared. Try again shortly.')
  pending++
  try {
    const bytes = await compress(xml, { level: 1 })
    if (bytes.length > planLimits.compressedBytes) throw new Error('This execution plan exceeds the 2 MiB compressed input limit.')
    return { xml: bytes.toString('base64'), encoding: 'gzip' }
  } finally { pending-- }
}
