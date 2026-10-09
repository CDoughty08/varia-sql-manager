import { describe, expect, it } from 'vitest'
import { rendererRoles } from '../src/shared/commands/catalog'
import { runRole, UserActivation, userActivationMs, type RoleWindow } from '../src/main/window-roles'

const activated = () => true

/** A window that records which of its methods ran. */
function fakeWindow(zoom = 0) {
  const calls: string[] = []
  let fullScreen = false, level = zoom
  const record = (name: string) => () => { calls.push(name) }
  const window: RoleWindow = {
    isFullScreen: () => fullScreen,
    setFullScreen: flag => { fullScreen = flag; calls.push(`setFullScreen ${flag}`) },
    webContents: {
      cut: record('cut'), copy: record('copy'), paste: record('paste'), delete: record('delete'), selectAll: record('selectAll'), reload: record('reload'), toggleDevTools: record('toggleDevTools'),
      getZoomLevel: () => level, setZoomLevel: value => { level = value; calls.push(`setZoomLevel ${value}`) }
    }
  }
  return { window, calls }
}

describe('window roles', () => {
  it('runs each role as Electron\'s role item would', () => {
    const expected: Record<string, string[]> = {
      cut: ['cut'], copy: ['copy'], paste: ['paste'], delete: ['delete'], selectAll: ['selectAll'], reload: ['reload'], toggleDevTools: ['toggleDevTools'],
      resetZoom: ['setZoomLevel 0'], zoomIn: ['setZoomLevel 1.5'], zoomOut: ['setZoomLevel 0.5'], togglefullscreen: ['setFullScreen true']
    }
    expect(Object.keys(expected).sort()).toEqual([...rendererRoles].sort())
    for (const role of rendererRoles) {
      const { window, calls } = fakeWindow(1)
      runRole(role, window, activated)
      expect(calls, role).toEqual(expected[role])
    }
  })
  it('steps zoom by half a level without a limit, and toggles full screen both ways', () => {
    const { window, calls } = fakeWindow(9)
    runRole('zoomIn', window, activated)
    runRole('zoomIn', window, activated)
    runRole('zoomOut', window, activated)
    runRole('togglefullscreen', window, activated)
    runRole('togglefullscreen', window, activated)
    expect(calls).toEqual(['setZoomLevel 9.5', 'setZoomLevel 10', 'setZoomLevel 9.5', 'setFullScreen true', 'setFullScreen false'])
  })
  it('rejects anything but its roles: no quit, no other window methods', () => {
    for (const value of ['quit', 'close', 'openExternal', 'forceReload', '__proto__', 'Cut', '', 1, null, undefined, ['cut'], { role: 'cut' }]) {
      const { window, calls } = fakeWindow()
      expect(() => runRole(value, window, activated), String(value)).toThrow()
      expect(calls).toEqual([])
    }
  })
  it('pastes only just after the user clicked or pressed a key, and runs every other role regardless', () => {
    const { window, calls } = fakeWindow()
    expect(() => runRole('paste', window, () => false)).toThrow('Paste runs only from a click or a key press in the window.')
    for (const role of rendererRoles.filter(role => role !== 'paste')) runRole(role, window, () => false)
    expect(calls).not.toContain('paste')
    expect(calls).toContain('cut')
  })
  it('counts clicks and key presses as the user acting for a second, but not pointer moves or wheel turns', () => {
    let now = 5000
    const activation = new UserActivation(() => now)
    expect(activation.recent()).toBe(false)
    for (const type of ['mouseMove', 'mouseEnter', 'mouseWheel', 'gestureScrollBegin', 'contextMenu', 'undefined']) activation.note(type)
    expect(activation.recent()).toBe(false)
    for (const type of ['mouseDown', 'mouseUp', 'rawKeyDown', 'keyDown', 'keyUp', 'char']) {
      const fresh = new UserActivation(() => now)
      fresh.note(type)
      expect(fresh.recent(), type).toBe(true)
    }
    activation.note('mouseUp')
    now += userActivationMs
    expect(activation.recent()).toBe(true)
    now += 1
    expect(activation.recent()).toBe(false)
  })
})
