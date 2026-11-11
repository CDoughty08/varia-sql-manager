// Compare the real PlanCanvas with a Git revision, without a dev server or relaxed CSP.
// A local IIFE bundle also works where Chromium cannot make localhost requests.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { build } = require('vite'), { chromium } = require('playwright')
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'artifacts/plan-text-quality')
const sourcePath = 'src/renderer/src/plans/PlanCanvas.ts'
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

export async function runTextQualityComparison({ browser, baseline = 'origin/main' } = {}) {
  const baselineRevision = git('rev-parse', '--verify', `${baseline}^{commit}`)
  // The historical source keeps its own renderer configuration, but shares unchanged helpers/assets.
  const historical = git('show', `${baselineRevision}:${sourcePath}`)
    .replaceAll("from '../../../shared/", "from '/src/shared/")
    .replaceAll("from '../core/", "from '/src/renderer/src/core/")
    .replaceAll("from '../fonts'", "from '/src/renderer/src/fonts'")
    .replaceAll("from './", "from '/src/renderer/src/plans/")
  const bundle = await build({
    configFile: false, root, logLevel: 'warn',
    plugins: [{ name: 'plan-text-baseline',
      resolveId: id => id === 'virtual:plan-text-baseline' ? '\0plan-text-baseline' : undefined,
      load: id => id === '\0plan-text-baseline' ? { code: historical, map: null } : undefined,
      // Virtual modules have no .ts suffix, so explicitly strip the historical TypeScript.
      async transform(code, id) {
        if (id !== '\0plan-text-baseline') return
        const { transformWithEsbuild } = require('vite')
        return transformWithEsbuild(code, 'PlanCanvas.ts', { loader: 'ts' })
      }
    }],
    build: { write: false, minify: false,
      lib: { entry: resolve(root, 'scripts/fixtures/plan-text-quality/render.ts'), formats: ['iife'], name: 'PlanTextQuality' },
      rollupOptions: { output: { inlineDynamicImports: true } }
    }
  })
  const result = Array.isArray(bundle) ? bundle[0] : bundle
  await mkdir(output, { recursive: true })
  await writeFile(resolve(output, 'quality.js'), result.output.find(item => item.type === 'chunk').code)
  await writeFile(resolve(output, 'comparison.html'), await readFile(resolve(root, 'scripts/fixtures/plan-text-quality/index.html')))

  const ownBrowser = !browser
  browser ??= await chromium.launch({ headless: true, timeout: 20_000,
    ...(process.env.VARIA_BROWSER_EXECUTABLE ? { executablePath: process.env.VARIA_BROWSER_EXECUTABLE } : { channel: 'chrome' }) })
  const reports = [], errors = []
  try {
    for (const ratio of [1, 1.25, 2, 3]) {
      const context = await browser.newContext({ deviceScaleFactor: ratio, viewport: { width: 1400, height: 1400 } })
      try {
        const page = await context.newPage()
        page.setDefaultTimeout(15_000)
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
        await page.goto(pathToFileURL(resolve(output, 'comparison.html')).href)
        const samples = await page.evaluate(() => window.planTextQuality.ready())
        assert.equal(samples.length, 12)
        const updated = samples.filter(item => item.mode === 'after')
        assert.equal(updated.length, 6)
        for (const sample of updated) {
          assert.equal(sample.webgl, true)
          assert.equal(sample.rendererResolution, ratio)
          assert.ok(Math.abs(sample.canvas.width - sample.canvas.cssWidth * ratio) < 1)
          assert.ok(sample.labels.length >= 3, 'Render the heading, operator and caption')
          assert.equal(sample.zoomUpdatedTextures, true)
          assert.equal(sample.panningReusedTextures, true)
          for (const label of sample.labels) {
            assert.ok(Math.abs(label.resolution - ratio * sample.zoom) < 0.00001)
            assert.equal(label.textureResolution, label.resolution)
            assert.equal(label.roundPixels, true)
          }
        }
        const screenshot = `comparison-${ratio}x.png`
        await page.locator('body').screenshot({ path: resolve(output, screenshot) })
        // The capture is only evidence when every context survived rendering and the screenshot.
        await page.evaluate(() => window.planTextQuality.check())
        reports.push({ ratio, screenshot, samples })
        console.log(`Plan text: 55%, 75%, 100%, 120%, 200%, 300% at ${ratio}× DPI; WebGL textures and pan reuse verified.`)
        await page.evaluate(() => window.planTextQuality.dispose())
      } finally { await context.close() }
    }
    assert.deepEqual(errors, [])
    const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1400, height: 1400 } })
    try {
      // Console output is not collected here: the injected context loss is reported there by design.
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      await page.goto(pathToFileURL(resolve(output, 'comparison.html')).href)
      await page.evaluate(() => window.planTextQuality.ready())
      const session = await page.evaluate(() => window.planTextQuality.zoomSession(2000))
      assert.ok(session.labels >= 3 && session.sharp, 'Zoomed labels keep textures at their displayed resolution')
      assert.ok(session.active > 0 && session.active <= session.labels, 'Only visible labels hold text cache keys')
      assert.equal(session.released, 0, 'Retired text cache keys are released during a long zoom session')
      console.log(`Plan text: ${session.active} text cache keys and no released keys after 2,000 zoom steps.`)
      // A context lost after initialization must not produce a successful report.
      assert.equal(await page.evaluate(() => window.planTextQuality.loseContext()), true)
      await assert.rejects(page.evaluate(() => window.planTextQuality.ready()), /GPU failure|WebGL context lost/)
      await assert.rejects(page.evaluate(() => window.planTextQuality.check()), /GPU failure|WebGL context lost/)
      console.log('Plan text: a context lost after initialization fails the comparison.')
    } finally { await context.close() }
    const report = { baselineRevision, sourceSha256: createHash('sha256').update(await readFile(resolve(root, sourcePath))).digest('hex'),
      browser: browser.version(), reports, errors }
    await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
    return report
  } finally { if (ownBrowser) await browser.close() }
}

if (typeof process !== 'undefined' && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const index = process.argv.indexOf('--baseline')
  await runTextQualityComparison(index < 0 ? {} : { baseline: process.argv[index + 1] })
}
