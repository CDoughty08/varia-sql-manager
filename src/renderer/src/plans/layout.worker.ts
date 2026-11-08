import { layoutPlans, type LayoutStatement } from './layout'

self.onmessage = (event: MessageEvent<LayoutStatement[]>) => {
  try { self.postMessage({ ok: true, layout: layoutPlans(event.data) }) }
  catch { self.postMessage({ ok: false, error: 'The plan could not be laid out. Its operator outline and XML source are available.' }) }
}
