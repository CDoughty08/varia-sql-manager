// SQL Server Agent's sessions in the Activity Monitor (AG-16): what a session's program_name says about the Agent job step
// it runs, and how a job link reads. The pattern is the catalogue's (agentProgram), which the backend embeds, so the
// backend's parser (Activity/AgentJobNames.cs) and this one agree; the backend resolves the names, the renderer reads the
// job id and step from a row's Application for Open Job, Stop Job and Details. Erasable TypeScript, as the catalogue.
import { agentProgram } from './catalog.ts'

/** A job step's session: the job's id as SQL Server shows a uniqueidentifier (upper case, hyphenated) and the step's id. */
export interface AgentJobStep {
  readonly kind: 'jobStep'
  /** The words before the job, as Agent writes them ("TSQL JobStep"). */
  readonly task: string
  readonly jobId: string
  readonly step: number
}
/** One of Agent's own threads (Generic Refresher, Job invocation engine, Email Logger, …): no job to link to. */
export interface AgentThread { readonly kind: 'agent'; readonly task: string }
export type AgentProgram = AgentJobStep | AgentThread

const stepPattern = new RegExp(agentProgram.step)
/** The longest program_name SQL Server keeps (sys.dm_exec_sessions.program_name is nvarchar(128)). */
const programChars = 128
const maxStep = 2_147_483_647

/** The job id's 16 bytes, in the order SQL Server stores a uniqueidentifier, as its text: the first three groups are
 *  little-endian, the last two as stored. */
export function agentJobIdFromHex(hex: string): string | undefined {
  if (!/^[0-9A-Fa-f]{32}$/.test(hex)) return undefined
  const bytes = hex.toUpperCase().match(/../g)!
  const group = (from: number, to: number, reverse: boolean) => { const part = bytes.slice(from, to); return (reverse ? part.reverse() : part).join('') }
  return [group(0, 4, true), group(4, 6, true), group(6, 8, true), group(8, 10, false), group(10, 16, false)].join('-')
}

/** What a session's program_name says about SQL Server Agent; undefined for any other program (or a malformed Agent one). */
export function parseAgentProgram(program: string | null | undefined): AgentProgram | undefined {
  if (typeof program !== 'string' || program.length > programChars || !program.startsWith(agentProgram.prefix)) return undefined
  const match = stepPattern.exec(program)
  if (match?.groups) {
    const jobId = agentJobIdFromHex(match.groups.job!)
    const step = Number(match.groups.step)
    if (!jobId || !Number.isSafeInteger(step) || step < 1 || step > maxStep) return undefined
    return { kind: 'jobStep', task: match.groups.task!, jobId, step }
  }
  // A job step that did not match is malformed, not one of Agent's threads.
  if (program.includes('(Job ')) return undefined
  const task = program.slice(agentProgram.prefix.length).trim()
  return task && !/[()]/.test(task) ? { kind: 'agent', task } : undefined
}

/** A job link's words: "Nightly, step 2 (Load)", or the decoded id where msdb named no job to the login ("Job 8A1B…, step 2").
 *  The backend writes the same words into the Agent Job column. */
export function agentJobText(job: { readonly jobId: string; readonly step: number; readonly name?: string | null; readonly stepName?: string | null }): string {
  if (!job.name) return `Job ${job.jobId}, step ${job.step}`
  return `${job.name}, step ${job.step}${job.stepName ? ` (${job.stepName})` : ''}`
}
