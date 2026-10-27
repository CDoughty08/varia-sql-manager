import { codiconClass, iconSpec, iconStroke, type CodiconId, type IconId } from '../../shared/icons'

/**
 * An icon from the registry (src/shared/icons.ts): Varia's stroke icons as inline SVG, codicons as the font's glyph.
 * `data-icon` names it for tests. Without a label it is decoration; with one it is an image of that name. A string that
 * is no icon (a node from a newer backend) keeps a glyph's slot and draws nothing.
 */
export default function Icon({ name, className, label, spin }: { name: IconId; className?: string; label?: string; spin?: boolean }) {
  const spec = iconSpec(name)
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const }
  if (spec?.source === 'svg') {
    return <svg className={className ? `icon ${className}` : 'icon'} data-icon={name} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round"
      strokeLinejoin="round" {...a11y}><path d={spec.path} /></svg>
  }
  const glyph = spec ? codiconClass(name as CodiconId) : 'codicon'
  return <span className={`${glyph}${spin ? ' codicon-modifier-spin' : ''}${className ? ' ' + className : ''}`} data-icon={name} {...a11y} />
}
