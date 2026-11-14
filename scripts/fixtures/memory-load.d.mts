import type { Page } from '@playwright/test'

export const lowMemoryText: RegExp
export function lowMemoryStop(what: string): string
export function stopIfLowMemory(page: Page, what: string): Promise<void>
