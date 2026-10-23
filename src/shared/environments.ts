import { z } from 'zod'
import type { StatusTone } from './theme/tones'

/**
 * A saved connection's environment: absent for None, one of the presets, or a custom label. It is stored with the
 * profile in connections.json and goes to the backend with the other options, which bounds it again and ignores it. It
 * labels the server; the connection colour still marks it, and neither replaces the other.
 */
export const environmentPresets = ['Production', 'Staging', 'Test', 'Development'] as const
export type EnvironmentPreset = typeof environmentPresets[number]
export const maxEnvironmentLength = 32
// Control, format and line separator characters could hide or reorder what the tag shows, or break the line it sits on.
const hidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
export const environmentSchema = z.string().trim().min(1, 'Enter an environment label.').max(maxEnvironmentLength, `An environment label has at most ${maxEnvironmentLength} characters.`)
  .refine(value => !hidden.test(value), 'An environment label cannot contain control or formatting characters.')

/** The preset a label names, in any letter case; undefined for a custom label. */
export function environmentPreset(label: string | undefined): EnvironmentPreset | undefined {
  const folded = label?.trim().toLowerCase()
  return folded ? environmentPresets.find(preset => preset.toLowerCase() === folded) : undefined
}

const tones: Readonly<Record<EnvironmentPreset, StatusTone>> = { Production: 'critical', Staging: 'info', Test: 'neutral', Development: 'neutral' }
const tags: Readonly<Record<EnvironmentPreset, string>> = { Production: 'PROD', Staging: 'STAGING', Test: 'TEST', Development: 'DEV' }

/** What the tag shows on a server node, a document tab and the status bars. */
export interface EnvironmentTagModel {
  readonly tone: StatusTone
  /** The short word: PROD, STAGING, TEST, DEV, or a custom label as typed. */
  readonly text: string
  /** The full name, for the tooltip and screen readers: "Production environment". */
  readonly description: string
}
/** Production is the red (critical) tag; Staging informs; Test, Development and custom labels carry no state colour. */
export function environmentTag(label: string | undefined): EnvironmentTagModel | undefined {
  const text = label?.trim()
  if (!text) return undefined
  const preset = environmentPreset(text)
  return preset ? { tone: tones[preset], text: tags[preset], description: `${preset} environment` } : { tone: 'neutral', text, description: `${text} environment` }
}
