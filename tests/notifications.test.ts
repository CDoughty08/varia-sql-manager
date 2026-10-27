import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { autoHides, NotificationService, notificationLimits } from '../src/renderer/src/core/notifications'
import Toasts, { ToastAnnouncements } from '../src/renderer/src/kit/Toasts'
import { connectFix } from '../src/renderer/src/connect-fix'
import { FailureDetails } from '../src/renderer/src/ConnectDialog'
import { advancedDefaults } from '../src/shared/connections'
import { computeContextKeys } from '../src/renderer/src/core/contextkeys'
import { manualTimers, workbenchFixture } from './fixtures/workbench'

const service = () => {
  const timers = manualTimers()
  return { timers, notifications: new NotificationService({ timers: timers.timers }) }
}
const messages = (notifications: NotificationService) => notifications.getSnapshot().visible.map(toast => toast.message)

describe('notification service', () => {
  it('shows three toasts and queues the rest, dropping the oldest waiting one past twenty', () => {
    const { notifications } = service()
    for (let index = 1; index <= 3 + notificationLimits.queued + 2; index++) notifications.notify({ severity: 'error', message: `Toast ${index}.` })
    expect(messages(notifications)).toEqual(['Toast 1.', 'Toast 2.', 'Toast 3.'])
    expect(notifications.getSnapshot().queued).toBe(notificationLimits.queued)
    // Dismissing one on screen brings the oldest survivor forward: toasts 4 and 5 were dropped to make room.
    notifications.dismiss(notifications.getSnapshot().visible[0].id)
    expect(messages(notifications)).toEqual(['Toast 2.', 'Toast 3.', 'Toast 6.'])
    notifications.clear()
    expect(notifications.getSnapshot()).toMatchObject({ visible: [], queued: 0 })
  })
  it('lets information leave after 8 s, held while pointed at or focused, and keeps errors and toasts with actions', () => {
    const { notifications, timers } = service()
    const info = notifications.notify({ severity: 'info', message: 'Saved 5 rows to out.csv.' })
    notifications.notify({ severity: 'error', message: 'The export failed.' })
    notifications.notify({ severity: 'info', message: 'Saved 6 rows to b.csv.', actions: [{ label: 'Show results', run: () => {} }] })
    timers.advance(notificationLimits.autoHideMs - 1)
    notifications.hold(info, true)
    timers.advance(60_000)
    expect(messages(notifications)).toEqual(['Saved 5 rows to out.csv.', 'The export failed.', 'Saved 6 rows to b.csv.'])
    // Let go: the full time again, never the rest of the old one.
    notifications.hold(info, false)
    timers.advance(notificationLimits.autoHideMs - 1)
    expect(messages(notifications)).toHaveLength(3)
    timers.advance(1)
    expect(messages(notifications)).toEqual(['The export failed.', 'Saved 6 rows to b.csv.'])
    expect([autoHides({ severity: 'warning', message: '' }), autoHides({ severity: 'error', message: '' }), autoHides({ severity: 'info', message: '', actions: [{ label: 'x', run: () => {} }] })]).toEqual([true, false, false])
  })
  it('starts a queued toast\'s time only once it shows', () => {
    const { notifications, timers } = service()
    for (let index = 1; index <= 3; index++) notifications.notify({ severity: 'error', message: `Error ${index}.` })
    notifications.notify({ severity: 'info', message: 'Waiting.' })
    timers.advance(notificationLimits.autoHideMs * 2)
    notifications.dismiss(notifications.getSnapshot().visible[0].id)
    expect(messages(notifications)).toContain('Waiting.')
    timers.advance(notificationLimits.autoHideMs - 1)
    expect(messages(notifications)).toContain('Waiting.')
    timers.advance(1)
    expect(messages(notifications)).not.toContain('Waiting.')
  })
  it('replaces a toast with the same key, bounds the sentence and the actions, and announces errors at once', () => {
    const { notifications } = service()
    notifications.notify({ severity: 'info', message: 'Saved 1 row to a.csv.', key: 'save:t1' })
    notifications.notify({ severity: 'info', message: 'Saved 2 rows to a.csv.', key: 'save:t1' })
    expect(messages(notifications)).toEqual(['Saved 2 rows to a.csv.'])
    expect(notifications.getSnapshot().announcement).toMatchObject({ text: 'Saved 2 rows to a.csv.', assertive: false })
    const action = { label: 'A', run: () => {} }
    notifications.notify({ severity: 'error', message: 'x'.repeat(2000), actions: [action, action, action] })
    const long = notifications.getSnapshot().visible[1]
    expect([long.message.length, long.message.endsWith('…'), long.actions?.length]).toEqual([notificationLimits.message, true, notificationLimits.actions])
    expect(notifications.getSnapshot().announcement).toMatchObject({ toastId: long.id, assertive: true })
  })
  it('keeps a replaced toast\'s id, place and hold, and starts its time over', () => {
    const { notifications, timers } = service()
    const first = notifications.notify({ severity: 'info', message: 'Saved 1 row to a.csv.', key: 'save:t1' })
    const other = notifications.notify({ severity: 'info', message: 'Other.' })
    notifications.hold(first, true)
    // The same toast (so its element, focus and pointer stay), still held while the pointer or focus is on it.
    expect(notifications.notify({ severity: 'info', message: 'Saved 2 rows to a.csv.', key: 'save:t1' })).toBe(first)
    expect(notifications.getSnapshot().visible.map(toast => toast.id)).toEqual([first, other])
    timers.advance(notificationLimits.autoHideMs * 2)
    expect(messages(notifications)).toEqual(['Saved 2 rows to a.csv.'])
    notifications.hold(first, false)
    timers.advance(notificationLimits.autoHideMs - 1)
    notifications.notify({ severity: 'info', message: 'Saved 3 rows to a.csv.', key: 'save:t1' })
    timers.advance(notificationLimits.autoHideMs - 1)
    expect(messages(notifications)).toEqual(['Saved 3 rows to a.csv.'])
    timers.advance(1)
    expect(messages(notifications)).toEqual([])
  })
  it('announces a sentence that repeats the last one again, and stops announcing a toast once it goes', () => {
    const { notifications } = service()
    // The polite region's child: a node keyed by the announcement, or nothing.
    const region = () => {
      const tree = ToastAnnouncements({ announcement: notifications.getSnapshot().announcement })
      const [status] = (tree.props as { children: { props: { children: { key: string | null } | null } }[] }).children
      return status.props.children
    }
    const first = notifications.notify({ severity: 'info', message: 'Saved 5 rows to a.csv.', key: 'save:t1' })
    const before = region()
    notifications.notify({ severity: 'info', message: 'Saved 5 rows to a.csv.', key: 'save:t1' })
    // The same toast and sentence, but a new node in the region, which screen readers read as new.
    expect(notifications.getSnapshot().announcement).toMatchObject({ toastId: first, text: 'Saved 5 rows to a.csv.' })
    expect([typeof before?.key, region()?.key !== before?.key]).toEqual(['string', true])
    const other = notifications.notify({ severity: 'info', message: 'Other.' })
    notifications.dismiss(first)
    expect(notifications.getSnapshot().announcement?.toastId).toBe(other)
    notifications.dismiss(other)
    expect([notifications.getSnapshot().announcement, region()]).toEqual([undefined, null])
    notifications.notify({ severity: 'error', message: 'Failed.' })
    notifications.clear()
    expect(notifications.getSnapshot().announcement).toBeUndefined()
  })
  it('dismisses a toast before running its action, and survives an action that throws', () => {
    const { notifications } = service()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const id = notifications.notify({ severity: 'info', message: 'Saved.', actions: [{ label: 'Show results', run: () => { throw new Error('gone') } }] })
    notifications.run(id, notifications.getSnapshot().visible[0].actions![0])
    expect(messages(notifications)).toEqual([])
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
    notifications.dispose()
    expect(notifications.notify({ severity: 'info', message: 'After.' })).toBe(0)
  })
})

describe('toast stack', () => {
  const noop = { dismiss: () => {}, run: () => {}, hold: () => {} }
  it('draws each toast with its glyph, a word for its severity, its actions and a close button, and live regions', () => {
    const { notifications } = service()
    notifications.notify({ severity: 'info', message: 'Saved 400 rows to w1.csv.', actions: [{ label: 'Show results', run: () => {} }] })
    notifications.notify({ severity: 'error', message: 'The package failed.', report: { code: 'SQL_ERROR', details: { number: 50000 } } })
    // Each toast is described by its sentence, which Focus Notifications then reads along with the severity.
    const ids = (html: string) => [...html.matchAll(/ (?:id|aria-describedby)="([^"]+)"/g)].map(match => match[1])
    const described = renderToStaticMarkup(createElement(Toasts, { snapshot: notifications.getSnapshot(), notifications: noop }))
    const [first, firstMessage, second, secondMessage] = ids(described)
    expect([first === firstMessage, second === secondMessage, first !== second]).toEqual([true, true, true])
    const markup = described.replaceAll(first, 'm1').replaceAll(second, 'm2')
    expect(markup).toContain('<section class="toast-stack" aria-label="Notifications">')
    expect(markup).toContain('<div class="toast" data-severity="info" role="group" aria-label="Information" aria-describedby="m1" tabindex="-1"><span class="toast-icon codicon codicon-info" aria-hidden="true"></span>'
      + '<div class="toast-body"><p id="m1" class="toast-message">Saved 400 rows to w1.csv.</p><div class="toast-actions"><button type="button">Show results</button></div></div>'
      + '<button type="button" class="icon-button toast-close" aria-label="Dismiss notification" title="Dismiss (Escape)"><span class="codicon codicon-close" aria-hidden="true"></span></button></div>')
    // An error with a report offers Copy details, whose outcome is a status of its own.
    expect(markup).toContain('aria-label="Error" aria-describedby="m2" tabindex="-1"><span class="toast-icon codicon codicon-error" aria-hidden="true"></span><div class="toast-body"><p id="m2" class="toast-message">The package failed.</p>'
      + '<div class="toast-actions"><button type="button">Copy details</button><span class="toast-status" role="status"></span></div>')
    expect(markup).toContain('<div class="visually-hidden" role="status"></div><div class="visually-hidden" role="alert"><span>The package failed.</span></div>')
  })
  it('counts the toasts waiting, and keeps the live regions, empty, when nothing shows', () => {
    const { notifications } = service()
    for (let index = 0; index < 5; index++) notifications.notify({ severity: 'warning', message: `W${index}.` })
    const markup = renderToStaticMarkup(createElement(Toasts, { snapshot: notifications.getSnapshot(), notifications: noop }))
    expect(markup).toContain('<p class="toast-more">2 more notifications</p>')
    expect(markup).toContain('<div class="visually-hidden" role="status"><span>W4.</span></div>')
    notifications.clear()
    expect(renderToStaticMarkup(createElement(Toasts, { snapshot: notifications.getSnapshot(), notifications: noop })))
      .toBe('<div class="toast-layer"><div class="visually-hidden" role="status"></div><div class="visually-hidden" role="alert"></div></div>')
  })
})

describe('notifications in the workbench', () => {
  const fixtures: ReturnType<typeof workbenchFixture>[] = []
  afterEach(() => { fixtures.splice(0).forEach(fixture => fixture.dispose()) })
  it('shows a toast for a save that ends while its query is not the active document, and none for the active one', async () => {
    const fixture = workbenchFixture()
    fixtures.push(fixture)
    const { documents, events, notifications, commands, host, panes } = fixture
    panes.set({ explorer: true, editor: true, output: true })
    documents.newQuery()
    const first = documents.getSnapshot().activeId
    expect(commands.isEnabled('notifications.clearAll')).toBe(false)
    events.emit({ type: 'results.saved', tabId: first, text: 'Saved 5 rows to a.csv.' })
    expect(notifications.getSnapshot().visible).toEqual([])
    documents.newQuery()
    events.emit({ type: 'results.saved', tabId: first, text: 'Saved 6 rows to a.csv.' })
    const [toast] = notifications.getSnapshot().visible
    expect(toast).toMatchObject({ severity: 'info', message: 'Saved 6 rows to a.csv.', actions: [{ label: 'Show results' }] })
    expect(commands.isEnabled('notifications.clearAll') && commands.isEnabled('notifications.focus')).toBe(true)
    // Show results: back to that query, with the output pane shown.
    notifications.run(toast.id, toast.actions![0])
    await vi.waitFor(() => expect(host.reveal).toHaveBeenCalledWith('output'))
    expect(documents.getSnapshot().activeId).toBe(first)
    expect(notifications.getSnapshot().visible).toEqual([])
  })
  it('shows a toast for a save that ends on the active query while its results pane is hidden', () => {
    const fixture = workbenchFixture()
    fixtures.push(fixture)
    const { documents, events, notifications, panes } = fixture
    documents.newQuery()
    const tab = documents.getSnapshot().activeId
    // Ctrl+R hid the results while the save wrote: the toolbar notice it would get is out of sight.
    panes.set({ explorer: true, editor: true, output: false })
    events.emit({ type: 'results.saved', tabId: tab, text: 'Saved 5 rows to a.csv.' })
    expect(notifications.getSnapshot().visible).toMatchObject([{ message: 'Saved 5 rows to a.csv.', actions: [{ label: 'Show results' }] }])
    notifications.clear()
    panes.set({ explorer: true, editor: true, output: true })
    events.emit({ type: 'results.saved', tabId: tab, text: 'Saved 6 rows to a.csv.' })
    expect(notifications.getSnapshot().visible).toEqual([])
  })
  it('takes Show results off a toast once its query closes, so it never reveals another query\'s output', async () => {
    const fixture = workbenchFixture()
    fixtures.push(fixture)
    const { documents, events, notifications } = fixture
    documents.newQuery()
    const first = documents.getSnapshot().activeId
    documents.newQuery()
    const second = documents.getSnapshot().activeId
    events.emit({ type: 'results.saved', tabId: first, text: 'Saved 6 rows to a.csv.' })
    const [toast] = notifications.getSnapshot().visible
    expect(toast.actions?.map(action => action.label)).toEqual(['Show results'])
    const announced = notifications.getSnapshot().announcement
    await documents.close(first)
    // The same toast, read once already, now with nothing to click; it leaves by itself as plain information does.
    expect(notifications.getSnapshot().visible).toMatchObject([{ id: toast.id, message: 'Saved 6 rows to a.csv.', actions: [] }])
    expect(notifications.getSnapshot().announcement).toBe(announced)
    expect(autoHides(notifications.getSnapshot().visible[0])).toBe(true)
    expect(documents.getSnapshot().activeId).toBe(second)
  })
  it('says a save ended for a closed query too, with nothing to show, and Clear All empties the stack', async () => {
    const fixture = workbenchFixture()
    fixtures.push(fixture)
    const { events, notifications, commands } = fixture
    // Enablement follows the toasts alone: nothing else changes between these checks.
    expect(commands.isEnabled('notifications.clearAll')).toBe(false)
    events.emit({ type: 'results.saved', tabId: 'closed-tab', text: 'Saved 7 rows to b.csv.' })
    expect(commands.isEnabled('notifications.clearAll')).toBe(true)
    expect(notifications.getSnapshot().visible).toMatchObject([{ message: 'Saved 7 rows to b.csv.', actions: [] }])
    expect(await commands.execute('notifications.clearAll', undefined, 'palette')).toBe(true)
    expect(notifications.getSnapshot().visible).toEqual([])
  })
  it('sets hasNotifications only while a toast is there', () => {
    const fixture = workbenchFixture()
    fixtures.push(fixture)
    const keys = computeContextKeys({ platform: 'win32', documents: fixture.documents.getSnapshot(), queries: {}, connections: [], quickInputVisible: false, wordWrap: false, backendStatus: 'ready', notifications: true })
    expect(keys.hasNotifications).toBe(true)
    expect(fixture.context.getState().hasNotifications).toBe(false)
  })
})

describe('Connect fixes', () => {
  it('show Error details only with SQL Server\'s facts, never an empty expander for a BACKEND_ERROR', () => {
    expect(renderToStaticMarkup(createElement(FailureDetails, { details: { exception: 'System.DllNotFoundException (0x80131524)' } }))).toBe('')
    expect(renderToStaticMarkup(createElement(FailureDetails, { details: { number: 18456, server: '' } })))
      .toBe('<details class="connect-error-details"><summary>Error details</summary><dl><div><dt>Error number</dt><dd>18456</dd></div></dl></details>')
  })
  const certificate = { number: -2146893019, class: 20, reason: 'certificate' as const }
  it('offer to trust an untrusted certificate, explain Strict and a pinned certificate or name, and offer nothing else', () => {
    expect(connectFix({ encrypt: 'mandatory', trustServerCertificate: false }, certificate)).toBe('trust')
    expect(connectFix({ trustServerCertificate: false }, certificate)).toBe('trust')
    expect(connectFix({ encrypt: 'strict', trustServerCertificate: true }, certificate)).toBe('strict')
    // Already trusted (a certificate Varia cannot read, say): nothing more to offer.
    expect(connectFix({ encrypt: 'optional', trustServerCertificate: true }, certificate)).toBeUndefined()
    expect(connectFix({ encrypt: 'mandatory', trustServerCertificate: false }, { number: 18456, class: 14 })).toBeUndefined()
    // A pinned certificate or host name is a check the person set up: trusting would skip it, so the dialog only explains.
    expect(connectFix({ encrypt: 'mandatory', trustServerCertificate: false, hostNameInCertificate: 'sql01.contoso.com' }, certificate)).toBe('pinned')
    expect(connectFix({ encrypt: 'optional', trustServerCertificate: false, advanced: { ...advancedDefaults, serverCertificate: '/etc/ssl/sql01.cer' } }, certificate)).toBe('pinned')
    expect(connectFix({ encrypt: 'mandatory', trustServerCertificate: false, hostNameInCertificate: ' ', advanced: advancedDefaults }, certificate)).toBe('trust')
    expect(connectFix({ encrypt: 'strict', trustServerCertificate: false, hostNameInCertificate: 'sql01.contoso.com' }, certificate)).toBe('strict')
    expect(connectFix({ encrypt: 'mandatory', trustServerCertificate: false }, undefined)).toBeUndefined()
  })
})
