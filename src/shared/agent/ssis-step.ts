// The SSIS package step's command (AG-6b, docs/agent-plan.md › SSIS steps, docs/agent-ui-rethink.md › rx-step-ssis): the dtexec command line
// SSMS writes for a package in the SSIS Catalog, read into fields and written back in SSMS's order, and the step's parameter rows with
// where each value comes from. A command Varia cannot read field by field (another package source, a switch it does not know) is kept as
// text. Pure; no React.
import type { SsisParameter } from '../ssis/schema.ts'

/** A parameter value the step sets (`/Par`): a project's (`$Project::`), the package's (no prefix, or `$Package::`), or a connection
 *  manager's property (`CM.<name>.<property>`). `type` is the `(Int32)` suffix when the command carried one. */
export interface SsisStepParameter { readonly scope: 'project' | 'package' | 'connection'; readonly name: string; readonly type?: string; readonly value: string }
export interface SsisStepCommand {
  readonly folder: string
  readonly project: string
  readonly package: string
  readonly server: string
  /** The project's environment reference (`/ENVREFERENCE`, catalog.environment_references.reference_id). */
  readonly environmentReference?: number
  /** Runtime 32-bit (`/X86`). */
  readonly x86: boolean
  readonly parameters: readonly SsisStepParameter[]
  /** `$ServerOption::LOGGING_LEVEL`: 0 None, 1 Basic, 2 Performance, 3 Verbose, 4 Runtime lineage. Absent: the catalog's default. */
  readonly loggingLevel?: number
  /** `$ServerOption::DUMP_ON_ERROR`. */
  readonly dumpOnError?: boolean
  /** Other `/Par $ServerOption::` and `/Set` tokens, kept as written (the Advanced fold counts them as property overrides). */
  readonly extra: readonly string[]
}
export const ssisLoggingLevels: readonly { readonly code: number; readonly label: string }[] = [
  { code: 0, label: 'None' }, { code: 1, label: 'Basic' }, { code: 2, label: 'Performance' }, { code: 3, label: 'Verbose' }, { code: 4, label: 'Runtime lineage' }
]

/** dtexec's tokens: split at spaces outside quotes, where `\"` inside quotes is a quote. */
function tokens(command: string): string[] | undefined {
  const out: string[] = []
  let current = '', quoted = false, started = false
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!
    if (quoted && char === '\\' && command[at + 1] === '"') { current += '\\"'; at++; continue }
    if (char === '"') { quoted = !quoted; current += char; started = true; continue }
    if (!quoted && /\s/.test(char)) { if (started) out.push(current); current = ''; started = false; continue }
    current += char
    started = true
  }
  if (quoted) return undefined
  if (started) out.push(current)
  return out
}
/** A quoted dtexec value as text: `"\"x y\""` → `x y`, `stg` → `stg`. */
function unquote(value: string): string {
  let text = value
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).replace(/\\"/g, '"')
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1)
  return text
}
/** `x` as SSMS writes a value: bare when it has no space, quote or semicolon, else `"\"x\""`. */
const quoteValue = (value: string) => value !== '' && !/[\s";]/.test(value) ? value : `"\\"${value.replace(/"/g, '\\"')}\\""`
/** A name or path as SSMS writes it: always `"\"x\""`. */
const quoteName = (value: string) => `"\\"${value}\\""`

/** Splits `"\"name\"";value` at the first semicolon outside quotes. */
function splitPar(token: string): [string, string] | undefined {
  let quoted = false
  for (let at = 0; at < token.length; at++) {
    const char = token[at]!
    if (quoted && char === '\\' && token[at + 1] === '"') { at++; continue }
    if (char === '"') quoted = !quoted
    else if (char === ';' && !quoted) return [token.slice(0, at), token.slice(at + 1)]
  }
  return undefined
}

/** The command's fields, or undefined when Varia cannot lay it out (not an SSIS Catalog package, an unknown switch, unbalanced quotes). */
export function parseSsisCommand(command: string): SsisStepCommand | undefined {
  const parts = tokens(command.trim())
  if (!parts || parts[0]?.toUpperCase() !== '/ISSERVER' || parts.length < 2) return undefined
  const path = unquote(parts[1]!)
  const match = /^\\SSISDB\\([^\\]+)\\([^\\]+)\\([^\\]+\.dtsx)$/i.exec(path)
  if (!match) return undefined
  let server = '', environmentReference: number | undefined, x86 = false, loggingLevel: number | undefined, dumpOnError: boolean | undefined, caller = false, reporting = false
  const parameters: SsisStepParameter[] = [], extra: string[] = []
  for (let at = 2; at < parts.length; at++) {
    const option = parts[at]!.toUpperCase(), next = parts[at + 1]
    if (option === '/SERVER' && next !== undefined) { server = unquote(next); at++ }
    else if (option === '/ENVREFERENCE' && next !== undefined && /^[0-9]{1,18}$/.test(next)) { environmentReference = Number(next); at++ }
    else if (option === '/X86') x86 = true
    else if (option === '/CALLERINFO' && next?.toUpperCase() === 'SQLAGENT') { caller = true; at++ }
    else if (option === '/REPORTING' && next !== undefined) { if (next.toUpperCase() !== 'E') return undefined; reporting = true; at++ }
    else if (option === '/SET' && next !== undefined) { extra.push(`${parts[at]} ${next}`); at++ }
    else if (option === '/PAR' && next !== undefined) {
      at++
      const split = splitPar(next)
      if (!split) return undefined
      const [rawName, rawValue] = split
      const name = unquote(rawName), value = unquote(rawValue)
      const typed = /^(.*?)(?:\(([A-Za-z0-9]+)\))?$/.exec(name)!
      const bare = typed[1]!, type = typed[2]
      if (/^\$ServerOption::/i.test(bare)) {
        const optionName = bare.slice('$ServerOption::'.length).toUpperCase()
        if (optionName === 'SYNCHRONIZED') continue
        if (optionName === 'LOGGING_LEVEL' && /^[0-4]$/.test(value)) { loggingLevel = Number(value); continue }
        if (optionName === 'DUMP_ON_ERROR' && /^(true|false)$/i.test(value)) { dumpOnError = /^true$/i.test(value); continue }
        extra.push(`/Par ${next}`)
        continue
      }
      const scope = /^\$Project::/i.test(bare) ? 'project' : /^CM\./i.test(bare) ? 'connection' : 'package'
      const short = bare.replace(/^\$(Project|Package)::/i, '')
      parameters.push({ scope, name: short, ...type ? { type } : {}, value })
    }
    else return undefined
  }
  if (!caller || !reporting) return undefined
  return { folder: match[1]!, project: match[2]!, package: match[3]!, server, ...environmentReference !== undefined ? { environmentReference } : {}, x86, parameters, ...loggingLevel !== undefined ? { loggingLevel } : {}, ...dumpOnError !== undefined ? { dumpOnError } : {}, extra }
}

/** The command SSMS writes for `step`: package path, server, environment, parameters, server options, then 32-bit and the caller. */
export function buildSsisCommand(step: SsisStepCommand): string {
  const parts = [`/ISSERVER ${quoteName(`\\SSISDB\\${step.folder}\\${step.project}\\${step.package}`)}`, `/SERVER ${quoteName(step.server)}`]
  if (step.environmentReference !== undefined) parts.push(`/ENVREFERENCE ${step.environmentReference}`)
  for (const parameter of step.parameters) {
    const name = (parameter.scope === 'project' ? '$Project::' : '') + parameter.name + (parameter.type ? `(${parameter.type})` : '')
    parts.push(`/Par ${quoteName(name)};${quoteValue(parameter.value)}`)
  }
  if (step.loggingLevel !== undefined) parts.push(`/Par ${quoteName('$ServerOption::LOGGING_LEVEL(Int16)')};${step.loggingLevel}`)
  if (step.dumpOnError !== undefined) parts.push(`/Par ${quoteName('$ServerOption::DUMP_ON_ERROR(Boolean)')};${step.dumpOnError ? 'True' : 'False'}`)
  parts.push(`/Par ${quoteName('$ServerOption::SYNCHRONIZED(Boolean)')};True`)
  parts.push(...step.extra)
  if (step.x86) parts.push('/X86')
  parts.push('/CALLERINFO SQLAGENT /REPORTING E')
  return parts.join(' ')
}

/** A new SSIS Catalog step's command for a picked package, on `server`. */
export const newSsisCommand = (server: string, folder: string, project: string, packageName: string): SsisStepCommand =>
  ({ folder, project, package: packageName, server, x86: false, parameters: [], extra: [] })

/** The package path the step runs, as the "Runs" line shows it. */
export const ssisPackagePath = (step: Pick<SsisStepCommand, 'folder' | 'project' | 'package'>) => `\\SSISDB\\${step.folder}\\${step.project}\\${step.package}`

/** Where a parameter's value comes from when the step runs. */
export type SsisValueSource = 'step' | 'environment' | 'catalog' | 'default' | 'none'
export interface SsisParameterRow {
  readonly scope: 'project' | 'package'
  readonly name: string
  readonly dataType: string
  readonly required: boolean
  readonly sensitive: boolean
  readonly description?: string
  /** The value it runs with (the variable's name for an environment variable); absent for none and for a sensitive value. */
  readonly value?: string
  readonly source: SsisValueSource
}
export const ssisSourceLabel: { readonly [S in SsisValueSource]: string } = {
  step: 'Edited in this step', environment: 'Environment variable', catalog: 'Configured in the catalog', default: 'Package default', none: 'No value'
}
/** The step's parameters, project's then package's, each with the value it runs with and where that comes from: the step's own `/Par`,
 *  else the catalog's configuration (an environment variable needs an environment reference), else the package's default. A required
 *  parameter has no default: without the step or the catalog it has no value. */
export function ssisParameterRows(command: SsisStepCommand, project: readonly SsisParameter[], packageParameters: readonly SsisParameter[]): SsisParameterRow[] {
  const row = (scope: 'project' | 'package', parameter: SsisParameter): SsisParameterRow => {
    const own = command.parameters.find(item => item.scope === scope && item.name.toLowerCase() === parameter.name.toLowerCase())
    const base = { scope, name: parameter.name, dataType: parameter.dataType, required: parameter.required, sensitive: parameter.sensitive, ...parameter.description ? { description: parameter.description } : {} }
    if (own) return { ...base, value: own.value, source: 'step' }
    if (parameter.valueSet && parameter.valueType === 'R' && command.environmentReference !== undefined) return { ...base, ...parameter.variable ? { value: parameter.variable } : {}, source: 'environment' }
    if (parameter.valueSet && parameter.valueType === 'V') return { ...base, ...parameter.value !== undefined && !parameter.sensitive ? { value: parameter.value } : {}, source: 'catalog' }
    if (!parameter.required && parameter.designDefault !== undefined) return { ...base, ...parameter.sensitive ? {} : { value: parameter.designDefault }, source: 'default' }
    return { ...base, source: 'none' }
  }
  return [...project.map(parameter => row('project', parameter)), ...packageParameters.map(parameter => row('package', parameter))]
}
/** The SSIS problems on a step (rx-step-ssis): each required parameter without a value. A warning; msdb does not check it either. */
export function ssisProblems(rows: readonly SsisParameterRow[]): string[] {
  return rows.filter(row => row.required && row.source === 'none').map(row => `${row.name} is required and has no value.`)
}
/** The step's command with `name` set to `value` (undefined: the step no longer sets it, so the catalog's or the default applies). */
export function withSsisParameter(command: SsisStepCommand, scope: 'project' | 'package', name: string, value: string | undefined, dataType?: string): SsisStepCommand {
  const others = command.parameters.filter(item => !(item.scope === scope && item.name.toLowerCase() === name.toLowerCase()))
  const type = dataType ? ssisParameterType(dataType) : undefined
  return { ...command, parameters: value === undefined ? others : [...others, { scope, name, ...type ? { type } : {}, value }] }
}
/** The `(Type)` suffix SSMS writes for a catalog data type. */
function ssisParameterType(dataType: string): string | undefined {
  const types: Record<string, string> = { Boolean: 'Boolean', Byte: 'Byte', DateTime: 'DateTime', Decimal: 'Decimal', Double: 'Double', Int16: 'Int16', Int32: 'Int32', Int64: 'Int64', SByte: 'SByte', Single: 'Single', String: '', UInt32: 'UInt32', UInt64: 'UInt64' }
  const found = Object.keys(types).find(key => key.toLowerCase() === dataType.toLowerCase())
  return found ? types[found] || undefined : undefined
}
/** The Advanced fold's one line: logging level, dump on errors, property overrides. */
export function ssisAdvancedSummary(command: SsisStepCommand): string {
  const level = command.loggingLevel === undefined ? 'catalog default logging' : `Logging level ${ssisLoggingLevels.find(item => item.code === command.loggingLevel)?.label ?? command.loggingLevel}`
  const overrides = command.extra.length
  return [level, command.dumpOnError ? 'dump on errors' : 'no dump on errors', overrides ? `${overrides} property ${overrides === 1 ? 'override' : 'overrides'}` : 'no property overrides'].join(' · ')
}
