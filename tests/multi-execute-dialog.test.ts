// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import type { ApiResult } from '../src/shared/contracts'
import type { BigQueryDryRunResult } from '../src/shared/bigquery/dry-run'
import BigQueryCostPrompt from '../src/renderer/src/BigQueryCostPrompt'
import { CommandService } from '../src/renderer/src/core/commands'
import { modalOpen } from '../src/renderer/src/core/modal'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import MultiExecuteDialog, {
  MultiExecuteDialogModal,
  multiExecuteSubmitLabel,
  transactionDisableReason
} from '../src/renderer/src/dialogs/MultiExecuteDialog'
import { classifyStatements } from '../src/shared/multi-query'
import { CostPromptService, multiCostPromptText } from '../src/renderer/src/services/bigquery-cost-prompt'
import {
  MultiExecutePromptService,
  type BigQueryDryRunEstimator,
  type MultiExecuteChoice,
  type MultiExecuteDialogRequest,
  type MultiExecuteTargetItem
} from '../src/renderer/src/services/multi-execute'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const GiB = 2 ** 30
const cleanups: (() => void)[] = []

afterEach(() => {
  cleanups.splice(0).reverse().forEach(fn => fn())
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

const flush = async () => {
  await act(async () => {
    await new Promise(resolve => { setTimeout(resolve, 0) })
  })
}

const sqlTarget = (index: number, extra: Partial<MultiExecuteTargetItem> = {}): MultiExecuteTargetItem => ({
  targetKey: `sql-${index}`,
  connectionId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  provider: 'sqlserver',
  label: `sql-srv-0${index}`,
  database: 'Sales',
  ...extra
})

const bqTarget = (index: number, extra: Partial<MultiExecuteTargetItem> = {}): MultiExecuteTargetItem => ({
  targetKey: `bq-${index}`,
  connectionId: `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`,
  provider: 'bigquery',
  label: `analytics-proj-${index}`,
  dataset: 'core',
  costPrompt: true,
  costThresholdBytes: 10 * GiB,
  ...extra
})

async function mountDialog(
  request: MultiExecuteDialogRequest,
  options: { estimateBigQuery?: BigQueryDryRunEstimator } = {}
) {
  const onConfirm = vi.fn<(choice: MultiExecuteChoice) => void>()
  const onCancel = vi.fn<() => void>()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(MultiExecuteDialogModal, {
      request,
      onConfirm,
      onCancel,
      ...options.estimateBigQuery ? { estimateBigQuery: options.estimateBigQuery } : {}
    }))
  })
  const unmount = () => {
    act(() => root.unmount())
    host.remove()
  }
  cleanups.push(unmount)
  const form = () => document.body.querySelector<HTMLFormElement>('form.multi-execute-dialog')!
  const radio = (value: 'transaction' | 'fireAndForget') =>
    form().querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!
  const checkbox = (labelSubstring: string) =>
    [...form().querySelectorAll('label.checkbox-label')]
      .find(label => label.textContent?.includes(labelSubstring))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  const button = (text: string) =>
    [...form().querySelectorAll('button')].find(btn => btn.textContent?.trim() === text || btn.getAttribute('aria-label') === text)
  return { form, radio, checkbox, button, onConfirm, onCancel, unmount }
}

describe('MultiExecuteDialog', () => {
  it('formats submit button labels with execution scope, engine noun, and PROD count', () => {
    expect(multiExecuteSubmitLabel('transaction', 'sqlserver', 3, 1)).toBe('Run Transaction on 3 Servers (1 PROD)')
    expect(multiExecuteSubmitLabel('fireAndForget', 'sqlserver', 3, 0)).toBe('Run on 3 Servers')
    expect(multiExecuteSubmitLabel('transaction', 'bigquery', 2, 2)).toBe('Run Transaction on 2 Projects (2 PROD)')
    expect(multiExecuteSubmitLabel('fireAndForget', 'bigquery', 2, 0)).toBe('Run on 2 Projects')
  })

  it('shows first 6 target chips with PROD/STAGING badges and expandable "+N more" toggle up to 32 targets', async () => {
    const targets = Array.from({ length: 10 }, (_, index) =>
      sqlTarget(index + 1, {
        environment: index === 0 ? 'Production' : index === 1 ? 'Staging' : undefined,
        color: index === 0 ? '#e5484d' : undefined
      })
    )
    const { form, button } = await mountDialog({
      tabId: 'tab-1',
      provider: 'sqlserver',
      sql: 'SELECT 1',
      targets,
      prices: true
    })

    expect(form().getAttribute('role')).toBe('dialog')
    expect(form().getAttribute('aria-modal')).toBe('true')
    expect(form().querySelector('.connection-scroll')).not.toBeNull()
    expect(form().querySelector('.dialog-footer')).not.toBeNull()
    expect(form().querySelectorAll('.multi-exec-target-chip')).toHaveLength(6)
    expect(form().textContent).toContain('PROD')
    expect(form().textContent).toContain('STAGING')
    expect(form().textContent).toContain('Includes PROD')

    const more = button('+4 more')!
    expect(more).toBeDefined()
    expect(more.getAttribute('type')).toBe('button')
    expect(more.getAttribute('aria-expanded')).toBe('false')

    await act(async () => { more.click() })
    expect(form().querySelectorAll('.multi-exec-target-chip')).toHaveLength(10)
    const fewer = button('Show fewer')!
    expect(fewer.getAttribute('aria-expanded')).toBe('true')

    await act(async () => { fewer.click() })
    expect(form().querySelectorAll('.multi-exec-target-chip')).toHaveLength(6)
  })

  it('defaults SQL Server mutations to Coordinated Transaction, places initial focus on the active radio, and blocks stray Enter on PROD mutations', async () => {
    const trigger = document.body.appendChild(document.createElement('button'))
    trigger.focus()

    const { form, radio, button, onConfirm, onCancel, unmount } = await mountDialog({
      tabId: 'tab-2',
      provider: 'sqlserver',
      sql: 'ALTER TABLE dbo.Orders ADD Flag bit;\nGO\nUPDATE dbo.Orders SET Flag = 1;\nSELECT COUNT(*) FROM dbo.Orders;',
      targets: [
        sqlTarget(1, { environment: 'Production' }),
        sqlTarget(2, { environment: 'Staging' }),
        sqlTarget(3)
      ],
      prices: true
    })

    expect(form().textContent).toContain('2 batches')
    expect(form().textContent).toContain('DDL')
    expect(form().textContent).toContain('DML')
    expect(form().textContent).toContain('SELECT')

    // Active radio card receives initial focus (NOT the submit button).
    expect(radio('transaction').checked).toBe(true)
    expect(radio('transaction').disabled).toBe(false)
    expect(document.activeElement).toBe(radio('transaction'))

    const submit = form().querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submit.textContent?.trim()).toBe('Run Transaction on 3 Servers (1 PROD)')
    expect(document.activeElement).not.toBe(submit)
    expect(button('Cancel')?.getAttribute('type')).toBe('button')

    // Keyboard safety: stray Enter on the radio input must NOT submit when PROD + mutation is present.
    let enterEvent!: KeyboardEvent
    await act(async () => {
      enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      radio('transaction').dispatchEvent(enterEvent)
    })
    expect(enterEvent.defaultPrevented).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()

    // Explicit submit clicks confirm Transaction mode with sequential/stopOnError false.
    await act(async () => { submit.click() })
    expect(onConfirm).toHaveBeenCalledWith({
      mode: 'transaction',
      sequential: false,
      preflightDryRun: false,
      stopOnError: false,
      autoCombine: true
    })

    // Escape closes and unmount restores focus to trigger.
    await act(async () => {
      form().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)

    unmount()
    expect(document.activeElement).toBe(trigger)
  })

  it('disables Coordinated Transaction on SQL Server non-transactional DDL and exposes Fire and Forget checkboxes', async () => {
    const { form, radio, checkbox, onConfirm } = await mountDialog({
      tabId: 'tab-3',
      provider: 'sqlserver',
      sql: 'BACKUP DATABASE Sales TO DISK = \'NUL\';',
      targets: [sqlTarget(1), sqlTarget(2)],
      prices: true,
      defaultStopOnError: true
    })

    expect(radio('transaction').disabled).toBe(true)
    expect(radio('fireAndForget').checked).toBe(true)
    expect(document.activeElement).toBe(radio('fireAndForget'))
    expect(form().querySelector('.multi-exec-banner')?.textContent).toContain('Line 1: BACKUP')

    const seq = checkbox('Sequential rollout')!
    const stop = checkbox('Stop on first batch error per server')!
    expect(seq.checked).toBe(false)
    expect(stop.checked).toBe(true)

    await act(async () => { seq.click() })
    expect(seq.checked).toBe(true)

    await act(async () => { form().querySelector<HTMLButtonElement>('button[type="submit"]')!.click() })
    expect(onConfirm).toHaveBeenCalledWith({
      mode: 'fireAndForget',
      sequential: true,
      preflightDryRun: false,
      stopOnError: true,
      autoCombine: true
    })
  })

  it('disables Coordinated Transaction on BigQuery permanent DDL and pre-checks Pre-flight Dry Run + Sequential rollout', async () => {
    const estimator = vi.fn<BigQueryDryRunEstimator>(async () => ({ ok: true, value: { bytesProcessed: 2 * GiB } }))
    const { form, radio, checkbox, onConfirm } = await mountDialog({
      tabId: 'tab-4',
      provider: 'bigquery',
      sql: 'CREATE OR REPLACE VIEW core.v_orders AS SELECT 1 AS id;',
      targets: [bqTarget(1), bqTarget(2)],
      prices: true
    }, { estimateBigQuery: estimator })

    await flush()

    expect(radio('transaction').disabled).toBe(true)
    expect(radio('fireAndForget').checked).toBe(true)
    expect(form().querySelector('.multi-exec-banner')?.textContent).toContain('permanent BigQuery DDL')
    expect(form().querySelector('.multi-exec-banner')?.textContent).toContain('Line 1: CREATE')

    expect(checkbox('Pre-flight Dry Run (free)')?.checked).toBe(true)
    expect(checkbox('Sequential rollout')?.checked).toBe(true)
    expect(checkbox('Stop on first batch error')).toBeUndefined()

    await act(async () => { form().querySelector<HTMLButtonElement>('button[type="submit"]')!.click() })
    expect(onConfirm).toHaveBeenCalledWith({
      mode: 'fireAndForget',
      sequential: true,
      preflightDryRun: true,
      stopOnError: false,
      autoCombine: true
    })
  })

  it('disables Coordinated Transaction on BigQuery transaction-blocking statements and emulator mode', async () => {
    const estimator = vi.fn<BigQueryDryRunEstimator>(async () => ({ ok: true, value: { bytesProcessed: 0, faked: true } }))

    const exportMount = await mountDialog({
      tabId: 'tab-5',
      provider: 'bigquery',
      sql: 'EXPORT DATA OPTIONS(uri=\'gs://bucket/*.parquet\', format=\'PARQUET\') AS SELECT 1;',
      targets: [bqTarget(1), bqTarget(2)],
      prices: true
    }, { estimateBigQuery: vi.fn<BigQueryDryRunEstimator>(async () => ({ ok: true, value: { bytesProcessed: 1024 } })) })
    await flush()
    expect(exportMount.radio('transaction').disabled).toBe(true)
    expect(exportMount.radio('fireAndForget').checked).toBe(true)
    expect(exportMount.form().querySelector('.multi-exec-banner')?.textContent).toContain('EXPORT')
    exportMount.unmount()

    // Dynamic emulator detection via dry-run `faked: true` disables transaction even for DML,
    // moves focus from the now-disabled transaction radio to Fire and Forget, and disables Pre-flight Dry Run.
    const emuMount = await mountDialog({
      tabId: 'tab-6',
      provider: 'bigquery',
      sql: 'UPDATE core.orders SET active = true WHERE id = 1;',
      targets: [bqTarget(1), bqTarget(2)],
      prices: true
    }, { estimateBigQuery: estimator })
    await flush()
    expect(emuMount.radio('transaction').disabled).toBe(true)
    expect(emuMount.radio('fireAndForget').checked).toBe(true)
    expect(document.activeElement).toBe(emuMount.radio('fireAndForget'))
    expect(emuMount.checkbox('Pre-flight Dry Run (free)')?.disabled).toBe(true)
    expect(emuMount.checkbox('Pre-flight Dry Run (free)')?.checked).toBe(false)
    expect(emuMount.form().querySelector('.multi-exec-banner')?.textContent).toContain('emulator')
    expect(emuMount.form().textContent).toContain('Emulator (0 B)')

    // Escape still works after focus moves onto the Fire and Forget radio.
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(emuMount.onCancel).toHaveBeenCalledTimes(1)
    emuMount.unmount()

    // Dynamic emulator detection during SELECT (already in fireAndForget mode) still unchecks/disables Pre-flight Dry Run.
    const selectDryRun = deferred<ApiResult<BigQueryDryRunResult>>()
    const selectMount = await mountDialog({
      tabId: 'tab-6b',
      provider: 'bigquery',
      sql: 'SELECT 1;',
      targets: [bqTarget(1), bqTarget(2)],
      prices: true
    }, { estimateBigQuery: vi.fn<BigQueryDryRunEstimator>(() => selectDryRun.promise) })
    expect(selectMount.radio('fireAndForget').checked).toBe(true)
    expect(selectMount.checkbox('Pre-flight Dry Run (free)')?.checked).toBe(true)
    expect(selectMount.checkbox('Pre-flight Dry Run (free)')?.disabled).toBe(false)
    await act(async () => {
      selectDryRun.resolve({ ok: true, value: { bytesProcessed: 0, faked: true } })
      await Promise.resolve()
    })
    await flush()
    expect(selectMount.checkbox('Pre-flight Dry Run (free)')?.disabled).toBe(true)
    expect(selectMount.checkbox('Pre-flight Dry Run (free)')?.checked).toBe(false)
    await act(async () => { selectMount.form().querySelector<HTMLButtonElement>('button[type="submit"]')!.click() })
    expect(selectMount.onConfirm).toHaveBeenCalledWith({
      mode: 'fireAndForget',
      sequential: false,
      preflightDryRun: false,
      stopOnError: false,
      autoCombine: true
    })
    selectMount.unmount()

    // Static emulator target metadata starts with Pre-flight Dry Run disabled and unchecked.
    const staticEmuMount = await mountDialog({
      tabId: 'tab-6c',
      provider: 'bigquery',
      sql: 'SELECT 1;',
      targets: [bqTarget(1, { emulator: true }), bqTarget(2)],
      prices: true
    }, { estimateBigQuery: estimator })
    await flush()
    expect(staticEmuMount.checkbox('Pre-flight Dry Run (free)')?.disabled).toBe(true)
    expect(staticEmuMount.checkbox('Pre-flight Dry Run (free)')?.checked).toBe(false)
    await act(async () => { staticEmuMount.form().querySelector<HTMLButtonElement>('button[type="submit"]')!.click() })
    expect(staticEmuMount.onConfirm).toHaveBeenCalledWith({
      mode: 'fireAndForget',
      sequential: false,
      preflightDryRun: false,
      stopOnError: false,
      autoCombine: true
    })
  })

  it('blocks stray Enter on cross-window INPUT elements when PROD + mutation is present', async () => {
    const { radio, onConfirm } = await mountDialog({
      tabId: 'tab-cross-win',
      provider: 'sqlserver',
      sql: 'DELETE FROM dbo.Orders WHERE Id = 1;',
      targets: [sqlTarget(1, { environment: 'Production' }), sqlTarget(2)],
      prices: true
    })

    // Simulate a popout/dialog window realm where event.target is NOT instanceof the main window's HTMLElement.
    const OriginalHTMLElement = globalThis.HTMLElement
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    try {
      vi.stubGlobal('HTMLElement', class OtherWindowHTMLElement {})
      expect(radio('transaction') instanceof globalThis.HTMLElement).toBe(false)
      await act(async () => {
        radio('transaction').dispatchEvent(enterEvent)
      })
    } finally {
      vi.stubGlobal('HTMLElement', OriginalHTMLElement)
    }
    expect(enterEvent.defaultPrevented).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('runs free per-target BigQuery dry runs inline (omitting sessionId), respects per-connection cost settings, and cancels on unmount', async () => {
    const p1 = deferred<ApiResult<BigQueryDryRunResult>>()
    const p2 = deferred<ApiResult<BigQueryDryRunResult>>()
    const p3 = deferred<ApiResult<BigQueryDryRunResult>>()
    const calls: Parameters<BigQueryDryRunEstimator>[0][] = []
    const estimator = vi.fn<BigQueryDryRunEstimator>(async req => {
      calls.push(req)
      if (req.connectionId === bqTarget(1).connectionId) return p1.promise
      if (req.connectionId === bqTarget(2).connectionId) return p2.promise
      return p3.promise
    })

    const { form, unmount } = await mountDialog({
      tabId: 'tab-7',
      provider: 'bigquery',
      sql: 'UPDATE core.orders SET total = total + 1 WHERE id > 0;',
      targets: [
        bqTarget(1, { environment: 'Production', costPrompt: true, costThresholdBytes: 5 * GiB, ownCostThreshold: true, maximumBytesBilled: 10 * GiB }),
        bqTarget(2, { costPrompt: false, costThresholdBytes: 5 * GiB }),
        bqTarget(3, { costPrompt: true, costThresholdBytes: 50 * GiB })
      ],
      prices: true
    }, { estimateBigQuery: estimator })

    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect('sessionId' in call).toBe(false)
      expect(call.dataset).toBe('core')
    }
    expect(form().textContent).toContain('Estimating 0 of 3 projects')

    // Target 1 exceeds BOTH its connection threshold (5 GiB) and maximumBytesBilled (10 GiB).
    // Target 2 exceeds 5 GiB, but has costPrompt: false -> must NOT show threshold warning!
    // Target 3 returns an incomplete estimate warning.
    await act(async () => {
      p1.resolve({ ok: true, value: { bytesProcessed: 12 * GiB } })
      p2.resolve({ ok: true, value: { bytesProcessed: 8 * GiB } })
      p3.resolve({ ok: true, value: { bytesProcessed: 1 * GiB, incomplete: 'lowerBound' } })
      await Promise.resolve()
    })
    await flush()

    const rows = [...form().querySelectorAll('.multi-exec-cost-row')]
    expect(rows).toHaveLength(3)
    expect(rows[0]!.textContent).toContain('12.00 GiB')
    expect(rows[0]!.textContent).toContain('Exceeds maximum bytes billed (10.00 GiB)')
    expect(rows[0]!.textContent).toContain('Exceeds connection threshold (5.00 GiB)')
    expect(rows[1]!.textContent).toContain('8.00 GiB')
    expect(rows[1]!.textContent).not.toContain('Exceeds')
    expect(rows[2]!.textContent).toContain('lower bound')
    expect(form().querySelector('.multi-exec-cost-summary')?.textContent).toContain('Total: 21.00 GiB')
    expect(form().querySelector('.multi-exec-cost-summary')?.textContent).toContain('on demand')

    // Verify cancellation on unmount while dry runs are in flight.
    unmount()
    const pendingDryRun = deferred<ApiResult<BigQueryDryRunResult>>()
    const slowEstimator = vi.fn<BigQueryDryRunEstimator>(() => pendingDryRun.promise)
    const second = await mountDialog({
      tabId: 'tab-8',
      provider: 'bigquery',
      sql: 'SELECT 1',
      targets: Array.from({ length: 8 }, (_, index) => bqTarget(index + 1)),
      prices: false
    }, { estimateBigQuery: slowEstimator })
    // Bounded concurrency pool starts at most 4 in-flight at once; unmounting aborts remaining 4.
    expect(slowEstimator).toHaveBeenCalledTimes(4)
    second.unmount()
    pendingDryRun.resolve({ ok: true, value: { bytesProcessed: 100 } })
    await flush()
    expect(slowEstimator).toHaveBeenCalledTimes(4)
  })

  it('keeps submit enabled when a BigQuery dry run fails and renders 32 targets cleanly with "+26 more"', async () => {
    const targets = Array.from({ length: 32 }, (_, index) => bqTarget(index + 1))
    const estimator = vi.fn<BigQueryDryRunEstimator>(async () => ({ ok: false, error: 'Table not found: analytics.missing', code: 'SQL_ERROR' }))
    const { form, button, onConfirm } = await mountDialog({
      tabId: 'tab-32',
      provider: 'bigquery',
      sql: 'SELECT * FROM analytics.missing',
      targets,
      prices: true
    }, { estimateBigQuery: estimator })

    await flush()
    expect(form().querySelectorAll('.multi-exec-target-chip')).toHaveLength(6)
    expect(button('+26 more')).toBeDefined()
    expect(form().textContent).toContain('Table not found: analytics.missing')

    await act(async () => { form().querySelector<HTMLButtonElement>('button[type="submit"]')!.click() })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('queues prompts cleanly in MultiExecutePromptService and connects through MultiExecuteDialog', async () => {
    const service = new MultiExecutePromptService()
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(MultiExecuteDialog, { service }))
    })
    cleanups.push(() => { act(() => root.unmount()); host.remove(); service.dispose() })

    let first!: Promise<MultiExecuteChoice | undefined>
    let second!: Promise<MultiExecuteChoice | undefined>
    await act(async () => {
      first = service.ask({ tabId: 'a', provider: 'sqlserver', sql: 'SELECT 1', targets: [sqlTarget(1), sqlTarget(2)], prices: true })
      second = service.ask({ tabId: 'b', provider: 'sqlserver', sql: 'DELETE FROM dbo.T', targets: [sqlTarget(1), sqlTarget(2)], prices: true })
    })

    expect(service.getSnapshot().pending?.request.tabId).toBe('a')
    const firstId = service.getSnapshot().pending!.id

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
    })
    await expect(first).resolves.toMatchObject({ mode: 'fireAndForget' })
    await flush()

    // Stale answer for firstId must not answer second prompt.
    expect(service.answer(firstId, { mode: 'fireAndForget', sequential: false, preflightDryRun: false, stopOnError: false, autoCombine: true })).toBe(false)
    expect(service.getSnapshot().pending?.request.tabId).toBe('b')

    await act(async () => {
      const cancelBtn = [...document.body.querySelectorAll('button')].find(btn => btn.textContent?.trim() === 'Cancel')!
      cancelBtn.click()
    })
    await expect(second).resolves.toBeUndefined()
    expect(service.getSnapshot().pending).toBeUndefined()
  })

  it('R2 Finding 11: disables submit and blocks stray Enter while BigQuery dry runs are estimating or when cost warnings are present', async () => {
    const p1 = deferred<ApiResult<BigQueryDryRunResult>>()
    const p2 = deferred<ApiResult<BigQueryDryRunResult>>()
    const estimator = vi.fn<BigQueryDryRunEstimator>(req => req.connectionId === bqTarget(1).connectionId ? p1.promise : p2.promise)

    // SELECT query on non-PROD BigQuery projects (so hasProd && isMutation is false!).
    const { form, radio, onConfirm } = await mountDialog({
      tabId: 'tab-cost-guard',
      provider: 'bigquery',
      sql: 'SELECT * FROM core.events;',
      targets: [
        bqTarget(1, { costPrompt: true, costThresholdBytes: 5 * GiB }),
        bqTarget(2, { costPrompt: true, costThresholdBytes: 5 * GiB })
      ],
      prices: true
    }, { estimateBigQuery: estimator })

    const submit = form().querySelector<HTMLButtonElement>('button[type="submit"]')!
    // 1. While dry runs are estimating, submit is disabled and programmatic submit / Enter do nothing.
    expect(submit.disabled).toBe(true)
    const enterWhileEstimating = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => {
      radio('fireAndForget').dispatchEvent(enterWhileEstimating)
      form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(enterWhileEstimating.defaultPrevented).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()

    // 2. Resolve dry runs with target 1 exceeding its cost threshold -> submit enables, but stray Enter on radio is STILL blocked by hasCostWarning!
    await act(async () => {
      p1.resolve({ ok: true, value: { bytesProcessed: 12 * GiB } })
      p2.resolve({ ok: true, value: { bytesProcessed: 1 * GiB } })
      await Promise.resolve()
    })
    await flush()
    expect(submit.disabled).toBe(false)

    const enterWithWarning = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => {
      radio('fireAndForget').dispatchEvent(enterWithWarning)
    })
    expect(enterWithWarning.defaultPrevented).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()

    // Explicit click on submit still confirms.
    await act(async () => { submit.click() })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('R2 Finding 13: moves focus to Fire and Forget radio if Pre-flight Dry Run checkbox was focused when dynamic emulator detection disables it', async () => {
    const dryRun = deferred<ApiResult<BigQueryDryRunResult>>()
    const { radio, checkbox, onCancel } = await mountDialog({
      tabId: 'tab-emu-focus',
      provider: 'bigquery',
      sql: 'SELECT 1;',
      targets: [bqTarget(1), bqTarget(2)],
      prices: true
    }, { estimateBigQuery: vi.fn<BigQueryDryRunEstimator>(() => dryRun.promise) })

    const preflight = checkbox('Pre-flight Dry Run (free)')!
    expect(preflight.disabled).toBe(false)
    preflight.focus()
    expect(document.activeElement).toBe(preflight)

    // Dynamic emulator detection disables preflight checkbox while it holds focus.
    await act(async () => {
      dryRun.resolve({ ok: true, value: { bytesProcessed: 0, faked: true } })
      await Promise.resolve()
    })
    await flush()

    expect(preflight.disabled).toBe(true)
    expect(document.activeElement).toBe(radio('fireAndForget'))

    // Escape from the recovered focus element closes the dialog cleanly.
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('R3 Finding 7: MultiExecuteDialog preserves original returnFocus across back-to-back queued modals and restores it when queue empties or unmounts', async () => {
    const trigger = document.body.appendChild(document.createElement('button'))
    trigger.textContent = 'Run Trigger'
    trigger.focus()
    expect(document.activeElement).toBe(trigger)
    let triggerFocusCount = 0
    trigger.addEventListener('focus', () => { triggerFocusCount++ })

    const service = new MultiExecutePromptService()
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(MultiExecuteDialog, { service }))
    })
    const cleanup = () => { act(() => root.unmount()); host.remove(); service.dispose() }
    cleanups.push(cleanup)

    let first!: Promise<MultiExecuteChoice | undefined>
    let second!: Promise<MultiExecuteChoice | undefined>
    await act(async () => {
      first = service.ask({ tabId: 'q1', provider: 'sqlserver', sql: 'SELECT 1', targets: [sqlTarget(1), sqlTarget(2)], prices: true })
      second = service.ask({ tabId: 'q2', provider: 'sqlserver', sql: 'DELETE FROM dbo.T', targets: [sqlTarget(1), sqlTarget(2)], prices: true })
    })

    // Confirm first modal -> transitions directly to second modal WITHOUT returning focus to trigger in between.
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
    })
    await expect(first).resolves.toMatchObject({ mode: 'fireAndForget' })
    expect(triggerFocusCount).toBe(0)
    expect(document.activeElement).toBe(document.body.querySelector('input[type="radio"][value="transaction"]'))

    // Cancel second modal -> queue becomes empty -> focus returns to trigger (never dropped to document.body).
    await act(async () => {
      const cancelBtn = [...document.body.querySelectorAll('button')].find(btn => btn.textContent?.trim() === 'Cancel')!
      cancelBtn.click()
    })
    await expect(second).resolves.toBeUndefined()
    expect(document.activeElement).toBe(trigger)
    expect(triggerFocusCount).toBe(1)

    // Back-to-back modals followed by wrapper unmount also restores focus to trigger.
    triggerFocusCount = 0
    await act(async () => {
      void service.ask({ tabId: 'q3', provider: 'sqlserver', sql: 'SELECT 1', targets: [sqlTarget(1), sqlTarget(2)], prices: true })
      void service.ask({ tabId: 'q4', provider: 'sqlserver', sql: 'SELECT 2', targets: [sqlTarget(1), sqlTarget(2)], prices: true })
    })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
    })
    expect(triggerFocusCount).toBe(0)
    await act(async () => { root.unmount() })
    expect(document.activeElement).toBe(trigger)
  })

  it('R3 Finding 8: transactionDisableReason and MultiExecuteDialogModal offset blocker line numbers by selection startLine', async () => {
    const tsqlClass = classifyStatements('SELECT 1;\nBACKUP DATABASE Sales TO DISK = \'NUL\';', 'sqlserver')
    expect(transactionDisableReason('sqlserver', tsqlClass, false)).toContain('Line 2: BACKUP')
    expect(transactionDisableReason('sqlserver', tsqlClass, false, 10)).toContain('Line 11: BACKUP')
    expect(transactionDisableReason('sqlserver', tsqlClass, false, 1)).toContain('Line 2: BACKUP')

    const { form } = await mountDialog({
      tabId: 'tab-offset',
      provider: 'sqlserver',
      sql: 'SELECT 1;\nBACKUP DATABASE Sales TO DISK = \'NUL\';',
      startLine: 15,
      targets: [sqlTarget(1), sqlTarget(2)],
      prices: true
    })
    expect(form().querySelector('.multi-exec-banner')?.textContent).toContain('Line 16: BACKUP')
  })

  it('R4 D3 #2: tracks fakedCount separately from doneCount and renders "Emulator (estimates unavailable)" when only emulator dry runs succeed', async () => {
    // 1. All targets return faked: true -> summary shows 'Emulator (estimates unavailable)', NOT 'Total: 0 B'.
    const allFaked = await mountDialog({
      tabId: 'tab-faked-all',
      provider: 'bigquery',
      sql: 'SELECT 1;',
      targets: [bqTarget(1), bqTarget(2)],
      prices: true
    }, { estimateBigQuery: vi.fn<BigQueryDryRunEstimator>(async () => ({ ok: true, value: { bytesProcessed: 0, faked: true } })) })
    await flush()
    expect(allFaked.form().querySelector('.multi-exec-cost-summary')?.textContent).toBe('Emulator (estimates unavailable)')
    allFaked.unmount()

    // 2. 1 faked + 1 error -> still 0 real estimates and fakedCount > 0 -> 'Emulator (estimates unavailable)'.
    const fakedAndError = await mountDialog({
      tabId: 'tab-faked-err',
      provider: 'bigquery',
      sql: 'SELECT 1;',
      targets: [bqTarget(1), bqTarget(2)],
      prices: true
    }, {
      estimateBigQuery: vi.fn<BigQueryDryRunEstimator>(async req => req.connectionId === bqTarget(1).connectionId
        ? { ok: true, value: { bytesProcessed: 0, faked: true } }
        : { ok: false, error: 'Dry run failed' })
    })
    await flush()
    expect(fakedAndError.form().querySelector('.multi-exec-cost-summary')?.textContent).toBe('Emulator (estimates unavailable)')
    fakedAndError.unmount()

    // 3. All errors (doneCount === 0, fakedCount === 0) -> 'Estimates unavailable'.
    const allError = await mountDialog({
      tabId: 'tab-err-all',
      provider: 'bigquery',
      sql: 'SELECT 1;',
      targets: [bqTarget(1), bqTarget(2)],
      prices: true
    }, { estimateBigQuery: vi.fn<BigQueryDryRunEstimator>(async () => ({ ok: false, error: 'Dry run failed' })) })
    await flush()
    expect(allError.form().querySelector('.multi-exec-cost-summary')?.textContent).toBe('Estimates unavailable')
    allError.unmount()

    // 4. 1 faked + 1 real estimate -> doneCount === 1 < 2 targets -> shows qualified Total (1 of 2 estimated).
    const mixedReal = await mountDialog({
      tabId: 'tab-faked-real',
      provider: 'bigquery',
      sql: 'SELECT 1;',
      targets: [bqTarget(1), bqTarget(2)],
      prices: false
    }, {
      estimateBigQuery: vi.fn<BigQueryDryRunEstimator>(async req => req.connectionId === bqTarget(1).connectionId
        ? { ok: true, value: { bytesProcessed: 0, faked: true } }
        : { ok: true, value: { bytesProcessed: 2 * GiB } })
    })
    await flush()
    expect(mixedReal.form().querySelector('.multi-exec-cost-summary')?.textContent).toBe('Total (1 of 2 estimated): 2.00 GiB')
  })

  it('R5 D3 #1: renders multi-batch SQL Server "N batches" chip once without duplicating classification.tags', async () => {
    const { form, unmount } = await mountDialog({
      tabId: 'tab-batches-dedup',
      provider: 'sqlserver',
      sql: 'ALTER TABLE dbo.Orders ADD Flag bit;\nGO\nUPDATE dbo.Orders SET Flag = 1;',
      targets: [sqlTarget(1), sqlTarget(2)],
      prices: true
    })

    const tags = [...form().querySelectorAll('.multi-exec-stmt-tag')].map(el => el.textContent?.trim())
    expect(tags.filter(tag => tag === '2 batches')).toHaveLength(1)
    expect(tags).toEqual(['2 batches', '1 DDL (ALTER TABLE)', '1 DML (UPDATE)'])
    unmount()

    // Custom classification with batchCount > 1 not yet in tags still prepends the batch chip once.
    const customMount = await mountDialog({
      tabId: 'tab-batches-custom',
      provider: 'sqlserver',
      sql: 'UPDATE dbo.Orders SET Flag = 1;',
      classification: {
        provider: 'sqlserver',
        batchCount: 3,
        statements: [],
        hasNonTransactionalTSql: false,
        hasBigQueryPermanentDdl: false,
        blocksBigQueryTransaction: false,
        tags: ['1 DML (UPDATE)']
      },
      targets: [sqlTarget(1), sqlTarget(2)],
      prices: true
    })
    const customTags = [...customMount.form().querySelectorAll('.multi-exec-stmt-tag')].map(el => el.textContent?.trim())
    expect(customTags).toEqual(['3 batches', '1 DML (UPDATE)'])
  })

  it('R5 D3 #2: transactionDisableReason blames the permanent DDL statement when CALL precedes CREATE TABLE in BigQuery', async () => {
    const sql = 'CALL core.my_proc();\nCREATE TABLE core.t (id INT64);'
    const classification = classifyStatements(sql, 'bigquery')
    expect(classification.hasBigQueryPermanentDdl).toBe(true)
    expect(classification.firstBlockingStatement).toMatchObject({ line: 1, keyword: 'CALL', permanentDdl: false })

    const reason = transactionDisableReason('bigquery', classification, false)
    expect(reason).toContain('permanent BigQuery DDL (Line 2: CREATE TABLE)')
    expect(reason).not.toContain('Line 1: CALL')

    const offsetReason = transactionDisableReason('bigquery', classification, false, 5)
    expect(offsetReason).toContain('permanent BigQuery DDL (Line 6: CREATE TABLE)')

    const { form } = await mountDialog({
      tabId: 'tab-bq-call-create',
      provider: 'bigquery',
      sql,
      startLine: 10,
      targets: [bqTarget(1), bqTarget(2)],
      prices: true
    }, { estimateBigQuery: vi.fn<BigQueryDryRunEstimator>(async () => ({ ok: true, value: { bytesProcessed: 1024 } })) })
    await flush()
    const bannerText = form().querySelector('.multi-exec-banner')?.textContent ?? ''
    expect(bannerText).toContain('Line 11: CREATE TABLE')
    expect(bannerText).not.toContain('CALL')
  })

  it('R5 D3 #3: TargetChip resolves target.color through theme.accent when WorkbenchProvider is present and falls back outside it', async () => {
    const themeListeners = new Set<() => void>()
    let version = 0
    let accentValue = 'var(--varia-connection-red)'
    const theme = {
      subscribe: (listener: () => void) => { themeListeners.add(listener); return () => { themeListeners.delete(listener) } },
      getSnapshot: () => version,
      accent: vi.fn((color: string | undefined) => color === '#e66b73' ? accentValue : color)
    }
    const workbench = { theme } as unknown as Workbench

    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.push(() => { act(() => root.unmount()); host.remove() })
    await act(async () => {
      root.render(createElement(WorkbenchProvider, {
        workbench,
        children: createElement(MultiExecuteDialogModal, {
          request: {
            tabId: 'tab-theme-chip',
            provider: 'sqlserver',
            sql: 'SELECT 1;',
            targets: [sqlTarget(1, { color: '#e66b73' }), sqlTarget(2)],
            prices: true
          },
          onConfirm: vi.fn(),
          onCancel: vi.fn()
        })
      }))
    })

    const dot = () => document.body.querySelector<HTMLElement>('.multi-exec-target-dot')!
    expect(theme.accent).toHaveBeenCalledWith('#e66b73')
    expect(dot().style.backgroundColor).toBe('var(--varia-connection-red)')

    // Theme updates re-render TargetChip with the updated resolved color.
    accentValue = 'rgb(180, 40, 50)'
    version++
    await act(async () => { themeListeners.forEach(fn => fn()) })
    expect(dot().style.backgroundColor).toBe('rgb(180, 40, 50)')
  })

  it('R7 #2: MultiExecuteDialog defers mounting and focus capture while BigQueryCostPrompt has a pending single or multi prompt', async () => {
    const trigger = document.body.appendChild(document.createElement('button'))
    trigger.textContent = 'Run Query'
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    const costPrompts = new CostPromptService()
    const multiService = new MultiExecutePromptService()
    const workbench = { costPrompts, commands: { execute: vi.fn(async () => {}) } } as unknown as Workbench
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(WorkbenchProvider, {
        workbench,
        children: [
          createElement(BigQueryCostPrompt, { key: 'cost' }),
          createElement(MultiExecuteDialog, { key: 'multi', service: multiService })
        ]
      }))
    })
    cleanups.push(() => { act(() => root.unmount()); host.remove(); costPrompts.dispose(); multiService.dispose() })

    // 1. Single-project BigQueryCostPrompt open while MultiExecuteDialog has a pending request: MultiExecuteDialog stays unmounted.
    let singleCost!: ReturnType<CostPromptService['ask']>
    let multiPrompt!: ReturnType<MultiExecutePromptService['ask']>
    await act(async () => {
      singleCost = costPrompts.ask({
        prompt: { kind: 'threshold', bytes: 15 * GiB },
        connection: 'solo-analytics',
        thresholdBytes: 10 * GiB,
        prices: true
      })
      multiPrompt = multiService.ask({
        tabId: 'q-deferred',
        provider: 'sqlserver',
        sql: 'SELECT 1;',
        targets: [sqlTarget(1), sqlTarget(2)],
        prices: true
      })
    })
    expect(document.body.querySelector('form.bigquery-cost-prompt')).not.toBeNull()
    expect(document.body.querySelector('form.multi-execute-dialog')).toBeNull()
    const costCancel = [...document.body.querySelectorAll<HTMLButtonElement>('form.bigquery-cost-prompt button')].find(btn => btn.textContent?.trim() === 'Cancel')!
    expect(document.activeElement).toBe(costCancel)

    // Dismissing BigQueryCostPrompt lets MultiExecuteDialog mount, capture return focus, and focus its radio!
    await act(async () => { costCancel.click() })
    await expect(singleCost).resolves.toEqual({ run: false })
    const multiForm = document.body.querySelector<HTMLFormElement>('form.multi-execute-dialog')
    expect(multiForm).not.toBeNull()
    expect(document.activeElement).toBe(multiForm!.querySelector('input[type="radio"][value="fireAndForget"]'))

    // Cancelling MultiExecuteDialog restores focus cleanly back to trigger.
    const multiCancel = [...multiForm!.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent?.trim() === 'Cancel')!
    await act(async () => { multiCancel.click() })
    await expect(multiPrompt).resolves.toBeUndefined()
    expect(document.activeElement).toBe(trigger)

    // 2. Multi-project BigQueryCostPrompt (pendingMulti) also blocks MultiExecuteDialog until dismissed.
    let multiCost!: ReturnType<CostPromptService['askMulti']>
    let multiPrompt2!: ReturnType<MultiExecutePromptService['ask']>
    await act(async () => {
      multiCost = costPrompts.askMulti({
        kind: 'multi',
        prices: true,
        totalBytes: 25 * GiB,
        projects: [{ connectionId: 'c1', label: 'prod-analytics', prompt: { kind: 'threshold', bytes: 25 * GiB }, thresholdBytes: 10 * GiB }]
      })
      multiPrompt2 = multiService.ask({
        tabId: 'q-deferred-2',
        provider: 'sqlserver',
        sql: 'SELECT 2;',
        targets: [sqlTarget(1), sqlTarget(2)],
        prices: true
      })
    })
    expect(document.body.querySelector('form.bigquery-cost-prompt-multi')).not.toBeNull()
    expect(document.body.querySelector('form.multi-execute-dialog')).toBeNull()

    const multiCostCancel = [...document.body.querySelectorAll<HTMLButtonElement>('form.bigquery-cost-prompt-multi button')].find(btn => btn.textContent?.trim() === 'Cancel')!
    await act(async () => { multiCostCancel.click() })
    await expect(multiCost).resolves.toEqual({ run: false })
    expect(document.body.querySelector('form.multi-execute-dialog')).not.toBeNull()

    const multiCancel2 = [...document.body.querySelectorAll<HTMLButtonElement>('form.multi-execute-dialog button')].find(btn => btn.textContent?.trim() === 'Cancel')!
    await act(async () => { multiCancel2.click() })
    await expect(multiPrompt2).resolves.toBeUndefined()
    expect(document.activeElement).toBe(trigger)
  })

  it('R7 #3: qualifies BigQuery Total label when doneCount < targets.length and keeps unqualified Total when all targets succeed', async () => {
    // 2 of 3 estimated (1 dry-run error) with prices: true -> "Total (2 of 3 estimated): ... (about ... on demand)"
    const partialPriced = await mountDialog({
      tabId: 'tab-partial-priced',
      provider: 'bigquery',
      sql: 'SELECT 1;',
      targets: [bqTarget(1), bqTarget(2), bqTarget(3)],
      prices: true
    }, {
      estimateBigQuery: vi.fn<BigQueryDryRunEstimator>(async req => req.connectionId === bqTarget(3).connectionId
        ? { ok: false, error: 'Access denied' }
        : { ok: true, value: { bytesProcessed: 1 * GiB } })
    })
    await flush()
    const summaryPartial = partialPriced.form().querySelector('.multi-exec-cost-summary')?.textContent ?? ''
    expect(summaryPartial).toMatch(/^Total \(2 of 3 estimated\): 2\.00 GiB \(about \$/)
    partialPriced.unmount()

    // 2 of 2 estimated with prices: false -> unqualified "Total: 2.00 GiB"
    const fullUnpriced = await mountDialog({
      tabId: 'tab-full-unpriced',
      provider: 'bigquery',
      sql: 'SELECT 1;',
      targets: [bqTarget(1), bqTarget(2)],
      prices: false
    }, {
      estimateBigQuery: vi.fn<BigQueryDryRunEstimator>(async () => ({ ok: true, value: { bytesProcessed: 1 * GiB } }))
    })
    await flush()
    expect(fullUnpriced.form().querySelector('.multi-exec-cost-summary')?.textContent).toBe('Total: 2.00 GiB')
  })
})

describe('BigQueryCostPrompt (single + multi-project Cross-Engine)', () => {
  it('formats multi-project cost prompt text with per-project rows, cap warnings, and total', () => {
    const text = multiCostPromptText({
      kind: 'multi',
      prices: true,
      totalBytes: 30 * GiB,
      totalProjectCount: 3,
      projects: [
        { connectionId: 'c1', label: 'prod-bq', dataset: 'sales', environment: 'Production', prompt: { kind: 'threshold', bytes: 20 * GiB }, thresholdBytes: 10 * GiB, ownThreshold: true, cap: 15 * GiB },
        { connectionId: 'c2', label: 'stage-bq', prompt: { kind: 'threshold', bytes: 10 * GiB }, thresholdBytes: 5 * GiB }
      ]
    })
    expect(text.title).toBe('Run across 2 BigQuery projects?')
    expect(text.sentence).toContain('2 BigQuery projects')
    expect(text.sentence).toContain('30.00 GiB')
    expect(text.rows).toHaveLength(2)
    expect(text.rows[0]!.exceedsCap).toBe(true)
    expect(text.rows[0]!.capText).toContain('15.00 GiB')
    expect(text.rows[0]!.detail).toContain('connection threshold (10.00 GiB)')
    expect(text.totalText).toContain('2 of 3 BigQuery projects flagged')
    expect(text.optOut).toBe("Don't ask again for these 2 projects")
  })

  it('renders a single multi-project alert dialog, keeps Cancel focused, and queues cleanly alongside single-project prompts', async () => {
    const costPrompts = new CostPromptService()
    const execute = vi.fn(async () => {})
    const workbench = { costPrompts, commands: { execute } } as unknown as Workbench
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(WorkbenchProvider, { workbench, children: createElement(BigQueryCostPrompt) }))
    })
    cleanups.push(() => { act(() => root.unmount()); host.remove(); costPrompts.dispose() })

    let multi!: ReturnType<CostPromptService['askMulti']>
    let queuedSingle!: ReturnType<CostPromptService['ask']>
    await act(async () => {
      multi = costPrompts.askMulti({
        kind: 'multi',
        prices: true,
        totalBytes: 25 * GiB,
        projects: [
          { connectionId: 'c1', label: 'prod-analytics', dataset: 'orders', environment: 'Production', prompt: { kind: 'threshold', bytes: 15 * GiB }, thresholdBytes: 10 * GiB },
          { connectionId: 'c2', label: 'stage-analytics', environment: 'Staging', prompt: { kind: 'threshold', bytes: 10 * GiB }, thresholdBytes: 5 * GiB }
        ]
      })
      queuedSingle = costPrompts.ask({
        prompt: { kind: 'threshold', bytes: 12 * GiB },
        connection: 'solo-analytics',
        thresholdBytes: 10 * GiB,
        prices: true
      })
    })

    const dialog = document.body.querySelector<HTMLFormElement>('form.bigquery-cost-prompt-multi')!
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('role')).toBe('alertdialog')
    expect(dialog.querySelectorAll('.bigquery-cost-project-row')).toHaveLength(2)
    expect(dialog.textContent).toContain('prod-analytics')
    expect(dialog.textContent).toContain('PROD')
    expect(dialog.textContent).toContain('stage-analytics')
    expect(dialog.textContent).toContain('STAGING')
    expect(dialog.textContent).toContain('25.00 GiB')

    // Alert dialog keeps initial focus on Cancel.
    const cancelBtn = [...dialog.querySelectorAll('button')].find(btn => btn.textContent?.trim() === 'Cancel')!
    expect(document.activeElement).toBe(cancelBtn)

    // Check opt-out and click Run.
    const optOut = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => { optOut.click() })
    await act(async () => { dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click() })
    await expect(multi).resolves.toEqual({ run: true, dontAskAgain: true })
    await flush()

    // Queued single-project prompt now appears cleanly with backward-compatible snapshot shape.
    expect(costPrompts.getSnapshot().pending?.request.connection).toBe('solo-analytics')
    expect(costPrompts.getSnapshot().pendingMulti).toBeUndefined()
    const singleDialog = document.body.querySelector<HTMLFormElement>('form.bigquery-cost-prompt')!
    const settingsBtn = [...singleDialog.querySelectorAll('button')].find(btn => btn.textContent?.trim() === 'Cost settings…')!
    await act(async () => { settingsBtn.click() })
    await expect(queuedSingle).resolves.toEqual({ run: false })
    expect(execute).toHaveBeenCalledWith('preferences.options', { setting: 'queryExecution.bigQuery.costPrompt' }, 'toolbar')
  })

  it('R3 Finding 7: BigQueryCostPrompt preserves returnFocus across back-to-back queued prompts, resets dontAsk, focuses Cancel, and restores focus when empty', async () => {
    const trigger = document.body.appendChild(document.createElement('button'))
    trigger.textContent = 'Execute Button'
    trigger.focus()
    expect(document.activeElement).toBe(trigger)
    let triggerFocusCount = 0
    trigger.addEventListener('focus', () => { triggerFocusCount++ })

    const costPrompts = new CostPromptService()
    const workbench = { costPrompts, commands: { execute: vi.fn(async () => {}) } } as unknown as Workbench
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(WorkbenchProvider, { workbench, children: createElement(BigQueryCostPrompt) }))
    })
    cleanups.push(() => { act(() => root.unmount()); host.remove(); costPrompts.dispose() })

    let p1!: ReturnType<CostPromptService['askMulti']>
    let p2!: ReturnType<CostPromptService['ask']>
    await act(async () => {
      p1 = costPrompts.askMulti({
        kind: 'multi',
        prices: true,
        totalBytes: 20 * GiB,
        projects: [{ connectionId: 'c1', label: 'proj-1', prompt: { kind: 'threshold', bytes: 20 * GiB }, thresholdBytes: 10 * GiB }]
      })
      p2 = costPrompts.ask({
        prompt: { kind: 'threshold', bytes: 15 * GiB },
        connection: 'proj-2',
        thresholdBytes: 10 * GiB,
        prices: true
      })
    })

    // Check dontAsk and click Run on prompt #1 -> advances immediately to prompt #2.
    const checkbox1 = document.body.querySelector<HTMLInputElement>('form.bigquery-cost-prompt input[type="checkbox"]')!
    await act(async () => { checkbox1.click() })
    expect(checkbox1.checked).toBe(true)
    const runBtn1 = document.body.querySelector<HTMLButtonElement>('form.bigquery-cost-prompt button[type="submit"]')!
    runBtn1.focus()
    await act(async () => { runBtn1.click() })
    await expect(p1).resolves.toEqual({ run: true, dontAskAgain: true })

    // Trigger was NOT focused during transition; prompt #2 has unchecked checkbox and Cancel focused!
    expect(triggerFocusCount).toBe(0)
    const dialog2 = document.body.querySelector<HTMLFormElement>('form.bigquery-cost-prompt')!
    expect(dialog2.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false)
    const cancelBtn2 = [...dialog2.querySelectorAll('button')].find(btn => btn.textContent?.trim() === 'Cancel')!
    expect(document.activeElement).toBe(cancelBtn2)

    // Cancel prompt #2 -> queue empties -> focus returns cleanly to trigger (NOT document.body)!
    await act(async () => { cancelBtn2.click() })
    await expect(p2).resolves.toEqual({ run: false })
    expect(document.activeElement).toBe(trigger)
    expect(triggerFocusCount).toBeGreaterThanOrEqual(1)
  })

  it('R4 D3 #1: Cost settings… synchronously unmounts the modal via flushSync before CommandService.execute checks modalOpen()', async () => {
    const costPrompts = new CostPromptService()
    const commands = new CommandService({ modalOpen })
    let modalOpenDuringHandler: boolean | undefined
    const optionsRun = vi.fn(() => { modalOpenDuringHandler = modalOpen() })
    commands.register('preferences.options', { run: optionsRun })
    const workbench = { costPrompts, commands } as unknown as Workbench
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(WorkbenchProvider, { workbench, children: createElement(BigQueryCostPrompt) }))
    })
    cleanups.push(() => { act(() => root.unmount()); host.remove(); costPrompts.dispose(); commands.dispose() })

    // 1. Single-project prompt.
    let single!: ReturnType<CostPromptService['ask']>
    await act(async () => {
      single = costPrompts.ask({
        prompt: { kind: 'threshold', bytes: 15 * GiB },
        connection: 'solo-analytics',
        thresholdBytes: 10 * GiB,
        prices: true
      })
    })
    expect(modalOpen()).toBe(true)
    const singleSettingsBtn = [...document.body.querySelectorAll('button')].find(btn => btn.textContent?.trim() === 'Cost settings…')!
    await act(async () => { singleSettingsBtn.click() })
    await expect(single).resolves.toEqual({ run: false })
    expect(optionsRun).toHaveBeenCalledTimes(1)
    expect(optionsRun).toHaveBeenCalledWith({ setting: 'queryExecution.bigQuery.costPrompt' })
    expect(modalOpenDuringHandler).toBe(false)

    // 2. Multi-project prompt.
    optionsRun.mockClear()
    modalOpenDuringHandler = undefined
    let multi!: ReturnType<CostPromptService['askMulti']>
    await act(async () => {
      multi = costPrompts.askMulti({
        kind: 'multi',
        prices: true,
        totalBytes: 25 * GiB,
        projects: [{ connectionId: 'c1', label: 'prod-analytics', prompt: { kind: 'threshold', bytes: 25 * GiB }, thresholdBytes: 10 * GiB }]
      })
    })
    expect(modalOpen()).toBe(true)
    const multiSettingsBtn = [...document.body.querySelectorAll('button')].find(btn => btn.textContent?.trim() === 'Cost settings…')!
    await act(async () => { multiSettingsBtn.click() })
    await expect(multi).resolves.toEqual({ run: false })
    expect(optionsRun).toHaveBeenCalledTimes(1)
    expect(optionsRun).toHaveBeenCalledWith({ setting: 'queryExecution.bigQuery.costPrompt' })
    expect(modalOpenDuringHandler).toBe(false)
  })

  it('R8 D3 #1: non-preemptive turn-taking keeps open MultiExecuteDialog mounted when BigQueryCostPrompt arrives, then hands off and restores focus', async () => {
    const trigger = document.body.appendChild(document.createElement('button'))
    trigger.textContent = 'Editor Trigger'
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    const costPrompts = new CostPromptService()
    const multiService = new MultiExecutePromptService()
    const workbench = { costPrompts, commands: { execute: vi.fn(async () => {}) } } as unknown as Workbench
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(WorkbenchProvider, {
        workbench,
        children: [
          createElement(BigQueryCostPrompt, { key: 'cost' }),
          createElement(MultiExecuteDialog, { key: 'multi', service: multiService })
        ]
      }))
    })
    cleanups.push(() => { act(() => root.unmount()); host.remove(); costPrompts.dispose(); multiService.dispose() })

    // 1. Open MultiExecuteDialog FIRST (mutation defaults to transaction mode).
    let multiPrompt!: ReturnType<MultiExecutePromptService['ask']>
    await act(async () => {
      multiPrompt = multiService.ask({
        tabId: 'q-open-first',
        provider: 'sqlserver',
        sql: 'DELETE FROM dbo.Orders WHERE Id = 1;',
        targets: [sqlTarget(1), sqlTarget(2)],
        prices: true
      })
    })
    const formBefore = document.body.querySelector<HTMLFormElement>('form.multi-execute-dialog')!
    expect(formBefore).not.toBeNull()
    expect(document.body.querySelector('form.bigquery-cost-prompt')).toBeNull()

    // User switches radio to Fire and Forget and checks Sequential rollout.
    const fafRadio = formBefore.querySelector<HTMLInputElement>('input[type="radio"][value="fireAndForget"]')!
    await act(async () => { fafRadio.click() })
    const seqCheckbox = [...formBefore.querySelectorAll('label.checkbox-label')]
      .find(label => label.textContent?.includes('Sequential rollout'))!
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => { seqCheckbox.click() })
    expect(fafRadio.checked).toBe(true)
    expect(seqCheckbox.checked).toBe(true)

    // 2. Background BigQueryCostPrompt arrives while MultiExecuteDialog is open: MUST NOT preempt or unmount MultiExecuteDialog!
    let bgCost!: ReturnType<CostPromptService['ask']>
    await act(async () => {
      bgCost = costPrompts.ask({
        prompt: { kind: 'threshold', bytes: 18 * GiB },
        connection: 'bg-analytics',
        thresholdBytes: 10 * GiB,
        prices: true
      })
    })
    expect(document.body.querySelector('form.multi-execute-dialog')).toBe(formBefore)
    expect(fafRadio.checked).toBe(true)
    expect(seqCheckbox.checked).toBe(true)
    expect(document.body.querySelector('form.bigquery-cost-prompt')).toBeNull()

    // 3. Dismiss MultiExecuteDialog -> releases turn -> BigQueryCostPrompt now mounts and focuses Cancel!
    const multiCancel = [...formBefore.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent?.trim() === 'Cancel')!
    await act(async () => { multiCancel.click() })
    await expect(multiPrompt).resolves.toBeUndefined()
    expect(document.body.querySelector('form.multi-execute-dialog')).toBeNull()

    const costForm = document.body.querySelector<HTMLFormElement>('form.bigquery-cost-prompt')
    expect(costForm).not.toBeNull()
    const costCancel = [...costForm!.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent?.trim() === 'Cancel')!
    expect(document.activeElement).toBe(costCancel)

    // 4. Dismiss BigQueryCostPrompt -> focus restores cleanly back to underlying trigger!
    await act(async () => { costCancel.click() })
    await expect(bgCost).resolves.toEqual({ run: false })
    expect(document.body.querySelector('form.bigquery-cost-prompt')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    // 5. Same-render handoff from an unrelated closing modal -> BigQueryCostPrompt ignores closing modal during render,
    // recaptures trigger in onBeforeInitialFocus, and restores focus to trigger on close.
    function ClosingModal({ open, restoreTo }: { readonly open: boolean; readonly restoreTo: HTMLElement }) {
      useEffect(() => {
        if (!open) return
        const btn = document.body.querySelector<HTMLButtonElement>('[data-other-modal] button')
        btn?.focus()
        return () => { restoreTo.focus() }
      }, [open, restoreTo])
      if (!open) return null
      return createElement('div', { role: 'dialog', 'aria-modal': 'true', 'data-other-modal': '' },
        createElement('button', { type: 'button' }, 'Other Close')
      )
    }
    const host2 = document.body.appendChild(document.createElement('div'))
    const root2 = createRoot(host2)
    const costPrompts2 = new CostPromptService()
    const workbench2 = { costPrompts: costPrompts2, commands: { execute: vi.fn(async () => {}) } } as unknown as Workbench
    cleanups.push(() => { act(() => root2.unmount()); host2.remove(); costPrompts2.dispose() })

    trigger.focus()
    await act(async () => {
      root2.render(createElement(WorkbenchProvider, {
        workbench: workbench2,
        children: [
          createElement(ClosingModal, { key: 'other', open: true, restoreTo: trigger }),
          createElement(BigQueryCostPrompt, { key: 'cost' })
        ]
      }))
    })
    expect(document.activeElement?.closest('[data-other-modal]')).not.toBeNull()

    let handoffCost!: ReturnType<CostPromptService['ask']>
    await act(async () => {
      handoffCost = costPrompts2.ask({
        prompt: { kind: 'threshold', bytes: 16 * GiB },
        connection: 'handoff-bq',
        thresholdBytes: 10 * GiB,
        prices: true
      })
      root2.render(createElement(WorkbenchProvider, {
        workbench: workbench2,
        children: [
          createElement(ClosingModal, { key: 'other', open: false, restoreTo: trigger }),
          createElement(BigQueryCostPrompt, { key: 'cost' })
        ]
      }))
    })
    const handoffForm = document.body.querySelector<HTMLFormElement>('form.bigquery-cost-prompt')!
    const handoffCancel = [...handoffForm.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent?.trim() === 'Cancel')!
    expect(document.activeElement).toBe(handoffCancel)
    await act(async () => { handoffCancel.click() })
    await expect(handoffCost).resolves.toEqual({ run: false })
    expect(document.activeElement).toBe(trigger)
  })

  it('R8 D3 #2: MultiExecuteDialog reads and clears returnFocus in effect cleanup so focus recaptured in onBeforeInitialFocus is restored', async () => {
    const trigger = document.body.appendChild(document.createElement('button'))
    trigger.textContent = 'Query Editor'
    trigger.focus()

    function OtherModal({ open, restoreTo }: { readonly open: boolean; readonly restoreTo: HTMLElement }) {
      useEffect(() => {
        if (!open) return
        document.body.querySelector<HTMLButtonElement>('[data-closing-modal] button')?.focus()
        return () => { restoreTo.focus() }
      }, [open, restoreTo])
      if (!open) return null
      return createElement('div', { role: 'dialog', 'aria-modal': 'true', 'data-closing-modal': '' },
        createElement('button', { type: 'button' }, 'Dismiss')
      )
    }

    const multiService = new MultiExecutePromptService()
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.push(() => { act(() => root.unmount()); host.remove(); multiService.dispose() })

    // Open unrelated modal first so activeElement is inside [aria-modal="true"].
    await act(async () => {
      root.render(createElement('div', null,
        createElement(OtherModal, { open: true, restoreTo: trigger }),
        createElement(MultiExecuteDialog, { service: multiService })
      ))
    })
    expect(document.activeElement?.closest('[data-closing-modal]')).not.toBeNull()

    // In the SAME render: close OtherModal and open MultiExecuteDialog (standalone, no turn lock).
    // During render activeElement is still inside [aria-modal="true"], so returnFocus.current starts null;
    // OtherModal's effect cleanup restores focus to trigger, then MultiExecuteDialogModal's onBeforeInitialFocus captures it.
    let prompt!: ReturnType<MultiExecutePromptService['ask']>
    await act(async () => {
      prompt = multiService.ask({
        tabId: 'q-recapture',
        provider: 'sqlserver',
        sql: 'SELECT 1;',
        targets: [sqlTarget(1), sqlTarget(2)],
        prices: true
      })
      root.render(createElement('div', null,
        createElement(OtherModal, { open: false, restoreTo: trigger }),
        createElement(MultiExecuteDialog, { service: multiService })
      ))
    })
    const form = document.body.querySelector<HTMLFormElement>('form.multi-execute-dialog')!
    expect(form).not.toBeNull()
    expect(document.activeElement).toBe(form.querySelector('input[type="radio"][value="fireAndForget"]'))

    // Cancel MultiExecuteDialog: cleanup must read the updated returnFocus.current (trigger), NOT the stale null closed over at render!
    const cancelBtn = [...form.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent?.trim() === 'Cancel')!
    await act(async () => { cancelBtn.click() })
    await expect(prompt).resolves.toBeUndefined()
    expect(document.activeElement).toBe(trigger)
  })

  it('R9b D3 #2 & #5: MultiExecuteDialog blocks stray Enter on incomplete/error BigQuery estimates, moves aria-describedby off scroll container, and tooltips disabled controls', async () => {
    const multiService = new MultiExecutePromptService()
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.push(() => { act(() => root.unmount()); host.remove(); multiService.dispose() })

    const resolvers: ((value: { ok: true; value: BigQueryDryRunResult }) => void)[] = []
    const estimateBigQuery = vi.fn(() => new Promise<{ ok: true; value: BigQueryDryRunResult }>(resolve => { resolvers.push(resolve) }))

    let prompt!: ReturnType<MultiExecutePromptService['ask']>
    await act(async () => {
      root.render(createElement(MultiExecuteDialog, { service: multiService, estimateBigQuery }))
      prompt = multiService.ask({
        tabId: 'q-incomplete',
        provider: 'bigquery',
        sql: 'DECLARE x INT64 DEFAULT 1; SELECT * FROM ds.huge;',
        targets: [
          { ...bqTarget(1), emulator: true },
          bqTarget(2)
        ],
        prices: true,
        warnIncomplete: true
      })
    })

    const form = document.body.querySelector<HTMLFormElement>('form.multi-execute-dialog')!
    // R9b D3 #5: aria-describedby points to concise status text, NOT the scroll container.
    const descId = form.getAttribute('aria-describedby')!
    expect(descId).toBeTruthy()
    expect(document.getElementById(descId)?.classList.contains('multi-exec-scroll')).toBe(false)
    expect(document.getElementById(descId)?.textContent).toContain('Prompted on every multi-target execute.')

    // R9b D3 #5: Disabled Pre-flight Dry Run checkbox label & pending Submit button carry explanatory titles.
    const preflightLabel = [...form.querySelectorAll<HTMLLabelElement>('label.checkbox-label')].find(l => l.textContent?.includes('Pre-flight Dry Run'))!
    expect(preflightLabel.title).toContain('emulator')
    const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submitBtn.disabled).toBe(true)
    expect(submitBtn.title).toContain('Waiting for BigQuery dry-run cost estimates')

    // Resolve dry runs with faked emulator + 0 B incomplete: 'script' -> submit enables, but stray Enter on radio MUST be prevented!
    await act(async () => {
      resolvers[0]?.({ ok: true, value: { bytesProcessed: 0, faked: true } })
      resolvers[1]?.({ ok: true, value: { bytesProcessed: 0, incomplete: 'script' } })
      await Promise.resolve()
    })
    expect(submitBtn.disabled).toBe(false)
    const radio = form.querySelector<HTMLInputElement>('input[type="radio"]:checked')!
    radio.focus()
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => { radio.dispatchEvent(enterEvent) })
    expect(enterEvent.defaultPrevented).toBe(true)

    // Cancel cleans up cleanly.
    const cancelBtn = [...form.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent?.trim() === 'Cancel')!
    await act(async () => { cancelBtn.click() })
    await expect(prompt).resolves.toBeUndefined()
  })

  it('R9b D3 #4: Cost settings… still opens Options when a second BigQueryCostPrompt is queued behind the active one', async () => {
    const costPrompts = new CostPromptService()
    const optionsRun = vi.fn()
    const commands = new CommandService({
      modalOpen: () => !!document.querySelector('[aria-modal="true"]')
    })
    const reg = commands.register('preferences.options', { run: optionsRun })
    const workbench = { costPrompts, commands, dialogWindows: true } as unknown as Workbench
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.push(() => { act(() => root.unmount()); host.remove(); reg.dispose(); costPrompts.dispose() })

    let p1!: ReturnType<CostPromptService['ask']>
    let p2!: ReturnType<CostPromptService['ask']>
    await act(async () => {
      root.render(createElement(WorkbenchProvider, { workbench, children: createElement(BigQueryCostPrompt) }))
      p1 = costPrompts.ask({ prompt: { kind: 'threshold', bytes: 20 * GiB }, connection: 'bq-1', thresholdBytes: 10 * GiB, prices: true })
      p2 = costPrompts.ask({ prompt: { kind: 'threshold', bytes: 30 * GiB }, connection: 'bq-2', thresholdBytes: 10 * GiB, prices: true })
    })

    const settingsBtn = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent?.trim() === 'Cost settings…')!
    await act(async () => { settingsBtn.click() })
    await expect(p1).resolves.toEqual({ run: false })
    expect(optionsRun).toHaveBeenCalledWith({ setting: 'queryExecution.bigQuery.costPrompt' })
    // Dismiss queued p2 cleanly.
    const cancelBtn = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent?.trim() === 'Cancel')!
    await act(async () => { cancelBtn.click() })
    await expect(p2).resolves.toEqual({ run: false })
  })

  it('R10 D3 #1 & #2: MultiExecuteDialog reflects live Options cap/price updates and BigQueryCostPrompt revalidates moot queued prompts on turn handoff', async () => {
    // #1: MultiExecuteDialog live settings subscription updates cap warning & stray-Enter guard without re-running dry runs.
    const listeners = new Set<() => void>()
    let values = {
      'queryExecution.bigQuery.showCost': 'onDemand' as 'onDemand' | 'bytes',
      'queryExecution.bigQuery.maximumBytesBilled': 100 as number | null,
      'queryExecution.bigQuery.costPrompt': true,
      'queryExecution.bigQuery.costThreshold': 100,
      'queryExecution.bigQuery.incompleteEstimateWarning': true
    }
    let settingsSnap = { values }
    const settingsStub = {
      subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
      getSnapshot: () => settingsSnap,
      get: <K extends keyof typeof values>(k: K) => values[k]
    }
    const publishSettings = (patch: Partial<typeof values>) => {
      values = { ...values, ...patch }
      settingsSnap = { values }
      for (const l of listeners) l()
    }
    const multiService = new MultiExecutePromptService()
    const costPrompts = new CostPromptService()
    const wb = { settings: settingsStub, costPrompts, commands: { execute: vi.fn(async () => {}) } } as unknown as Workbench
    const estimateBigQuery = vi.fn(async () => ({ ok: true as const, value: { bytesProcessed: 20 * GiB } }))
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.push(() => { act(() => root.unmount()); host.remove(); multiService.dispose(); costPrompts.dispose() })

    let multiPromise!: ReturnType<MultiExecutePromptService['ask']>
    await act(async () => {
      root.render(createElement(WorkbenchProvider, {
        workbench: wb,
        children: [
          createElement(MultiExecuteDialog, { key: 'multi', service: multiService, estimateBigQuery }),
          createElement(BigQueryCostPrompt, { key: 'cost' })
        ]
      }))
      multiPromise = multiService.ask({
        tabId: 'q-live-cap',
        provider: 'bigquery',
        sql: 'SELECT * FROM ds.t;',
        targets: [bqTarget(1), bqTarget(2)],
        prices: true
      })
    })
    await act(async () => { await Promise.resolve() })
    expect(estimateBigQuery).toHaveBeenCalledTimes(2)
    const form = document.body.querySelector<HTMLFormElement>('form.multi-execute-dialog')!
    expect(form.textContent).not.toContain('Exceeds maximum bytes billed')

    // Enqueue a BigQueryCostPrompt behind the open MultiExecuteDialog whose stillAsks depends on costPrompt === true.
    let stillValid = true
    let queuedCost!: ReturnType<CostPromptService['ask']>
    act(() => {
      queuedCost = costPrompts.ask(
        { prompt: { kind: 'threshold', bytes: 25 * GiB }, connection: 'bg-bq', thresholdBytes: 10 * GiB, prices: true },
        undefined,
        () => stillValid
      )
    })
    expect(document.body.querySelector('form.bigquery-cost-prompt')).toBeNull()

    // While MultiExecuteDialog is open: lower maximumBytesBilled to 5 GiB -> warning appears immediately & stray Enter is blocked;
    // dry runs are NOT re-invoked. Also mark the queued BigQueryCostPrompt moot!
    act(() => {
      stillValid = false
      publishSettings({ 'queryExecution.bigQuery.maximumBytesBilled': 5, 'queryExecution.bigQuery.showCost': 'bytes' })
    })
    expect(estimateBigQuery).toHaveBeenCalledTimes(2)
    expect(form.textContent).toContain('Exceeds maximum bytes billed')
    expect(form.textContent).not.toContain('on demand')
    const radio = form.querySelector<HTMLInputElement>('input[type="radio"]:checked')!
    radio.focus()
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => { radio.dispatchEvent(enterEvent) })
    expect(enterEvent.defaultPrevented).toBe(true)

    // #2: Close MultiExecuteDialog -> PromptTurnLock hands turn to BigQueryCostPrompt -> revalidates moot prompt without mounting it!
    const cancelBtn = [...form.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent?.trim() === 'Cancel')!
    await act(async () => { cancelBtn.click() })
    await expect(multiPromise).resolves.toBeUndefined()
    await expect(queuedCost).resolves.toEqual({ run: true, moot: true })
    expect(document.body.querySelector('form.bigquery-cost-prompt')).toBeNull()
  })

  it('R11 D3 #1 & #2: SubDialog blocks stray Enter on alert checkbox, and BigQueryCostPrompt updates live on Options changes', async () => {
    const listeners = new Set<() => void>()
    let values = {
      'queryExecution.bigQuery.showCost': 'onDemand' as 'onDemand' | 'bytes',
      'queryExecution.bigQuery.maximumBytesBilled': 50 as number | null,
      'queryExecution.bigQuery.costPrompt': true,
      'queryExecution.bigQuery.costThreshold': 10,
      'queryExecution.bigQuery.incompleteEstimateWarning': true
    }
    let settingsSnap = { values }
    const settingsStub = {
      subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
      getSnapshot: () => settingsSnap,
      get: <K extends keyof typeof values>(k: K) => values[k]
    }
    const publishSettings = (patch: Partial<typeof values>) => {
      values = { ...values, ...patch }
      settingsSnap = { values }
      for (const l of listeners) l()
    }
    const costPrompts = new CostPromptService()
    const wb = { settings: settingsStub, costPrompts, commands: { execute: vi.fn(async () => {}) } } as unknown as Workbench
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    cleanups.push(() => { act(() => root.unmount()); host.remove(); costPrompts.dispose() })

    let promptPromise!: ReturnType<CostPromptService['askMulti']>
    await act(async () => {
      root.render(createElement(WorkbenchProvider, { workbench: wb, children: createElement(BigQueryCostPrompt) }))
      promptPromise = costPrompts.askMulti({
        kind: 'multi',
        projects: [{
          connectionId: 'bq-1',
          label: 'bq-analytics',
          prompt: { kind: 'threshold', bytes: 25 * GiB },
          thresholdBytes: 10 * GiB,
          cap: 50 * GiB
        }],
        prices: true,
        totalBytes: 25 * GiB,
        totalProjectCount: 1
      })
    })

    const form = document.body.querySelector<HTMLFormElement>('form.bigquery-cost-prompt')!
    expect(form.querySelector('.bigquery-cost-project-cap.is-exceeded')).toBeNull()
    expect(form.textContent).toContain('on demand')

    // #1: Stray Enter on the Don't ask again checkbox MUST be default-prevented and must NOT submit the alert dialog!
    const checkbox = form.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    checkbox.focus()
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => { checkbox.dispatchEvent(enterEvent) })
    expect(enterEvent.defaultPrevented).toBe(true)
    expect(document.body.querySelector('form.bigquery-cost-prompt')).toBe(form)

    // #2: Lower maximumBytesBilled to 5 GiB & switch showCost to bytes -> open prompt updates live!
    act(() => {
      publishSettings({ 'queryExecution.bigQuery.maximumBytesBilled': 5, 'queryExecution.bigQuery.showCost': 'bytes' })
    })
    expect(form.querySelector('.bigquery-cost-project-cap.is-exceeded')).not.toBeNull()
    expect(form.textContent).not.toContain('on demand')

    const cancelBtn = [...form.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent?.trim() === 'Cancel')!
    await act(async () => { cancelBtn.click() })
    await expect(promptPromise).resolves.toEqual({ run: false })
  })
})
