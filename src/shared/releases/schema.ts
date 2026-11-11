import { z } from 'zod'

export const releaseVersionSchema = z.string().max(64).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
const prose = (max: number) => z.string().trim().min(1).max(max).refine(text => !/[\u0000-\u001f\u007f]/.test(text) && !/<\/?[a-z][^>]*>/i.test(text), 'Use a single paragraph of plain text, without HTML.')
export const releaseCategories = { added: 'New and improved', changed: 'Changes to everyday use', fixed: 'Fixes', limits: 'Things to know' } as const
export type ReleaseCategory = keyof typeof releaseCategories
export const releaseNoteSchema = z.strictObject({ category: z.enum(['added', 'changed', 'fixed', 'limits']), title: prose(120), text: prose(1600) })
export const releaseNotesSchema = z.strictObject({
  schema: z.literal(1), version: releaseVersionSchema, releasedOn: z.iso.date(), summary: prose(500), changes: z.array(releaseNoteSchema).min(1).max(64)
}).superRefine((record, context) => {
  const titles = new Set<string>()
  for (const [index, change] of record.changes.entries()) {
    const key = `${change.category}:${change.title}`
    if (titles.has(key)) context.addIssue({ code: 'custom', path: ['changes', index, 'title'], message: 'Duplicate change title in this category.' })
    titles.add(key)
  }
})
export type ReleaseNotes = z.infer<typeof releaseNotesSchema>

/** Markdown is an export only. The app renders the validated fields as text through React. */
const markdownText = (text: string): string => text.replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, '\\$&')
export function releaseNotesMarkdown(record: ReleaseNotes, style: 'release' | 'changelog' = 'release'): string {
  const lines = style === 'release' ? [`# Varia SQL Manager ${record.version}`, '', `Released ${record.releasedOn}`] : [`## [${record.version}] - ${record.releasedOn}`]
  lines.push('', markdownText(record.summary))
  for (const [category, title] of Object.entries(releaseCategories)) {
    const changes = record.changes.filter(change => change.category === category)
    if (changes.length) lines.push('', `${style === 'release' ? '##' : '###'} ${title}`, '', ...changes.map(change => `- **${markdownText(change.title)}:** ${markdownText(change.text)}`))
  }
  return lines.join('\n') + '\n'
}
