import { PlanCanvas } from '/src/renderer/src/plans/PlanCanvas'
import { PlanCanvas as Baseline } from 'virtual:plan-text-baseline'
import { layoutPlans } from '/src/renderer/src/plans/layout'

const statements = [{ id: 'statement', text: '', type: 'SELECT', estimatedCost: null, warnings: [], nodes: [{
  id: 'seek', parentId: null, nodeId: '0', physicalOp: 'Index Seek', logicalOp: 'Index Seek', object: '[dbo].[Orders].[IX_Customer]',
  warnings: [], properties: [], estimatedRows: 120, actualRows: 123, estimatedCost: null, elapsedMs: null, cpuMs: null, executions: 1
}] }]
const layout = layoutPlans(statements)
const colors = { background: '#181818', card: '#242424', text: '#e6e6e6', muted: '#a8a8a8', border: '#606060', accent: '#7aa2ff', warning: '#ffcc00' }
const failures: string[] = []
const samples: { mode: string; canvas: PlanCanvas }[] = []

for (const scale of [0.55, 0.75, 1, 1.2, 2, 3]) for (const [mode, Renderer] of [['before', Baseline], ['after', PlanCanvas]] as const) {
  const sample = document.createElement('section'); sample.className = 'sample'
  const title = document.createElement('div'); title.className = 'title'; title.textContent = `${Math.round(scale * 100)}% · display DPI ${devicePixelRatio}×`
  const root = document.createElement('div'); root.className = 'canvas'; root.style.height = `${Math.ceil(110 * scale + 28)}px`
  sample.append(title, root); document.querySelector('.samples')!.append(sample)
  // Fractional translations expose interpolation blur even at 100% zoom.
  const canvas = new Renderer({ root, statements, layout, colors,
    camera: { x: 12.25 - layout.bounds.x * scale, y: 8.5 - layout.bounds.y * scale, scale },
    select() {}, cameraChanged() {}, hover() {}, failed() { failures.push(`${mode} at ${scale}: GPU failure`) } })
  samples.push({ mode, canvas })
}

// Inspection stays in this fixture; the production canvas exposes no test API.
const inspect = (canvas: PlanCanvas) => canvas as unknown as {
  ready: boolean; draw(): void
  app: { canvas: HTMLCanvasElement; renderer: { resolution: number; gl: WebGLRenderingContext; canvasText: { _activeTextures: Record<string, unknown> } } }
  pool: { active: Map<string, { text: string; resolution: number; roundPixels: boolean;
    _gpuData: Record<string, { texture: { uid: number; source: { resolution: number } } }> }> }
}
const labels = (canvas: PlanCanvas) => [...inspect(canvas).pool.active].map(([key, label]) => {
  const texture = Object.values(label._gpuData).find(value => value.texture)!.texture
  return { key, text: label.text, resolution: label.resolution, textureResolution: texture.source.resolution, textureId: texture.uid, roundPixels: label.roundPixels }
})

// A context can be lost after initialization, and the loss event is delivered later than the loss itself.
// Check the recorded failures and every live context; `ready` alone stays true.
const check = () => {
  for (const { mode, canvas } of samples) {
    const rendering = inspect(canvas), gl = rendering.ready ? rendering.app.renderer.gl : undefined
    if (gl?.isContextLost()) failures.push(`${mode} at ${canvas.getCamera().scale}: WebGL context lost`)
  }
  if (failures.length) throw new Error([...new Set(failures)].join('; '))
}
const updated = () => samples.find(sample => sample.mode === 'after')!.canvas

window.planTextQuality = {
  async ready() {
    const deadline = Date.now() + 10_000
    while (samples.some(sample => !inspect(sample.canvas).ready)) {
      if (failures.length || Date.now() > deadline) throw new Error(failures.join('; ') || 'Pixi initialization timed out')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    check()
    const report = samples.map(({ mode, canvas }) => {
      const rendering = inspect(canvas), camera = canvas.getCamera()
      rendering.draw()
      const nextScale = camera.scale < 1 ? camera.scale * 1.1 : camera.scale * 0.9
      canvas.setCamera({ ...camera, scale: nextScale }); rendering.draw()
      const zoomed = labels(canvas), expected = rendering.app.renderer.resolution * nextScale
      const zoomUpdatedTextures = zoomed.length > 0 && zoomed.every(label => Math.abs(label.textureResolution - expected) < 0.00001)
      canvas.setCamera(camera); rendering.draw()
      const before = labels(canvas)
      canvas.pan(0.3, 0.6); canvas.update(statements); rendering.draw()
      const after = labels(canvas)
      const reused = before.every(label => after.some(value => value.key === label.key && value.textureId === label.textureId))
      canvas.setCamera(camera); rendering.draw()
      const { app } = rendering
      return { mode, zoom: camera.scale, webgl: !!app.renderer.gl && !app.renderer.gl.isContextLost(), rendererResolution: app.renderer.resolution,
        canvas: { width: app.canvas.width, height: app.canvas.height, cssWidth: app.canvas.clientWidth },
        zoomUpdatedTextures, panningReusedTextures: reused, labels: labels(canvas) }
    })
    check()
    return report
  },
  /** Rejects when any GPU failure was recorded or any context is lost; the runner calls it after capturing. */
  check,
  /** A long fractional zoom session against the real text system: counts Pixi's live and released text cache keys. */
  zoomSession(steps: number) {
    const canvas = updated(), rendering = inspect(canvas), camera = canvas.getCamera()
    for (let step = 1; step <= steps; step++) { canvas.setCamera({ ...camera, scale: camera.scale + step * 0.000001 }); rendering.draw() }
    const sharp = labels(canvas).every(label => label.textureResolution === label.resolution)
    canvas.setCamera(camera); rendering.draw()
    const entries = Object.values(rendering.app.renderer.canvasText._activeTextures)
    check()
    return { labels: labels(canvas).length, active: entries.filter(Boolean).length, released: entries.filter(entry => entry === null).length, sharp }
  },
  /** Fault injection: lose an initialized context and wait until the browser has reported it. */
  async loseContext() {
    const { canvas, renderer } = inspect(updated()).app
    const lost = new Promise(resolve => canvas.addEventListener('webglcontextlost', resolve, { once: true }))
    renderer.gl.getExtension('WEBGL_lose_context')!.loseContext()
    await lost
    return renderer.gl.isContextLost()
  },
  dispose() { for (const { canvas } of samples) canvas.dispose() }
}
