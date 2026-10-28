import { environmentTag } from '../../shared/environments'
import StatusPill from './kit/StatusPill'

interface Props {
  /** The connection's environment label; nothing renders without one. */
  readonly environment: string | undefined
  /** Where it sits, for styling: the tag keeps the kit's look and only its spacing changes. */
  readonly place: 'explorer' | 'tab' | 'query' | 'queryStatus' | 'status' | 'list'
  /** What it labels, where nothing beside it says so: the tooltip reads "${about}: Production environment". */
  readonly about?: string
}

/**
 * A connection's environment as the kit's small square tag: PROD in the critical tone, STAGING in the info tone, and
 * the others neutral. The word carries it, so it reads in forced colours and without colour; the tooltip names it in
 * full. Where the tag sits inside a control with its own accessible name, that name or description says it too.
 */
export default function EnvironmentTag({ environment, place, about }: Props) {
  const tag = environmentTag(environment)
  if (!tag) return null
  return <span className="environment-tag" data-place={place} data-tone={tag.tone}>
    <StatusPill variant="tag" size="small" tone={tag.tone} label={tag.text} title={about ? `${about}: ${tag.description}` : tag.description} />
  </span>
}
