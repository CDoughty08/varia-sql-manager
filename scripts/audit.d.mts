/** Types for the dependency audit (scripts/audit.mjs). */
export const retryAfterSeconds: number[]
export interface AuditReport {
  kind: 'report'
  counts: Record<string, number>
  failing: { name: string; severity: string; advisories: string[] }[]
  failed: boolean
}
export interface AuditUnavailable { kind: 'unavailable'; reason: string }
export function readAudit(stdout: string): AuditReport | AuditUnavailable
