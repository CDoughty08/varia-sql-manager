/** Types for the smoke suites' reader of the fake backend's call log. */
export function completeLines(text: string): string[]
export function parseCalls(text: string): { generation: number; method: string; params?: any }[]
