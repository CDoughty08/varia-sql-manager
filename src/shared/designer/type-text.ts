// The Data Type cell's text: "nvarchar(50)", "nvarchar(MAX)", "decimal(18, 0)", "int". Parsing accepts any case, spaces
// around the parameters and a bare name (the type's defaults); formatting writes SSMS's form: the name lowercase, MAX
// uppercase, and ", " between precision and scale (not verified).
import { typeBounds, typeSpec, type SystemTypeSpec } from './catalog.ts'

/** A column's type: a system type from the catalogue with the parameters its kind takes. */
export interface DesignType {
  readonly system: string
  readonly length?: number
  readonly max?: boolean
  readonly precision?: number
  readonly scale?: number
  readonly dimensions?: number
}

/** The type a bare name means: its catalogue defaults. */
export function defaultType(spec: SystemTypeSpec): DesignType {
  switch (spec.params) {
    case 'length': case 'nlength': return { system: spec.name, length: spec.length }
    case 'precisionScale': return { system: spec.name, precision: spec.precision, scale: spec.scale }
    case 'scale': return { system: spec.name, scale: spec.scale }
    case 'dimensions': return { system: spec.name, dimensions: spec.dimensions }
    default: return { system: spec.name }
  }
}

export function formatTypeText(type: DesignType): string {
  const spec = typeSpec(type.system)
  switch (spec?.params) {
    case 'length': case 'nlength': return `${type.system}(${type.max ? 'MAX' : type.length})`
    case 'precisionScale': return `${type.system}(${type.precision}, ${type.scale})`
    case 'scale': return `${type.system}(${type.scale})`
    case 'dimensions': return `${type.system}(${type.dimensions})`
    default: return type.system
  }
}

const integer = /^\d{1,6}$/
/** Why a type cannot be used at version band `band` (17 = SQL Server 2025), or undefined when it can. */
export function typeProblem(type: DesignType, band = Number.POSITIVE_INFINITY): string | undefined {
  const spec = typeSpec(type.system)
  if (!spec) return `${type.system} is not a data type the table designer offers.`
  if (spec.since !== undefined && band < spec.since) return `${spec.name} needs SQL Server 2025 or later.`
  const extra = (keys: readonly (keyof DesignType)[]) => (['length', 'max', 'precision', 'scale', 'dimensions'] as const).some(key => !keys.includes(key) && type[key] !== undefined)
  const whole = (value: number | undefined, min: number, max: number) => value !== undefined && Number.isInteger(value) && value >= min && value <= max
  switch (spec.params) {
    case 'none':
      return extra([]) ? `${spec.name} takes no length, precision or scale.` : undefined
    case 'length': case 'nlength': {
      if (extra(['length', 'max'])) return `${spec.name} takes only a length.`
      if (type.max) return spec.max && type.length === undefined ? undefined : `${spec.name} cannot be (MAX).`
      return whole(type.length, typeBounds.length.min, spec.maxLength ?? 0) ? undefined : `The length of ${spec.name} is 1 to ${spec.maxLength}${spec.max ? ', or MAX' : ''}.`
    }
    case 'precisionScale':
      if (extra(['precision', 'scale'])) return `${spec.name} takes only a precision and a scale.`
      if (!whole(type.precision, typeBounds.precision.min, typeBounds.precision.max)) return `The precision of ${spec.name} is 1 to 38.`
      return whole(type.scale, 0, type.precision ?? 0) ? undefined : `The scale of ${spec.name} is 0 to its precision (${type.precision}).`
    case 'scale':
      if (extra(['scale'])) return `${spec.name} takes only a scale.`
      return whole(type.scale, typeBounds.scale.min, typeBounds.scale.max) ? undefined : `The scale of ${spec.name} is 0 to 7.`
    case 'dimensions':
      if (extra(['dimensions'])) return `${spec.name} takes only its dimensions.`
      return whole(type.dimensions, typeBounds.dimensions.min, typeBounds.dimensions.max) ? undefined : `A vector has 1 to ${typeBounds.dimensions.max} dimensions.`
  }
}

/** The type the text names, or why it names none. `band` gates json and vector. */
export function parseTypeText(text: string, band = Number.POSITIVE_INFINITY): { readonly type: DesignType } | { readonly problem: string } {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*([^,()]*?)\s*(?:,\s*([^,()]*?)\s*)?\))?\s*$/.exec(text)
  if (!match) return { problem: `"${text.trim()}" is not a data type.` }
  const name = match[1].toLowerCase(), first = match[2], second = match[3]
  const spec = typeSpec(name)
  if (!spec) return { problem: `${match[1]} is not a data type the table designer offers.` }
  let type: DesignType
  const number = (value: string) => integer.test(value) ? Number(value) : Number.NaN
  if (first === undefined) type = defaultType(spec)
  else if (spec.params === 'none') return { problem: `${spec.name} takes no length, precision or scale.` }
  else if (spec.params === 'precisionScale') type = { system: spec.name, precision: number(first), scale: second === undefined ? 0 : number(second) }
  else if (second !== undefined) return { problem: `${spec.name} takes one parameter.` }
  else if (spec.params === 'length' || spec.params === 'nlength') type = first.toLowerCase() === 'max' ? { system: spec.name, max: true } : { system: spec.name, length: number(first) }
  else if (spec.params === 'scale') type = { system: spec.name, scale: number(first) }
  else type = { system: spec.name, dimensions: number(first) }
  const problem = typeProblem(type, band)
  return problem ? { problem } : { type }
}

/** Stored off-row, so the table gets TEXTIMAGE_ON: text, ntext, image, xml, json, geography, geometry and the (MAX) forms. */
export const isLobType = (type: DesignType): boolean => !!typeSpec(type.system)?.lob || !!type.max
/** Whether an identity column may have the type: the integer types, and decimal or numeric with scale 0. */
export const identityAllowed = (type: DesignType): boolean => !!typeSpec(type.system)?.identity && (type.scale ?? 0) === 0
