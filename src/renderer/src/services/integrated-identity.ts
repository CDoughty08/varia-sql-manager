import type { ApiResult, ConnectionOptions, IntegratedIdentity } from '../../../shared/contracts'

/** Off Windows, the Kerberos principal Windows Authentication signs in with, for the Connect dialog's User Name and its saved
 * Windows Authentication rows. SSMS reads the identity when the dialog opens, so it is asked then whatever the form's
 * authentication, and again each time Windows Authentication is chosen, so a kinit or kdestroy since shows. A new question
 * clears the last answer, so a stale principal never shows while it is pending (a stuck cache can hold it for the deadline).
 * Windows never asks: DOMAIN\user comes with the connection library. */
export class IntegratedIdentityLookup {
  private asked = false
  private request = 0

  constructor(private readonly platform: string, private readonly ask: () => Promise<ApiResult<IntegratedIdentity>>, private readonly show: (principal: string | undefined) => void) {}

  /** Called on open and after every change of authentication. Another call on SQL Server Authentication, such as React's
   * StrictMode replay of the open, asks nothing new. */
  authenticationChanged(authentication: ConnectionOptions['authentication']): void {
    if (this.platform === 'win32' || (this.asked && authentication !== 'windows')) return
    this.asked = true
    const request = ++this.request
    this.show(undefined)
    const settle = (principal?: string) => { if (request === this.request) this.show(principal) }
    void this.ask().then(result => settle(result.ok ? result.value.principal : undefined), () => settle())
  }
}
