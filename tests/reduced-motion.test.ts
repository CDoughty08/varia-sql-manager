import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { followReducedMotion, reducedMotionQuery } from '../src/renderer/src/services/reduced-motion'
import { SettingsService } from '../src/renderer/src/settings/SettingsService'
import { defaultSettings, settingDefs } from '../src/shared/settings/catalog'
import { reducedMotionClass, reducedMotionRoot } from '../src/shared/theme/metrics'
import { stylesheetRules } from './fixtures/css-rules'
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
})
