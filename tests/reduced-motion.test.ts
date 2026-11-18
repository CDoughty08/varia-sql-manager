import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { followReducedMotion, reducedMotionQuery } from '../src/renderer/src/services/reduced-motion'
import { SettingsService } from '../src/renderer/src/settings/SettingsService'
import { defaultSettings, settingDefs } from '../src/shared/settings/catalog'
import { reducedMotionClass, reducedMotionRoot } from '../src/shared/theme/metrics'
import { cssRules, stylesheetRules } from './fixtures/css-rules'
import { settingsApi } from './fixtures/workbench'

const key = 'environment.reduceMotionWithSystem'
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

/** The system's preference, which a test changes as the OS (or Playwright's emulateMedia) would. */
function systemMedia(matches: boolean) {
  const listeners = new Set<() => void>()
  return {
    matches,
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener) },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener) },
    set(value: boolean) { this.matches = value; listeners.forEach(listener => listener()) },
    get listeners() { return listeners.size }
  }
}
function rootElement() {
  const classes = new Set<string>(['other'])
  const classList = { toggle: (name: string, force?: boolean) => { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); return classes.has(name) }, remove: (name: string) => { classes.delete(name) } }
  return { root: { classList } as unknown as Pick<HTMLElement, 'classList'>, reduced: () => classes.has(reducedMotionClass), classes }
}
async function setup(seed: Partial<Record<typeof key, boolean>>, matches: boolean) {
  const api = settingsApi(seed)
  const settings = new SettingsService(api)
  await settings.load()
  const media = systemMedia(matches), { root, reduced, classes } = rootElement()
  const follow = followReducedMotion(root, { enabled: () => settings.get(key), subscribe: settings.subscribe, media })
  cleanups.push(() => { follow.dispose(); settings.dispose() })
  return { api, settings, media, reduced, classes, follow }
}

describe('reduced motion', () => {
  it('is an Environment › General option, off by default', () => {
    const def = settingDefs.find(entry => entry.key === key)
    expect(def).toMatchObject({ page: 'environment.general', type: 'boolean', default: false, varia: true, label: 'Reduce motion when the system asks' })
    expect(defaultSettings[key]).toBe(false)
  })
  it('plays every animation by default, even when the system asks for reduced motion', async () => {
    const { media, reduced } = await setup({}, true)
    expect(reduced()).toBe(false)
    media.set(false)
    media.set(true)
    expect(reduced()).toBe(false)
  })
  it('sets the root class only while the setting is on and the system asks, as either changes', async () => {
    const { api, media, reduced, classes, follow } = await setup({}, true)
    await api.updateSettings({ [key]: true })
    expect(reduced()).toBe(true)
    media.set(false)
    expect(reduced()).toBe(false)
    media.set(true)
    expect(reduced()).toBe(true)
    await api.updateSettings({ [key]: null })
    expect(reduced()).toBe(false)
    await api.updateSettings({ [key]: true })
    expect(reduced()).toBe(true)
    // Other root classes are left alone, and disposing stops following and clears the class.
    expect(classes.has('other')).toBe(true)
    follow.dispose()
    expect(reduced()).toBe(false)
    expect(media.listeners).toBe(0)
  })
  it('starts reduced when the stored setting is on and the system asks, and never reduces without matchMedia', async () => {
    expect((await setup({ [key]: true }, true)).reduced()).toBe(true)
    expect((await setup({ [key]: true }, false)).reduced()).toBe(false)
    const { root, reduced } = rootElement()
    followReducedMotion(root, { enabled: () => true, subscribe: () => () => {} })
    expect(reduced()).toBe(false)
  })
  it('is wired into the workbench on the document root, from the setting and the system preference', () => {
    const workbench = readFileSync('src/renderer/src/core/workbench.ts', 'utf8')
    expect(workbench).toContain("followReducedMotion(document.documentElement, { enabled: () => api.followSystemMotion || settings.get('environment.reduceMotionWithSystem'), subscribe: settings.subscribe,")
    expect(workbench).toContain("media: typeof matchMedia === 'function' ? matchMedia(reducedMotionQuery) : undefined })")
    // Disposed with the workbench's other window listeners, and every popout and dialog window reports changes too.
    expect(workbench).toMatch(/const listeners = \[[^\]]*\breducedMotion,/)
    expect(workbench).toMatch(/attachWindow: target => \{\n\s+const attached = \[[^\]]*\breducedMotion\.watch\(target\)\]/)
  })
  it('updates when a popout or dialog window sees the preference change, as the main window may not while minimized', async () => {
    const { api, media, reduced } = await setup({}, false)
    await api.updateSettings({ [key]: true })
    const popout = systemMedia(false), queries: string[] = []
    const { root, reduced: popoutReduced } = rootElement()
    const follow = followReducedMotion(root, { enabled: () => true, subscribe: () => () => {}, media })
    const watching = follow.watch({ matchMedia: query => { queries.push(query); return popout } })
    expect(queries).toEqual([reducedMotionQuery])
    // The system changed; the main window has not reported it, but its matches already reads the new value.
    media.matches = true
    popout.set(true)
    expect(popoutReduced()).toBe(true)
    media.matches = false
    popout.set(false)
    expect(popoutReduced()).toBe(false)
    watching.dispose()
    expect(popout.listeners).toBe(0)
    follow.dispose()
    expect(reduced()).toBe(false)
  })
  it('keys every reduced-motion rule off the root class, never the prefers-reduced-motion media query', () => {
    const rules = stylesheetRules()
    expect(rules.filter(rule => rule.at.some(prelude => /prefers-reduced-motion/.test(prelude))).map(rule => rule.selector), `use ${reducedMotionRoot} instead`).toEqual([])
    expect(readFileSync('src/renderer/src/styles.css', 'utf8')).not.toMatch(/prefers-reduced-motion/)
    // A rule that mixes reduced and unreduced parts would apply some of its reduced-motion styles to everyone.
    const parts = (selector: string) => selector.split(/,(?![^(]*\))/).map(part => part.trim())
    const isReduced = (part: string) => part === reducedMotionRoot || part.startsWith(reducedMotionRoot + ' ')
    const mentions = rules.filter(rule => rule.selector.includes(reducedMotionClass))
    expect(mentions.length).toBeGreaterThan(1)
    expect(mentions.filter(rule => !parts(rule.selector).every(isReduced)).map(rule => rule.selector)).toEqual([])
    expect(mentions.filter(rule => rule.at.length).map(rule => rule.selector)).toEqual([])
    // Only the service that sets the class reads the media query in renderer code and markup.
    const dir = 'src/renderer'
    const readers = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(file => /\.(?:tsx?|css|html)$/.test(file))
      .filter(file => readFileSync(join(dir, file), 'utf8').includes('prefers-reduced-motion')).map(file => file.replace(/\\/g, '/'))
    expect(readers).toEqual(['src/services/reduced-motion.ts'])
    expect(reducedMotionQuery).toBe('(prefers-reduced-motion: reduce)')
  })
  it('gives Dockview nothing its own prefers-reduced-motion rule would stop', () => {
    // start.tsx imports Dockview's stylesheet, which turns every transition on its tabs and group chips off with
    // !important whenever the system asks for reduced motion, whatever the setting says. Varia animates neither: its dock
    // themes leave Dockview's tabAnimation unset (only 'smooth' shifts tabs while a tab is dragged over them) and it makes
    // no tab groups. Dockview still shifts tabs if a tab is added or removed in the middle of a drag from another group,
    // which the system's preference can make instant. Animating either needs rules in styles.css that put the transitions
    // back while the class is off.
    expect(readFileSync('src/renderer/src/start.tsx', 'utf8')).toContain("import 'dockview-react/dist/styles/dockview.css'")
    const dockview = cssRules(readFileSync('node_modules/dockview-react/dist/styles/dockview.css', 'utf8'))
    const parts = (selector: string) => selector.split(/,(?![^(]*\))/).map(part => part.trim())
    const stopped = dockview.filter(rule => rule.at.some(prelude => /prefers-reduced-motion/.test(prelude)))
    expect(stopped.flatMap(rule => rule.declarations.map(({ property, value }) => `${property}: ${value}`))).toEqual(stopped.flatMap(rule => rule.declarations.map(() => 'transition: none !important')))
    const classes = stopped.flatMap(rule => parts(rule.selector)).map(part => part.match(/^\.([\w-]+)$/)?.[1])
    expect(classes).toEqual(['dv-tab', 'dv-tab-group-chip'])
    const subject = (part: string) => part.split(/\s*[\s>+~]\s*(?![^(]*\))/).pop() ?? ''
    const animated = stylesheetRules().filter(rule => rule.declarations.some(({ property }) => /^transition/.test(property))
      && parts(rule.selector).some(part => classes.some(name => new RegExp(`\\.${name}(?![\\w-])`).test(subject(part)))))
    expect(animated.map(rule => rule.selector), 'Dockview stops these under prefers-reduced-motion whatever the setting says').toEqual([])
    const dir = 'src/renderer/src'
    const tabMotion = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(file => /\.tsx?$/.test(file))
      .filter(file => /\btabAnimation\b|\bTabGroup|\btabGroup/.test(readFileSync(join(dir, file), 'utf8')))
    expect(tabMotion, 'Dockview\'s tab animation and tab groups move tabs with transitions its prefers-reduced-motion rule stops').toEqual([])
  })
})
