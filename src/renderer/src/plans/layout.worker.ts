import ELK from 'elkjs/lib/elk.bundled.js'
import { layoutPlans, type LayoutStatement } from './layout'

const elk = new ELK({ algorithms: ['layered'] })
self.onmessage = (event: MessageEvent<LayoutStatement[]>) => {
  void layoutPlans(event.data, graph => elk.layout(graph)).then(layout => self.postMessage({ ok: true, layout }), () => self.postMessage({ ok: false, error: 'The plan could not be laid out. Its XML source is available.' }))
}
