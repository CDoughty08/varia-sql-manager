// SQL Server Agent Properties (AG-8a): SSMS's General and History pages on the Agent node, a modal dialog. OK sends only the changed
// settings; History's Delete old history now runs apart from OK (ObjectDialogService.runInline) after its inline confirmation. Managed
// Instance and logins below sysadmin open it read-only, with Close. No React here (definitions.ts).
import {
  agentPropertiesChanges, cutoffParameter, draftLimits, draftPurge, initialAgentPropertiesDraft, purgeCutoff, sizesTouched, type AgentPropertiesDraft, type AgentPropertiesModel,
  type AgentPropertiesRequest
} from '../../../shared/actions/agent-properties.ts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import type { BuiltRequest, ObjectDialogDefinition } from './definitions'

/** The purge request History's confirmation sends, with the cut-off it showed (`before`, from the server's clock as `clock` gives it), or
 *  undefined while its count is not one it can send. */
export function agentPurgeRequest(target: ObjectRef, draft: AgentPropertiesDraft, clock: string): Omit<AgentPropertiesRequest, 'connectionId' | 'requestId'> | undefined {
  const purge = draftPurge(draft)
  if ('problem' in purge) return undefined
  const cutoff = purgeCutoff(clock, purge)
  return { action: 'agentProperties', target, agentPurge: cutoff ? { ...purge, before: cutoffParameter(cutoff) } : purge }
}

export const agentPropertiesDefinition: ObjectDialogDefinition<AgentPropertiesModel, AgentPropertiesDraft> = {
  dialog: 'agentProperties',
  // Stamped as it arrives, so the purge's cut-off follows the server's clock while the dialog stays open (serverClock).
  modelOf: result => result.agentProperties && { ...result.agentProperties, readAt: Date.now() },
  initialDraft: model => initialAgentPropertiesDraft(model),
  // Nothing changed (or nothing may change): OK closes and Script says there is no action to be scripted, as SSMS does.
  request: (target, model, draft) => {
    if (model.readOnly || model.settingsNote) return undefined
    const changes = agentPropertiesChanges(model, draft)
    if (!changes) return undefined
    if ('problem' in changes) return { problem: changes.problem }
    return { action: 'agentProperties', target, agentProperties: changes } as BuiltRequest
  },
  blocked: (model, draft) => {
    if (model.readOnly || model.settingsNote || !sizesTouched(model, draft)) return undefined
    const limits = draftLimits(draft)
    return 'problem' in limits ? limits.problem : undefined
  },
  readOnly: model => model.readOnly,
  fileName: () => 'SQL Server Agent Properties.sql',
  // Nothing Object Explorer lists changes.
  afterSuccess: () => {}
}
