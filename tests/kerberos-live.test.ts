import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { BackendConnection } from '../src/main/backend/connection'
import { BackendError } from '../src/main/backend/errors'
import { deadlineFor } from '../src/shared/ipc/methods'
import type { ConnectionOptions } from '../src/shared/contracts'

// Integrated authentication on Linux and macOS without a Kerberos ticket, through the Release backend, as CI's Linux job
// runs it (VARIA_TEST_KERBEROS_NO_TICKET=1 with KRB5CCNAME naming a cache that does not exist). A real Kerberos round trip
// needs a KDC and a domain-joined SQL Server, so it is a manual check (README).
const enabled = process.env.VARIA_TEST_KERBEROS_NO_TICKET === '1' && !!process.env.VARIA_TEST_SQL_SERVER && process.platform !== 'win32'
// Asked for but unable to run is a failure, so CI cannot pass by skipping it.
if (process.env.VARIA_TEST_KERBEROS_NO_TICKET === '1' && !enabled) throw new Error('VARIA_TEST_KERBEROS_NO_TICKET needs VARIA_TEST_SQL_SERVER on Linux or macOS.')
const dll = resolve('backend/Varia.Backend/bin/Release/net10.0/Varia.Backend.dll')
const connections: BackendConnection[] = []
afterEach(async () => { await Promise.all(connections.splice(0).map(connection => connection.close())) })

async function failure(promise: Promise<unknown>): Promise<BackendError> {
  try { await promise } catch (error) { if (error instanceof BackendError) return error; throw error }
  throw new Error('Integrated authentication succeeded without a Kerberos ticket.')
}

describe.skipIf(!enabled)('integrated authentication without a Kerberos ticket', () => {
  it('connects through Kerberos instead of refusing, and says to run kinit, with the failure\'s details', async () => {
    const connection = new BackendConnection({ command: 'dotnet', args: [dll], cwd: process.cwd(), packaged: false }, 1)
    connections.push(connection)
    const options: ConnectionOptions = { server: process.env.VARIA_TEST_SQL_SERVER!, database: 'master', authentication: 'windows', trustServerCertificate: true }
    for (const method of ['connections.connect', 'connections.databases'] as const) {
      const failed = await failure(connection.send(method, options, deadlineFor(method, options)).done)
      expect(failed.code, failed.message).toBe('AUTH_KERBEROS')
      expect(failed.message).toMatch(/kinit/)
      expect(failed.details).toMatchObject({ number: 0, class: 11, server: expect.any(String) })
    }
  })
})
