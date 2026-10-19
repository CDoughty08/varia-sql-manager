// Tools › Options definitions. Erasable TypeScript, like the command catalogue: only type imports from ../commands.
import type { Platform } from '../commands/keybindings'

/** When a changed value takes effect; the description pane says so for anything but 'immediately'. */
export type SettingApplies = 'immediately' | 'nextExecution' | 'newConnections'

interface SettingBase {
  /** A dotted id: `^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){1,4}$`, at most 96 characters. */
  readonly key: string
  /** The page id (`settingPages`) whose rows show it. */
  readonly page: string
  /** A category label inside the page. */
  readonly group?: string
  /** SSMS's wording. */
  readonly label: string
  /** For the description pane and docs/settings.md. */
  readonly description: string
  /** Extra search terms. */
  readonly keywords?: readonly string[]
  /** SSMS's default where Varia's differs: a value of the setting's type, or text where SSMS's cannot be one. */
  readonly ssmsDefault?: boolean | number | string
  /** Not in SSMS: placed on the nearest SSMS page and marked "Not in SSMS". */
  readonly varia?: true
  /** Shown only on these platforms; the value is still validated and kept everywhere. */
  readonly platforms?: readonly Platform[]
  /** A boolean setting on the same page: the row is greyed while it is True. */
  readonly disabledWhen?: string
  /** A boolean setting on the same page: the row is greyed while it is False. */
  readonly enabledBy?: string
  /** Validated, persisted and documented, but not rendered or searched in Options (a menu toggle SSMS has no row for). */
  readonly hidden?: true
  /** The default is 'immediately'. */
  readonly applies?: SettingApplies
}
export interface BooleanSettingDef extends SettingBase {
  readonly type: 'boolean'
  readonly default: boolean
}
export interface IntegerSettingDef extends SettingBase {
  readonly type: 'integer'
  readonly min: number
  readonly max: number
  readonly default: number
  /** Shown after the input, such as 'seconds' or 'px'. */
  readonly unit?: string
}
export interface EnumSettingDef extends SettingBase {
  readonly type: 'enum'
  readonly values: readonly { readonly value: string; readonly label: string }[]
  readonly default: string
  readonly presentation?: 'select' | 'radio'
}
export type SettingDef = BooleanSettingDef | IntegerSettingDef | EnumSettingDef

/**
 * A node of the Options tree. One without a layout is a category: selecting it shows its first child page. A page with
 * a provider shows the provider's rows first, then its catalogue settings.
 */
export interface SettingPage {
  readonly id: string
  readonly title: string
  readonly parent?: string
  readonly layout?: 'form' | 'propertyGrid' | 'keyboard'
  readonly provider?: 'theme'
  /** Shown in the description pane while no row is focused, and in docs/settings.md. */
  readonly description?: string
}
