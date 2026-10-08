/**
 * When clauses: a small boolean language over context keys (`a && !b`, `activePanel == 'explorer'`), parsed by
 * recursive descent and never evaluated as code. Commands use it for preconditions, toggled state, and keybinding scope.
 */
export type WhenAst =
  | { readonly type: 'key'; readonly key: string }
  | { readonly type: 'equals'; readonly key: string; readonly value: boolean | string; readonly negated: boolean }
  | { readonly type: 'not'; readonly operand: WhenAst }
  | { readonly type: 'and' | 'or'; readonly operands: readonly WhenAst[] }
export type ContextValue = boolean | string
export type ContextRecord = Readonly<Record<string, ContextValue>>

export const whenLimits = { length: 256, tokens: 64, depth: 8, value: 64, cache: 1024 } as const

export class WhenSyntaxError extends Error {
  constructor(readonly offset: number, message: string) {
    super(message)
    this.name = 'WhenSyntaxError'
  }
}

type TokenKind = '!' | '&&' | '||' | '(' | ')' | '==' | '!=' | 'word' | 'string' | 'end'
interface Token { readonly kind: TokenKind; readonly text: string; readonly offset: number }
const keyPattern = /^[A-Za-z][A-Za-z0-9.]{0,63}$/
const valuePattern = /^[A-Za-z0-9_.-]{1,64}$/
const wordPattern = /[A-Za-z0-9_.-]+/y

function tokenize(source: string): Token[] {
  if (source.length > whenLimits.length) throw new WhenSyntaxError(whenLimits.length, `A when clause is limited to ${whenLimits.length} characters.`)
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const character = source[index]
    if (/\s/.test(character)) { index++; continue }
    if (tokens.length === whenLimits.tokens) throw new WhenSyntaxError(index, `A when clause is limited to ${whenLimits.tokens} tokens.`)
    const pair = source.slice(index, index + 2)
    if (pair === '&&' || pair === '||' || pair === '==' || pair === '!=') { tokens.push({ kind: pair, text: pair, offset: index }); index += 2; continue }
    if (pair === '=~') throw new WhenSyntaxError(index, 'Regular-expression matches (=~) are not supported.')
    if (character === '!' || character === '(' || character === ')') { tokens.push({ kind: character, text: character, offset: index }); index++; continue }
    if (character === "'") {
      const end = source.indexOf("'", index + 1)
      if (end < 0) throw new WhenSyntaxError(index, 'The quoted value is not closed.')
      const text = source.slice(index + 1, end)
      if (text.includes('\n')) throw new WhenSyntaxError(index, 'A quoted value cannot span lines.')
      if (text.length > whenLimits.value) throw new WhenSyntaxError(index, `A quoted value is limited to ${whenLimits.value} characters.`)
      tokens.push({ kind: 'string', text, offset: index })
      index = end + 1
      continue
    }
    wordPattern.lastIndex = index
    const word = wordPattern.exec(source)
    if (word) { tokens.push({ kind: 'word', text: word[0], offset: index }); index += word[0].length; continue }
    if (character === '<' || character === '>') throw new WhenSyntaxError(index, 'Comparison operators (<, >) are not supported.')
    if (character === '=') throw new WhenSyntaxError(index, 'Use == or != to compare.')
    if (character === '&' || character === '|') throw new WhenSyntaxError(index, 'Use && or || to combine conditions.')
    throw new WhenSyntaxError(index, `Unexpected character ${JSON.stringify(character)}.`)
  }
  tokens.push({ kind: 'end', text: '', offset: source.length })
  return tokens
}

class Parser {
  private index = 0
  private depth = 0
  constructor(private readonly tokens: readonly Token[]) {}

  parse(): WhenAst {
    const ast = this.or()
    const token = this.peek()
    if (token.kind !== 'end') throw new WhenSyntaxError(token.offset, token.kind === ')' ? "Unbalanced ')'." : "Expected '&&', '||', or the end of the clause.")
    return ast
  }
  private peek(): Token { return this.tokens[this.index] }
  private next(): Token { return this.tokens[this.index++] }
  private or(): WhenAst {
    const operands = [this.and()]
    while (this.peek().kind === '||') { this.next(); operands.push(this.and()) }
    return operands.length === 1 ? operands[0] : { type: 'or', operands }
  }
  private and(): WhenAst {
    const operands = [this.unary()]
    while (this.peek().kind === '&&') { this.next(); operands.push(this.unary()) }
    return operands.length === 1 ? operands[0] : { type: 'and', operands }
  }
  private unary(): WhenAst {
    const token = this.peek()
    if (token.kind !== '!' && token.kind !== '(') return this.term()
    this.next()
    // Negations and parentheses both recurse, so one counter bounds the parser's stack.
    if (++this.depth > whenLimits.depth) throw new WhenSyntaxError(token.offset, `A when clause can nest at most ${whenLimits.depth} levels.`)
    let ast: WhenAst
    if (token.kind === '!') ast = { type: 'not', operand: this.unary() }
    else {
      ast = this.or()
      const close = this.next()
      if (close.kind !== ')') throw new WhenSyntaxError(close.offset, "Expected ')'.")
    }
    this.depth--
    return ast
  }
  private term(): WhenAst {
    const token = this.next()
    if (token.kind !== 'word' || !keyPattern.test(token.text)) throw new WhenSyntaxError(token.offset, 'Expected a context key.')
    const operator = this.peek()
    if (operator.kind !== '==' && operator.kind !== '!=') return { type: 'key', key: token.text }
    this.next()
    const value = this.next()
    if (value.kind === 'string') return { type: 'equals', key: token.text, value: value.text, negated: operator.kind === '!=' }
    if (value.kind !== 'word' || !valuePattern.test(value.text)) throw new WhenSyntaxError(value.offset, 'Expected a value: true, false, a quoted string, or a bare word.')
    return { type: 'equals', key: token.text, value: value.text === 'true' ? true : value.text === 'false' ? false : value.text, negated: operator.kind === '!=' }
  }
}

/** Parses a when clause, throwing `WhenSyntaxError` with the offset of the problem. */
export function parseWhen(source: string): WhenAst {
  return new Parser(tokenize(source)).parse()
}

const cache = new Map<string, WhenAst>()
/** `parseWhen` with a bounded cache: clauses come from a fixed catalogue, so the cache only clears if something churns it. */
export function compileWhen(source: string): WhenAst {
  const cached = cache.get(source)
  if (cached) return cached
  const ast = parseWhen(source)
  if (cache.size >= whenLimits.cache) cache.clear()
  cache.set(source, ast)
  return ast
}

const read = (context: ContextRecord, key: string): ContextValue | undefined => Object.hasOwn(context, key) ? context[key] : undefined

/**
 * A bare key is true when its value is `true` or a non-empty string; `==` compares strictly with the typed literal,
 * and `!=` is its negation. A key the context does not define has no value, so it is false and equals nothing.
 */
export function evaluateWhen(ast: WhenAst, context: ContextRecord): boolean {
  switch (ast.type) {
    case 'key': { const value = read(context, ast.key); return value === true || (typeof value === 'string' && value.length > 0) }
    case 'equals': return (read(context, ast.key) === ast.value) !== ast.negated
    case 'not': return !evaluateWhen(ast.operand, context)
    case 'and': return ast.operands.every(operand => evaluateWhen(operand, context))
    case 'or': return ast.operands.some(operand => evaluateWhen(operand, context))
  }
}

/** Every key the clause reads, once each, in order of appearance. */
export function referencedKeys(ast: WhenAst): string[] {
  const keys = new Set<string>()
  const visit = (node: WhenAst): void => {
    if (node.type === 'key' || node.type === 'equals') keys.add(node.key)
    else if (node.type === 'not') visit(node.operand)
    else node.operands.forEach(visit)
  }
  visit(ast)
  return [...keys]
}

/** Every `==`/`!=` comparison in the clause, for checking literals against the key's declared type. */
export function comparisons(ast: WhenAst): { key: string; value: boolean | string }[] {
  if (ast.type === 'equals') return [{ key: ast.key, value: ast.value }]
  if (ast.type === 'not') return comparisons(ast.operand)
  if (ast.type === 'and' || ast.type === 'or') return ast.operands.flatMap(comparisons)
  return []
}
