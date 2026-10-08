import { describe, expect, it } from 'vitest'
import { compileWhen, evaluateWhen, parseWhen, referencedKeys, WhenSyntaxError, type ContextRecord } from '../src/shared/commands/when'

const context = (values: Record<string, boolean | string>): ContextRecord => Object.assign(Object.create(null), values)
const holds = (source: string, values: Record<string, boolean | string>) => evaluateWhen(parseWhen(source), context(values))
const failure = (source: string) => {
  try { parseWhen(source) } catch (error) {
    expect(error).toBeInstanceOf(WhenSyntaxError)
    return { offset: (error as WhenSyntaxError).offset, message: (error as Error).message }
  }
  throw new Error(`"${source}" parsed`)
}

describe('when clauses', () => {
  it('bind ! tighter than && and && tighter than ||', () => {
    expect(parseWhen('a || b && !c')).toEqual({ type: 'or', operands: [{ type: 'key', key: 'a' }, { type: 'and', operands: [{ type: 'key', key: 'b' }, { type: 'not', operand: { type: 'key', key: 'c' } }] }] })
    expect(holds('a || b && !c', { a: false, b: true, c: true })).toBe(false)
    expect(holds('a || b && !c', { a: true, b: false, c: true })).toBe(true)
    expect(holds('(a || b) && !c', { a: true, b: false, c: true })).toBe(false)
    expect(holds('!(a && b)', { a: true, b: true })).toBe(false)
    expect(holds('!!a', { a: true })).toBe(true)
    expect(parseWhen('a && b && c')).toEqual({ type: 'and', operands: ['a', 'b', 'c'].map(key => ({ type: 'key', key })) })
  })
  it('compare with typed literals: true and false are booleans, everything else a string', () => {
    expect(parseWhen("panel == 'explorer'")).toEqual({ type: 'equals', key: 'panel', value: 'explorer', negated: false })
    expect(parseWhen('panel != explorer')).toEqual({ type: 'equals', key: 'panel', value: 'explorer', negated: true })
    expect(parseWhen('flag == true')).toEqual({ type: 'equals', key: 'flag', value: true, negated: false })
    expect(parseWhen("flag == 'true'")).toEqual({ type: 'equals', key: 'flag', value: 'true', negated: false })
    expect(parseWhen('version == 1.5-beta_2')).toEqual({ type: 'equals', key: 'version', value: '1.5-beta_2', negated: false })
    expect(parseWhen("name == ''")).toEqual({ type: 'equals', key: 'name', value: '', negated: false })
    expect(parseWhen("name == 'a && b || (c)'")).toMatchObject({ value: 'a && b || (c)' })
    expect(holds('flag == true', { flag: true })).toBe(true)
    expect(holds("flag == 'true'", { flag: true })).toBe(false)
    expect(holds('flag == false', { flag: false })).toBe(true)
    expect(holds("panel == 'explorer'", { panel: 'explorer' })).toBe(true)
    expect(holds("panel != 'explorer'", { panel: 'editor' })).toBe(true)
    expect(holds("panel == ''", { panel: '' })).toBe(true)
  })
  it('treat a bare key as true only for true or a non-empty string', () => {
    expect(holds('a', { a: true })).toBe(true)
    for (const value of [false, '']) expect(holds('a', { a: value }), JSON.stringify(value)).toBe(false)
    expect(holds('a', { a: 'explorer' })).toBe(true)
    expect(evaluateWhen(parseWhen('a'), { a: 1 } as unknown as ContextRecord)).toBe(false)
  })
  it('treat unknown keys as unset, including prototype names', () => {
    expect(holds('missing', {})).toBe(false)
    expect(holds('!missing', {})).toBe(true)
    expect(holds("missing == 'x'", {})).toBe(false)
    expect(holds("missing != 'x'", {})).toBe(true)
    for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(evaluateWhen(parseWhen(key), {}), key).toBe(false)
      expect(evaluateWhen(parseWhen(key), context({})), key).toBe(false)
    }
    expect(() => parseWhen('__proto__')).toThrow(WhenSyntaxError)
  })
  it('report errors with the offset of the problem', () => {
    expect(failure('')).toMatchObject({ offset: 0 })
    expect(failure('a &&')).toMatchObject({ offset: 4, message: 'Expected a context key.' })
    expect(failure('(a || b')).toMatchObject({ offset: 7, message: "Expected ')'." })
    expect(failure('a || b)')).toMatchObject({ offset: 6, message: "Unbalanced ')'." })
    expect(failure('a b')).toMatchObject({ offset: 2 })
    expect(failure("a =~ /x/")).toMatchObject({ offset: 2, message: 'Regular-expression matches (=~) are not supported.' })
    expect(failure('count < 3')).toMatchObject({ offset: 6 })
    expect(failure('count >= 3')).toMatchObject({ offset: 6 })
    expect(failure('a = b')).toMatchObject({ offset: 2, message: 'Use == or != to compare.' })
    expect(failure('a & b')).toMatchObject({ offset: 2 })
    expect(failure("a == 'open")).toMatchObject({ offset: 5, message: 'The quoted value is not closed.' })
    expect(failure("a == 'x\ny'")).toMatchObject({ offset: 5 })
    expect(failure(`a == '${'x'.repeat(65)}'`)).toMatchObject({ offset: 5 })
    expect(parseWhen(`a == '${'x'.repeat(64)}'`)).toMatchObject({ value: 'x'.repeat(64) })
    expect(failure(`a == ${'x'.repeat(65)}`)).toMatchObject({ offset: 5 })
    expect(failure('a == ')).toMatchObject({ offset: 5 })
    expect(failure('a == !b')).toMatchObject({ offset: 5 })
    expect(failure('a in b')).toMatchObject({ offset: 2 })
    expect(failure('1abc')).toMatchObject({ offset: 0, message: 'Expected a context key.' })
    expect(failure('a_b')).toMatchObject({ offset: 0, message: 'Expected a context key.' })
    expect(failure(`${'k'.repeat(65)}`)).toMatchObject({ offset: 0 })
    expect(parseWhen(`${'k'.repeat(64)}`)).toEqual({ type: 'key', key: 'k'.repeat(64) })
    expect(failure('a @ b')).toMatchObject({ offset: 2, message: 'Unexpected character "@".' })
  })
  it('limit length, tokens, and nesting', () => {
    const long = 'a'.repeat(20) + ' && ' + 'b'.repeat(20)
    const atLimit = Array.from({ length: 6 }, () => long).join(' || ').slice(0, 256)
    expect(atLimit.length).toBe(256)
    expect(failure(atLimit + ' ')).toMatchObject({ offset: 256, message: 'A when clause is limited to 256 characters.' })
    const tokens = (count: number) => Array.from({ length: (count + 1) / 2 }, (_, index) => `k${index}`).join('&&')
    expect(() => parseWhen(tokens(63))).not.toThrow()
    expect(failure(tokens(63) + '&&')).toMatchObject({ message: 'Expected a context key.' })
    expect(failure(tokens(65))).toMatchObject({ offset: tokens(63).length + 2, message: 'A when clause is limited to 64 tokens.' })
    expect(() => parseWhen('!'.repeat(8) + 'a')).not.toThrow()
    expect(failure('!'.repeat(9) + 'a')).toMatchObject({ offset: 8 })
    expect(() => parseWhen('('.repeat(8) + 'a' + ')'.repeat(8))).not.toThrow()
    expect(failure('('.repeat(9) + 'a' + ')'.repeat(9))).toMatchObject({ offset: 8, message: 'A when clause can nest at most 8 levels.' })
    expect(failure('!(!(!(!(!a))))')).toMatchObject({ offset: 8 })
  })
  it('list the keys a clause reads, once each', () => {
    expect(referencedKeys(parseWhen("a && !b || (c == 'x' && a) || b != true"))).toEqual(['a', 'b', 'c'])
    expect(referencedKeys(parseWhen('isMac'))).toEqual(['isMac'])
  })
  it('cache compiled clauses and never cache failures', () => {
    expect(compileWhen('cached && key')).toBe(compileWhen('cached && key'))
    expect(compileWhen('cached && key')).toEqual(parseWhen('cached && key'))
    expect(() => compileWhen('bad &&')).toThrow(WhenSyntaxError)
    expect(() => compileWhen('bad &&')).toThrow(WhenSyntaxError)
    for (let index = 0; index < 1100; index++) compileWhen(`churn${index}`)
    expect(compileWhen('churn1099')).toBe(compileWhen('churn1099'))
  })
  it('throw only WhenSyntaxError for arbitrary input', () => {
    const alphabet = ['a', 'b', 'k.x', '!', '&&', '||', '&', '|', '(', ')', '==', '!=', '=', '~', '<', "'", "'v'", 'true', '1', '_', '-', ' ', '\n', 'é', '@', '\\']
    let seed = 42
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let run = 0; run < 2000; run++) {
      const source = Array.from({ length: Math.floor(random() * 40) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')
      try { evaluateWhen(parseWhen(source), context({ a: true, b: 'x' })) } catch (error) { expect(error, source).toBeInstanceOf(WhenSyntaxError) }
    }
  })
})
