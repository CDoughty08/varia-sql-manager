import { planLimits } from '../../../shared/plans'

export interface PlanXmlTarget { statement: number; operator?: number; nodeId?: string; revision?: number }
export interface XmlLocation { target: PlanXmlTarget; start: number; end: number; openEnd: number }
const namespace = 'http://schemas.microsoft.com/sqlserver/2004/07/showplan'
const decodeAttribute = (value: string) => value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|apos|quot);/gi, (entity, name: string) => {
  if (name[0] === '#') { const point = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10); return point <= 0x10ffff ? String.fromCodePoint(point) : entity }
  return ({ amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' } as Record<string, string>)[name] ?? entity
})

/** On-demand lexical positions in already validated Showplan. Namespace scopes, comments,
 * quoted '>' and nested statements must agree with the parser; NodeId alone is never unique. */
export function xmlLocations(xml: string): XmlLocation[] {
  if (xml.length > planLimits.characters) return []
  const locations: XmlLocation[] = [], counts: number[] = []
  type Scope = { ns: Record<string, string>; statement: number; location?: XmlLocation }
  const stack: Scope[] = [{ ns: Object.create(null) as Record<string, string>, statement: -1 }]
  for (let at = 0; at < xml.length;) {
    const start = xml.indexOf('<', at)
    if (start < 0) break
    const skip = xml.startsWith('<!--', start) ? '-->' : xml.startsWith('<![CDATA[', start) ? ']]>' : xml.startsWith('<?', start) ? '?>' : undefined
    if (skip) { const end = xml.indexOf(skip, start + 2); if (end < 0) return []; at = end + skip.length; continue }
    let end = start + 1, quote = ''
    for (; end < xml.length; end++) {
      const char = xml[end]
      if (char === '<') return []
      if (quote) { if (char === quote) quote = '' }
      else if (char === '"' || char === "'") quote = char
      else if (char === '>') break
    }
    if (end === xml.length) return []
    at = end + 1
    const token = xml.slice(start, at)
    if (token.startsWith('</')) { const scope = stack.length > 1 ? stack.pop()! : undefined; if (scope?.location) scope.location.end = at; continue }
    const tag = /^<([^\s/>]+)/.exec(token)
    if (!tag) return []
    // Namespace inheritance does not copy an attacker-sized namespace map for every XML element.
    const parent = stack.at(-1)!, ns = Object.create(parent.ns) as Record<string, string>
    // Consume whole attributes: SQL text may itself contain strings like xmlns='foreign' or NodeId='0'.
    const attributes = /\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy
    attributes.lastIndex = tag[0].length
    let attribute: RegExpExecArray | null, nodeId: string | undefined
    while ((attribute = attributes.exec(token))) {
      const name = attribute[1], value = decodeAttribute(attribute[2] ?? attribute[3])
      if (name === 'xmlns') ns[''] = value
      else if (name.startsWith('xmlns:')) ns[name.slice(6)] = value
      else if (name === 'NodeId') nodeId = value
    }
    const name = tag[1].split(':'), local = name.at(-1)!, prefix = name.length > 1 ? name[0] : ''
    const scope: Scope = { ns, statement: parent.statement }
    if (ns[prefix] === namespace) {
      if (local.startsWith('Stmt')) {
        scope.statement = counts.length; counts.push(0)
        scope.location = { target: { statement: scope.statement }, start, end: at, openEnd: at }
      } else if (local === 'RelOp' && scope.statement >= 0) {
        scope.location = { target: { statement: scope.statement, operator: counts[scope.statement]++, nodeId }, start, end: at, openEnd: at }
      }
      if (scope.location) locations.push(scope.location)
      if (locations.length > planLimits.nodes + planLimits.statements) return []
    }
    if (!token.endsWith('/>')) stack.push(scope)
    if (stack.length > planLimits.depth * 8) return []
  }
  return locations
}
export function locateXml(xml: string, target: PlanXmlTarget): XmlLocation | undefined {
  return xmlLocations(xml).find(location => location.target.statement === target.statement && location.target.operator === target.operator
    && (target.nodeId === undefined || target.nodeId === location.target.nodeId))
}
export function targetAtXmlOffset(xml: string, offset: number): PlanXmlTarget | undefined {
  let found: XmlLocation | undefined
  for (const location of xmlLocations(xml)) if (location.start <= offset && offset < location.end && (!found || location.start >= found.start)) found = location
  return found?.target
}
