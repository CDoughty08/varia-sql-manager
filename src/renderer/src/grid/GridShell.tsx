import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type HTMLAttributes, type KeyboardEvent, type ReactNode, type RefCallback } from 'react'
import { onUnexpectedError } from '../core/errors'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { ColumnFilterPopover, type ColumnFilterSource, type ColumnFilterTarget } from '../results/ColumnFilterPopover'
import { GridView, type GridStatus, type GridViewOptions, type HeaderSortKey } from './GridView'

/** What a grid's source gives GridView; the shell adds its elements, the client, the platform, the white space setting, its
 *  status and errors, and the header's sort buttons and funnels. */
export type GridSpec = Omit<GridViewOptions, 'root' | 'scroller' | 'client' | 'platform' | 'whitespace' | 'onStatus' | 'onError' | 'sort' | 'onSort' | 'filtered' | 'filterable' | 'onFilter'> & {
  /** False for a grid whose table does not sort (a live log): its headers get no sort buttons. */
  readonly sortable?: boolean
}
const instances = new WeakMap<object, number>()
let nextInstance = 0
/** A number for an object, the same for its life: a mount key that changes when a grid's source object is replaced. */
export function instanceKey(value: object): number {
  let key = instances.get(value)
  if (key === undefined) instances.set(value, key = ++nextInstance)
  return key
}

/** The shell's view and funnel, for its source's own effects and commands. */
export interface GridShellApi {
  view(): GridView | undefined
  /** Opens a column's funnel under its header (Filter Column Values…, Alt+Down). */
  openFunnel(column: number): void
}
/** The header's funnels: the source the popover lists and filters, the filtered columns, and the columns that have one. */
export interface GridFunnels {
  readonly source: ColumnFilterSource
  readonly filtered: ReadonlySet<number>
  /** Only these columns' headers have a funnel; every column's without it. */
  readonly filterable?: ReadonlySet<number>
  columnName(column: number): string | undefined
}

export interface GridShellProps {
  /** The grid element's own attributes (its name, the data-* the menus read, focus handlers). */
  readonly rootProps: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | number | undefined>
  /** The frame's attributes (a live grid's probe and table). */
  readonly frameProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | number | undefined>
  /** Registers the grid element for its context menu, besides the shell's own ref. */
  readonly rootRef?: RefCallback<HTMLDivElement>
  /**
   * Builds the grid once per `mountKey`, in a layout effect: `create` makes the GridView over the shell's elements (at
   * once, or later: a live grid's first sample). The cleanup it returns disposes what it built.
   */
  mount(create: (spec: GridSpec) => GridView): () => void
  readonly mountKey: string
  /** The keys the headers show. */
  readonly sort?: readonly HeaderSortKey[]
  /** A header's sort button; without it headers have none. Read when the view is built. */
  readonly onSort?: (column: number, add: boolean) => void
  /** Header funnels and their popover; without them headers have none. Read when the view is built. */
  readonly funnels?: GridFunnels
  /** What changes on a built view besides sort and funnels. */
  readonly update?: { readonly resultCount: number; readonly showTypes?: boolean; readonly rowSize?: boolean }
  /** The rows are gone (a released or lost result, a stopped live view): an overlay says why, over the strips. */
  readonly gone?: string
  /** A note under the rows when nothing failed (a truncation, a highlight, a failed copy). */
  readonly strip?: { readonly text: string; readonly error?: boolean }
  /** What the render error strip calls the grid's contents. */
  readonly contents?: 'result' | 'rows'
  onApi?(api: GridShellApi | undefined): void
  /** More inside the frame (a live log's "n new rows" button). */
  readonly children?: ReactNode
}

/**
 * The results grid's React shell: its root and scroller, the header's sort buttons and funnels with their popover
 * (ColumnFilterPopover), the strips and the overlay. GridView renders and handles everything inside. Its source decides
 * what it shows: a query's result set (ResultGrid) or a live view's table (LiveGridPane), which differ only in how the view
 * is built and swapped, and in what the funnels and sort ask.
 */
export default function GridShell({ rootProps, frameProps, rootRef: outerRef, mount, mountKey, sort, onSort, funnels, update, gone, strip, contents = 'result', onApi, children }: GridShellProps) {
  const { resultClient, platform, settings } = useWorkbench()
  const whitespace = useServiceSnapshot(settings).values['queryResults.grid.whitespace']
  const rootRef = useRef<HTMLDivElement | null>(null), scrollRef = useRef<HTMLDivElement>(null), viewRef = useRef<GridView | undefined>(undefined)
  const [status, setStatus] = useState<GridStatus>({})
  // The header funnel's popover, while open: its column and where it opens.
  const [funnel, setFunnel] = useState<ColumnFilterTarget | undefined>()
  const latest = useRef({ mount, sort, onSort, funnels, whitespace, onApi })
  latest.current = { mount, sort, onSort, funnels, whitespace, onApi }
  // Before the shell paints: a source with rows builds its view now, so the grid never paints empty first.
  useLayoutEffect(() => {
    const now = latest.current
    const create = ({ sortable = true, ...spec }: GridSpec): GridView => {
      const view = new GridView({
        ...spec, root: rootRef.current!, scroller: scrollRef.current!, client: resultClient, platform, whitespace: latest.current.whitespace,
        onStatus: setStatus, onError: onUnexpectedError, sort: latest.current.sort,
        ...now.onSort && sortable ? { onSort: (column: number, add: boolean) => latest.current.onSort?.(column, add) } : {},
        ...now.funnels ? {
          // A live grid builds its view at its first sample: the funnels as they are by then.
          filtered: latest.current.funnels?.filtered ?? now.funnels.filtered, ...(latest.current.funnels ?? now.funnels).filterable ? { filterable: (latest.current.funnels ?? now.funnels).filterable } : {},
          // A press on the open column's funnel closes its popover, as pressing a menu's button again does.
          onFilter: (column: number, anchor: DOMRect) => setFunnel(current => current?.column === column ? undefined : { column, anchor })
        } : {}
      })
      viewRef.current = view
      return view
    }
    const api: GridShellApi = {
      view: () => viewRef.current,
      openFunnel: column => { const view = viewRef.current; if (view?.canFilter(column)) setFunnel({ column, anchor: view.filterAnchor(column) }) }
    }
    const dispose = now.mount(create)
    now.onApi?.(api)
    return () => {
      latest.current.onApi?.(undefined)
      dispose()
      viewRef.current = undefined
      setFunnel(undefined)
      setStatus({})
    }
  }, [mountKey, resultClient, platform])
  const resultCount = update?.resultCount ?? 1, showTypes = update?.showTypes, rowSize = update?.rowSize
  const filtered = funnels?.filtered, filterable = funnels?.filterable
  useEffect(() => {
    viewRef.current?.update({ resultCount, whitespace, sort, ...showTypes !== undefined ? { showTypes } : {}, ...rowSize !== undefined ? { rowSize } : {}, ...filtered ? { filtered } : {}, ...filterable ? { filterable } : {} })
  }, [resultCount, showTypes, whitespace, sort, rowSize, filtered, filterable, mountKey, gone])
  // Closing the popover gives the focus back to the grid, as a menu does, unless a press elsewhere took it.
  const closeFunnel = useCallback((refocus = true) => {
    setFunnel(undefined)
    if (refocus) rootRef.current?.focus({ preventScroll: true })
  }, [])
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    rootProps.onKeyDown?.(event)
    if (event.defaultPrevented || (event.target as Element).closest('button')) return
    // Alt+Down, Ctrl+C and the other Query Output keys are the catalogue's (output.*, outputGridFocus), never the shell's.
    if (viewRef.current?.key(event.nativeEvent)) { event.preventDefault(); event.stopPropagation() }
  }
  const setRoot = useCallback((element: HTMLDivElement | null) => { rootRef.current = element; outerRef?.(element) }, [outerRef])
  const retry = () => viewRef.current?.retry()
  const failed = failedText(contents)
  const columnName = funnel && funnels?.columnName(funnel.column)
  // The grid holds only rows; its strips and the overlay are its siblings, outside the table structure.
  return <div {...frameProps} className={'rg-frame' + (frameProps?.className ? ' ' + frameProps.className : '')}>
    <div {...rootProps} ref={setRoot} className={'results-grid rg' + (rootProps.className ? ' ' + rootProps.className : '')} role="grid" tabIndex={0}
      aria-multiselectable="true" aria-readonly="true" onKeyDown={keyDown}>
      <div ref={scrollRef} className="rg-scroll" tabIndex={-1} />
    </div>
    {children}
    {gone && <div className="rg-overlay" role="status">{gone}</div>}
    {!gone && status.renderError ? <div className="rg-strip error" role="status">{failed} <button onClick={retry}>Retry</button></div>
      : !gone && status.tileError ? <div className="rg-strip error" role="status">Some rows could not be loaded: {status.tileError} <button onClick={retry}>Retry</button></div>
        : strip ? <div className={strip.error ? 'rg-strip error' : 'rg-strip'} role="status" title={strip.error ? undefined : strip.text}>{strip.text}</div> : null}
    {funnel && !gone && funnels && columnName !== undefined && rootRef.current && <ColumnFilterPopover key={funnel.column} source={funnels.source} target={funnel}
      columnName={columnName || '(No column name)'} filtered={funnels.filtered.has(funnel.column)} grid={rootRef.current} onClose={closeFunnel} />}
  </div>
}

/**
 * A grid that failed to render shows the render-error strip in its frame; Retry renders it again. It wraps the whole grid,
 * its source and the shell (ResultGrid, LiveGridPane), so a throw in either stays in the grid and Retry runs every effect.
 */
export class GridErrorBoundary extends Component<{ children: ReactNode; frameProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | number | undefined>; contents?: GridShellProps['contents'] }, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 }
  static getDerivedStateFromError(): Partial<{ failed: boolean }> { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo): void { onUnexpectedError(Object.assign(error, { componentStack: info.componentStack })) }
  render(): ReactNode {
    if (this.state.failed) {
      return <div {...this.props.frameProps} className={'rg-frame failed' + (this.props.frameProps?.className ? ' ' + this.props.frameProps.className : '')}>
        <div className="rg-strip error" role="status">{failedText(this.props.contents)} <button onClick={() => this.setState(state => ({ failed: false, attempt: state.attempt + 1 }))}>Retry</button></div>
      </div>
    }
    return <ErrorBoundaryKey key={this.state.attempt}>{this.props.children}</ErrorBoundaryKey>
  }
}
const failedText = (contents: GridShellProps['contents']) => contents === 'rows' ? 'These rows could not be displayed.' : 'This result could not be displayed.'
function ErrorBoundaryKey({ children }: { children: ReactNode }) { return <>{children}</> }
