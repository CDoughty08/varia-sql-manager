import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('cloud session hook', () => {
  it('checks for and installs the SDK band global.json pins', () => {
    // A check for another band than the one installed reinstalls the SDK at every session start, and never installs it
    // on an image that has only the other band.
    const hook = readFileSync(resolve('.claude/hooks/session-start.sh'), 'utf8')
    const [major, minor] = (JSON.parse(readFileSync(resolve('global.json'), 'utf8')) as { sdk: { version: string } }).sdk.version.split('.')
    const checks = [...hook.matchAll(/dotnet --list-sdks[^\n]*grep -q '\^(\d+)\\.(\d+)\\.'/g)].map(match => `${match[1]}.${match[2]}`)
    const installs = [...hook.matchAll(/apt-get install -y dotnet-sdk-(\d+\.\d+)/g)].map(match => match[1])
    expect({ checks, installs }).toEqual({ checks: [`${major}.${minor}`], installs: [`${major}.${minor}`] })
  })
})
