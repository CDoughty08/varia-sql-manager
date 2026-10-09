import { describe, expect, it } from 'vitest'
import { formatJson, formatXml } from '../src/renderer/src/results/doc-format'

const xml = (text: string) => formatXml(text)
const formatted = (text: string) => ({ text, formatted: true })
/** The fastest of three runs, so a busy machine does not fail a linear-time check. */
function bestOf3(action: () => void): number {
  let best = Infinity
  for (let run = 0; run < 3; run++) { const start = performance.now(); action(); best = Math.min(best, performance.now() - start) }
  return best
}

describe('XML formatting', () => {
  it('indents elements that hold only elements, one per line', () => {
    expect(xml('<a><b><c/></b><d x="1"/></a>')).toEqual(formatted('<a>\n  <b>\n    <c/>\n  </b>\n  <d x="1"/>\n</a>'))
    // Whitespace between elements is replaced; formatting twice changes nothing.
    const once = xml('<a>\n\t <b/>   <b/>\r\n</a>').text
    expect(once).toBe('<a>\n  <b/>\n  <b/>\n</a>')
    expect(xml(once).text).toBe(once)
    // A FOR XML fragment: several top-level elements, each on its own line.
    expect(xml('<row id="1"/><row id="2"><n>x</n></row>')).toEqual(formatted('<row id="1"/>\n<row id="2">\n  <n>x</n>\n</row>'))
  })
  it('keeps mixed content, CDATA and empty elements exactly as they were', () => {
    expect(xml('<p>Hello <b>big</b>  world<i/></p>')).toEqual(formatted('<p>Hello <b>big</b>  world<i/></p>'))
    expect(xml('<a><p>Hi <b><c/></b></p><q></q><r>  </r></a>')).toEqual(formatted('<a>\n  <p>Hi <b><c/></b></p>\n  <q></q>\n  <r>  </r>\n</a>'))
    expect(xml('<a><![CDATA[<b>not a tag</b>]]></a>')).toEqual(formatted('<a><![CDATA[<b>not a tag</b>]]></a>'))
    expect(xml('<a>x &amp; y &lt;b&gt;</a>')).toEqual(formatted('<a>x &amp; y &lt;b&gt;</a>'))
  })
  it('puts comments, processing instructions and the DOCTYPE on lines of their own, and never expands entities', () => {
    expect(xml('<?xml version="1.0"?><!-- top --><a><!-- in --><?pi data?><b/></a>')).toEqual(formatted('<?xml version="1.0"?>\n<!-- top -->\n<a>\n  <!-- in -->\n  <?pi data?>\n  <b/>\n</a>'))
    const doctype = '<!DOCTYPE a [<!ENTITY e "<b>&e;</b>"><!-- ] > --><!ELEMENT a ANY>]>'
    expect(xml(doctype + '<a><b>&e;</b></a>')).toEqual(formatted(doctype + '\n<a>\n  <b>&e;</b>\n</a>'))
  })
  it('reads > and quotes inside attribute values as text', () => {
    expect(xml('<a x="1 > 0" y=\'say "hi"\'><b z="/>"/></a>')).toEqual(formatted('<a x="1 > 0" y=\'say "hi"\'>\n  <b z="/>"/>\n</a>'))
    expect(xml('<RelOp PhysicalOp="Nested Loops" EstimateRows="1E+06"><OutputList/></RelOp>').text).toBe('<RelOp PhysicalOp="Nested Loops" EstimateRows="1E+06">\n  <OutputList/>\n</RelOp>')
  })
  it('returns malformed or unusual text unchanged', () => {
    for (const text of ['', '   ', 'plain text', 'a,b,c', '<a>', '<a></b>', '</a>', '<a><b></a></b>', '<a x="1></a>', '<!-- open', '<a><![CDATA[x</a>', '<?pi', 'text<a/>', '<a/>tail', '<a><!DOCTYPE x></a>', '< a/>', '<a/><', '<a <b/>/>', '<!-- only -->', '<![CDATA[x]]>'])
      expect(xml(text), JSON.stringify(text)).toEqual({ text, formatted: false })
  })
  it('stops at 256 levels of nesting and at its output limit', () => {
    const nest = (depth: number) => '<e>'.repeat(depth) + '<x/>' + '</e>'.repeat(depth)
    expect(xml(nest(255)).formatted).toBe(true)
    expect(xml(nest(256)).formatted).toBe(false)
    expect(formatXml(nest(3), { maxDepth: 3 }).formatted).toBe(false)
    // '<a>\n  <b/>\n</a>' is 15 characters.
    expect(formatXml('<a><b/></a>', { maxChars: 15 }).formatted).toBe(true)
    expect(formatXml('<a><b/></a>', { maxChars: 14 })).toEqual({ text: '<a><b/></a>', formatted: false })
    // Input already over the limit is not tokenized at all.
    expect(formatXml('<a/>', { maxChars: 3 }).formatted).toBe(false)
  })
  it('formats 2 million characters of FOR XML output in linear time', () => {
    const row = (index: number) => `<row id="${index}" name="Customer ${index}"><note>Note ${index} &amp; more</note><v>${index * 3}</v></row>`
    const parts: string[] = []
    let length = 0
    for (let index = 0; length < 2_000_000; index++) { const item = row(index); parts.push(item); length += item.length }
    const text = '<root>' + parts.join('') + '</root>'
    const result = formatXml(text)
    expect(result.formatted).toBe(true)
    expect(result.text.split('\n')).toHaveLength(parts.length * 4 + 2)
    expect(bestOf3(() => formatXml(text))).toBeLessThan(300)
  })
})

describe('JSON formatting', () => {
  const json = (text: string) => formatJson(text)
  it('indents members and elements by two, keeping numbers and strings verbatim', () => {
    expect(json('[{"a":1,"b":"x"},{"a":2,"b":null}]')).toEqual(formatted('[\n  {\n    "a": 1,\n    "b": "x"\n  },\n  {\n    "a": 2,\n    "b": null\n  }\n]'))
    expect(json(' { "n" : { } , "l" : [ ] , "t" : true , "f" : false } ')).toEqual(formatted('{\n  "n": {},\n  "l": [],\n  "t": true,\n  "f": false\n}'))
    // Numbers JavaScript cannot represent are copied exactly.
    expect(json('[12345678901234567890123,1E+20,-0.000000000000000000001,0,-0]').text).toBe('[\n  12345678901234567890123,\n  1E+20,\n  -0.000000000000000000001,\n  0,\n  -0\n]')
    expect(json('{"s":"\\"q\\" \\\\ \\/ \\b\\f\\n\\r\\t \\u00e9 \\ud83d\\ude00 é 😀"}').text).toBe('{\n  "s": "\\"q\\" \\\\ \\/ \\b\\f\\n\\r\\t \\u00e9 \\ud83d\\ude00 é 😀"\n}')
    expect(json('"just a string"')).toEqual(formatted('"just a string"'))
    expect(json('42')).toEqual(formatted('42'))
    const once = json('{"a":[1,[2,{"b":[]}]]}').text
    expect(json(once).text).toBe(once)
  })
  it('returns malformed JSON unchanged', () => {
    for (const text of ['', ' ', '{', '[1,]', '{"a":1,}', '{"a" 1}', '{a:1}', '[1 2]', '01', '1.', '.5', '1e', '+1', 'tru', 'nul', 'truex', '"\\x"', '"\\u12G4"', '"a\u0001b"', '"open', '{"a":1}}', '[1],[2]', '{"a":1},{"b":2}', "{'a':1}", 'NaN'])
      expect(json(text), JSON.stringify(text)).toEqual({ text, formatted: false })
  })
  it('stops at 512 levels of nesting and at its output limit', () => {
    expect(json('['.repeat(512) + ']'.repeat(512)).formatted).toBe(true)
    expect(json('['.repeat(513) + ']'.repeat(513)).formatted).toBe(false)
    expect(json('{"a":'.repeat(512) + '1' + '}'.repeat(512)).formatted).toBe(true)
    expect(json('{"a":'.repeat(513) + '1' + '}'.repeat(513)).formatted).toBe(false)
    expect(formatJson('[1,2]', { maxChars: 12 })).toEqual(formatted('[\n  1,\n  2\n]'))
    expect(formatJson('[1,2]', { maxChars: 11 })).toEqual({ text: '[1,2]', formatted: false })
    expect(formatJson('[1]', { maxDepth: 0 }).formatted).toBe(false)
  })
  it('formats 2 million characters of FOR JSON output in linear time', () => {
    const parts: string[] = []
    let length = 0
    for (let index = 0; length < 2_000_000; index++) { const item = JSON.stringify({ id: index, name: `Customer ${index}`, amount: index * 1.25, tags: ['a', 'b'], ok: index % 2 === 0 }); parts.push(item); length += item.length }
    const text = '[' + parts.join(',') + ']'
    const result = formatJson(text)
    expect(result.formatted).toBe(true)
    expect(JSON.parse(result.text)).toEqual(JSON.parse(text))
    expect(bestOf3(() => formatJson(text))).toBeLessThan(300)
  })
})
