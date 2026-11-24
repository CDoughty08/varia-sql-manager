// The Integration Services document's places and history: one document per connection drills in place from the catalog's
// operations (the list) to a package's runs and one run's page, and Back and Forward (Alt+Left and Alt+Right, the mouse's
// back and forward buttons, the header's arrows) walk every place visited. Each place keeps what the user chose there (the run
// page's event chips and task), so Back shows it as it was left. Pure and erasable TypeScript, shared by the service and tests.

/** The catalog's operations (SSMS's All Executions, All Validations and All Operations in one live list). */
export interface SsisListPlace { readonly kind: 'list'; readonly key: string }
/** One package's runs. */
export interface SsisPackagePlace { readonly kind: 'package'; readonly key: string; readonly folder: string; readonly project: string; readonly package: string }
/** One run's page: `types` are the event chips chosen (absent: All), `source` the task the timeline filters to, `view` Details
 *  in place of Messages. */
export interface SsisExecutionPlace { readonly kind: 'execution'; readonly key: string; readonly executionId: number; readonly types?: readonly number[]; readonly source?: string; readonly view?: 'details' }
export type SsisPlace = SsisListPlace | SsisPackagePlace | SsisExecutionPlace
/** A place before the history gives it its key. */
export type SsisPlaceTarget = Omit<SsisListPlace, 'key'> | Omit<SsisPackagePlace, 'key'> | Omit<SsisExecutionPlace, 'key'>

/** The places visited, oldest first, and the one shown. */
export interface SsisTrail { readonly places: readonly SsisPlace[]; readonly at: number }

export const navigationLimits = {
  /** Places one document remembers; past it the oldest are forgotten. */
  places: 50,
  /** Places either side of the shown one that keep what they read, so Back and Forward show them at once; farther ones read again. */
  kept: 3
} as const

/** A new document's history: the list alone. */
export const startTrail = (key: string): SsisTrail => ({ places: [{ kind: 'list', key }], at: 0 })
export const currentPlace = (trail: SsisTrail): SsisPlace => trail.places[trail.at]!
export const canGoBack = (trail: SsisTrail): boolean => trail.at > 0
export const canGoForward = (trail: SsisTrail): boolean => trail.at < trail.places.length - 1

/** Whether a target is the place already shown (opening it again stays put rather than adding a step). */
export function samePlace(place: SsisPlace, target: SsisPlaceTarget): boolean {
  if (place.kind !== target.kind) return false
  if (place.kind === 'package' && target.kind === 'package') return place.folder === target.folder && place.project === target.project && place.package === target.package
  if (place.kind === 'execution' && target.kind === 'execution') return place.executionId === target.executionId
  return true
}

/**
 * The history after going to a place: the steps ahead of the shown one are dropped (as a browser's are), the place is added and
 * shown, and the oldest are forgotten past the limit. `dropped` names the keys no longer in the history, whose reads can go.
 */
export function pushPlace(trail: SsisTrail, target: SsisPlaceTarget, key: string): { readonly trail: SsisTrail; readonly dropped: readonly string[] } {
  if (samePlace(currentPlace(trail), target)) return { trail, dropped: [] }
  const kept = trail.places.slice(0, trail.at + 1)
  const ahead = trail.places.slice(trail.at + 1)
  const places = [...kept, { ...target, key } as SsisPlace]
  const over = Math.max(0, places.length - navigationLimits.places)
  return { trail: { places: places.slice(over), at: places.length - 1 - over }, dropped: [...ahead, ...places.slice(0, over)].map(place => place.key) }
}

/** The history moved `delta` steps (-1 Back, 1 Forward), or undefined when there is no step that way. */
export function stepTrail(trail: SsisTrail, delta: number): SsisTrail | undefined {
  const at = trail.at + delta
  return at < 0 || at >= trail.places.length || delta === 0 ? undefined : { ...trail, at }
}

/** The shown place with what the user chose there changed (a run page's chips or task), without adding a step. */
export function updatePlace(trail: SsisTrail, change: (place: SsisPlace) => SsisPlace): SsisTrail {
  const places = trail.places.slice()
  places[trail.at] = change(places[trail.at]!)
  return { ...trail, places }
}

/** The keys whose reads stay in memory: the places within `navigationLimits.kept` steps of the shown one. */
export function keptKeys(trail: SsisTrail): ReadonlySet<string> {
  return new Set(trail.places.filter((_place, index) => Math.abs(index - trail.at) <= navigationLimits.kept).map(place => place.key))
}

/** A place as Back's and Forward's tooltips and the breadcrumb name it. */
export function placeName(place: SsisPlace | SsisPlaceTarget): string {
  return place.kind === 'list' ? 'SSISDB' : place.kind === 'package' ? place.package : `Execution ${place.executionId}`
}
