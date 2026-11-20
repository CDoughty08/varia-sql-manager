// The release gate (docs/agent-plan.md › Coordination with BigQuery): SQL Server Agent's surfaces stay hidden until 0.11.0
// unless main was started with VARIA_AGENT_PREVIEW=1. Main reads the variable once and passes the preload a renderer
// argument, which becomes the static context key `agentEnabled`; AG-9 removes the gate.

/** The renderer argument (`webPreferences.additionalArguments`) that says the gate is open. */
export const agentPreviewArgument = '--varia-agent-preview'
/** Main's reading of the environment: exactly '1' opens the gate. */
export const agentPreviewEnabled = (env: Readonly<Record<string, string | undefined>>): boolean => env.VARIA_AGENT_PREVIEW === '1'
/** The preload's reading of main's arguments. */
export const agentPreviewFromArgv = (argv: readonly string[]): boolean => argv.includes(agentPreviewArgument)
