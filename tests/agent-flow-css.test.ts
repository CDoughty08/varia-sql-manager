import { expect, it } from 'vitest'
import { stylesheetRules } from './fixtures/css-rules'

// Steps › Flow in a narrow pane (a split editor): the side panel, 380 px or 560 px with the docked editor, would leave the graph no width,
// so below what both need the panel goes under the graph, measured on Flow's own width rather than the window's.
const rules = stylesheetRules()
const valueOf = (selector: string, property: string, at: readonly string[] = []) =>
  rules.filter(rule => rule.selector === selector && rule.at.join(' ') === at.join(' ')).flatMap(rule => rule.declarations).find(declaration => declaration.property === property)?.value

it('stacks the Flow side panel under the graph when the pane cannot fit both, on Flow\'s own width', () => {
  expect(valueOf('.agent-flow', 'container')).toBe('agent-flow / inline-size')
  expect(valueOf('.agent-flow-body[data-wide]', 'grid-template-columns')).toBe('minmax(0, 1fr) 560px')
  const narrow = ['@container agent-flow (max-width: 760px)'], editing = ['@container agent-flow (min-width: 761px) and (max-width: 1040px)']
  expect(valueOf('.agent-flow-body, .agent-flow-body[data-wide]', 'grid-template-columns', narrow)).toBe('minmax(0, 1fr)')
  expect(valueOf('.agent-flow-body[data-wide]', 'grid-template-columns', editing)).toBe('minmax(0, 1fr)')
  // Stacked, the graph keeps a height of its own: a grid row, not what is left of a fixed body.
  expect(valueOf('.agent-flow-body, .agent-flow-body[data-wide]', 'grid-template-rows', narrow)).toBe('clamp(280px, 50vh, 520px) auto')
  expect(valueOf('.agent-flow-body, .agent-flow-body[data-wide]', 'height', narrow)).toBe('auto')
})
