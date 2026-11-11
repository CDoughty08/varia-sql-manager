import { z } from 'zod'
import { updateRepository } from './updates'

export const productName = 'Varia SQL Manager'
export const productDescription = 'A focused workspace for SQL Server.'

const repositoryUrl = `https://github.com/${updateRepository.owner}/${updateRepository.repo}`
const productLinks = { project: repositoryUrl, issues: `${repositoryUrl}/issues/new` } as const
export const productLinkSchema = z.enum(['project', 'issues'])
export type ProductLink = z.infer<typeof productLinkSchema>

/** Main chooses the destination; the renderer can name only one of these product links. */
export function productLinkUrl(value: unknown): string { return productLinks[productLinkSchema.parse(value)] }
