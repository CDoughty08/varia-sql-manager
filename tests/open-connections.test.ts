import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { confirmOpenConnectionsSchema, openConnectionsAnswer, openConnectionsBox } from '../src/main/open-connections'

describe('Open Connections prompt', () => {
  it('asks SSMS\'s question with No as the default and the answer to Escape', () => {
    const signal = new AbortController().signal
    expect(openConnectionsBox(signal)).toEqual({
      type: 'question', title: 'Open Connections', noLink: true, signal, buttons: ['Yes', 'No'], defaultId: 1, cancelId: 1,
      message: 'To change the database properties, SQL Server must close all other connections to the database. Are you sure you want to change the properties and close all other connections?'
    })
    expect([0, 1, 2, -1].map(openConnectionsAnswer)).toEqual([true, false, false, false])
  })
  it('takes no payload, runs only for a trusted sender, and answers No when the page goes away', () => {
    expect(confirmOpenConnectionsSchema.safeParse(undefined).success).toBe(true)
    for (const value of [null, {}, 'Yes', 0, true]) expect(confirmOpenConnectionsSchema.safeParse(value).success, JSON.stringify(value)).toBe(false)
    const main = readFileSync('src/main/index.ts', 'utf8')
    const handler = main.slice(main.indexOf("handle('varia:confirm-open-connections'"), main.indexOf("ipcMain.handle('varia:close-window'"))
    // handle() checks trusted(event) before the action runs; the box is the page's (pageDialog), abortable, and a reload answers No (1).
    expect(handler).toContain('confirmOpenConnectionsSchema.parse(value)')
    expect(handler).toContain('pageDialog((window, signal) => dialog.showMessageBox(window, openConnectionsBox(signal)), { response: 1, checkboxChecked: false }, true)')
    expect(handler).toContain('return openConnectionsAnswer(response)')
    expect(main.match(/varia:confirm-open-connections/g)).toHaveLength(1)
    expect(readFileSync('src/preload/index.ts', 'utf8')).toContain("confirmOpenConnections: () => ipcRenderer.invoke('varia:confirm-open-connections'),")
  })
})
