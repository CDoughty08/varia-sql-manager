/**
 * Playwright 1.63 race: when a suite crashes the renderer on purpose, Playwright drops the page session's callbacks, and
 * Chromium's late reply to a command that was in flight ("Target crashed", not the -32001 it tolerates) fails
 * CRSession._onMessage's assert(!object.id). CRConnection._onMessage is async, so that becomes an unhandled rejection,
 * which Node (--unhandled-rejections=throw, its default) raises as an uncaught exception that ends the whole suite,
 * although the reply belongs to a page that is already gone. Seen on Windows smoke runs (hot exit, menus). A suite that
 * adds its own unhandledRejection listener would take these first.
 */
export function isCrashedTargetReply(error) {
  return error instanceof Error && error.message === 'Target crashed' && /CRSession\._onMessage\b/.test(error.stack ?? '')
}

/** Ignores only that late reply; every other uncaught exception still prints and exits 1, as Node does by default. */
export function ignoreCrashedTargetReplies(target = process) {
  target.on('uncaughtException', error => {
    if (isCrashedTargetReply(error)) { console.warn("Ignored Playwright's late reply from a crashed renderer (CRSession assertion)."); return }
    console.error(error)
    target.exit(1)
  })
}
