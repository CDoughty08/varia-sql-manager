import { describe, expect, it } from 'vitest'
import { validateRequest, validateResult } from '../src/main/validation'
import { deadlineFor, methodPolicies } from '../src/shared/ipc/methods'
import { estimatedPlanLimits } from '../src/shared/estimated-plans'

const request = { connectionId: crypto.randomUUID(), sessionId: crypto.randomUUID(), requestId: crypto.randomUUID(), database: ' x ', sql: 'SELECT 1', startLine: 12 }
const plan = { xml: '<ShowPlanXML/>', batchNumber: 2, iteration: 1 }
describe('bounded estimated plan contract', () => {
  it('has a unary path with a fixed deadline independent of ordinary execution options', () => {
    expect(validateRequest('plans.estimate', request)).toEqual(request)
    expect(methodPolicies['plans.estimate']).toMatchObject({ kind: 'unary', lane: 'query' })
    expect(deadlineFor('plans.estimate', request).deadlineMs).toBe(estimatedPlanLimits.deadlineMs)
    for (const extra of [{ includeActualPlan: true }, { timeoutSeconds: 0 }, { maxResultSets: 10 }])
      expect(() => validateRequest('plans.estimate', { ...request, ...extra })).toThrow('Invalid request')
    expect(() => validateRequest('plans.estimate', { ...request, sql: 'x'.repeat(1_000_001) })).toThrow('Invalid request')
  })
  it('bounds the combined XML response as well as individual documents and refuses summary/event fields', () => {
    expect(validateResult('plans.estimate', { plans: [plan], database: 'master' })).toEqual({ plans: [plan], database: 'master' })
    for (const plans of [Array(65).fill(plan), [{ ...plan, xml: 'x'.repeat(estimatedPlanLimits.characters + 1) }],
      [{ ...plan, xml: 'x'.repeat(estimatedPlanLimits.characters) }, plan]])
      expect(() => validateResult('plans.estimate', { plans, database: 'master' })).toThrow()
    expect(() => validateResult('plans.estimate', { plans: [plan], database: 'master', statistics: {} })).toThrow()
  })
})
