// BigQuery error values the renderer tells apart by more than their code (docs/bigquery.md, Errors).

/** How the backend's VPC Service Controls refusal opens (BigQueryErrors.PerimeterOpening, held to this text by
 *  tests/bigquery-job-history.test.ts): a PERMISSION_DENIED that no permission or role fixes. */
export const perimeterOpening = 'VPC Service Controls blocked this request'

/** Whether an error is VPC Service Controls' refusal, to which a view adds no permission advice. */
export function isPerimeterRefusal(code: string | undefined, message: string | undefined): boolean {
  return code === 'PERMISSION_DENIED' && !!message?.startsWith(perimeterOpening)
}

/** Whether a PERMISSION_DENIED is about a permission, so a view may add which one it needs. */
export function isPermissionRefusal(code: string | undefined, message: string | undefined): boolean {
  return code === 'PERMISSION_DENIED' && !isPerimeterRefusal(code, message)
}
