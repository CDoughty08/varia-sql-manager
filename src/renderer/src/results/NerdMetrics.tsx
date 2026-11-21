import { useId, type CSSProperties, type ReactNode } from 'react'
import Icon from '../Icon'
import type { Bar, BytesFormat, Counter, IndexNerdModel, NerdMetricsModel, ResultLabel, Segment, Tile } from './memory-details'

const width = (share: number) => ({ '--memory-share': `${Math.max(0, Math.min(1, share)) * 100}%` }) as CSSProperties

/** A bar of parts on one scale; `muted` draws the rows as read, the reference the memory below them is measured against. */
function Usage({ bar, bytes, muted }: { bar: Bar; bytes: BytesFormat; muted: boolean }) {
  const said = bar.segments.map(part => `${part.label} ${bytes(part.bytes)}`).join(', ')
  return <div className="memory-bar-row">
    <span>{bar.label}</span><span className="memory-figure">{bytes(bar.total)}</span>
    <div className="memory-bar" data-bar={muted ? 'read' : 'now'} role="img" aria-label={`${bar.label}: ${bytes(bar.total)}${said ? `. ${said}` : ''}`}>
      {bar.segments.map(part => <span key={part.part} data-part={part.part} style={width(part.share)} />)}
    </div>
  </div>
}

/** The Memory panel's Nerd metrics: a heading that opens and closes it, and while open (`children`, the details) what
 *  results hold as read and in memory, the largest results, the page codec's counters and the managed heap. The heading
 *  joins the tab order only while the panel is pinned: a preview opened by focus must not catch the next Tab (the panel
 *  follows the whole window in the page's order), and Enter or Space on the Memory control pins it. `trend` is the
 *  sparkline of what compression gave back, beside the heading rather than in it, so it stays out of the heading's name. */
export function NerdMetrics({ open, pinned, onToggle, trend, children }: { open: boolean; pinned: boolean; onToggle: () => void; trend?: ReactNode; children?: ReactNode }) {
  const body = useId()
  return <section className="memory-nerd" aria-label="Nerd metrics">
    <div className="memory-nerd-heading">
      <h3>
        <button type="button" className="memory-nerd-toggle" tabIndex={pinned ? undefined : -1} aria-expanded={open} aria-controls={body} onClick={onToggle}>
          <Icon name="chevron-right" /><span>Nerd metrics</span>
        </button>
      </h3>
      {trend}
    </div>
    <div id={body} className="memory-nerd-body" hidden={!open}>{open && children}</div>
  </section>
}

/** A result's name, its tab's part giving way first: tabs often share a long file name, and the Results caption after it
 *  ("Result 2") is what tells their rows apart. */
function ResultName({ name, label }: { name: string; label: ResultLabel }) {
  return <span className="memory-biggest-name" title={name}>
    {label.tab === undefined ? <span>{label.result}</span> : <><span className="memory-biggest-tab">{label.tab}</span><span>{` · ${label.result}`}</span></>}
  </span>
}

function Tiles({ tiles }: { tiles: readonly Tile[] }) {
  return <ul className="memory-tiles">
    {tiles.map(tile => <li key={tile.label} className="memory-tile" data-tone={tile.tone}>
      <span className="memory-tile-label">{tile.label}</span>
      <span className="memory-tile-value">{tile.value}{tile.unit && <small>{tile.unit}</small>}</span>
      <span className="memory-tile-note">{tile.note}</span>
    </li>)}
  </ul>
}

function Legend({ parts, bytes }: { parts: readonly Segment[]; bytes: BytesFormat }) {
  return <ul className="memory-legend">
    {parts.map(part => <li key={part.part}><span className="memory-swatch" data-part={part.part} aria-hidden="true" />{part.label}<span className="memory-figure">{bytes(part.bytes)}</span></li>)}
  </ul>
}

function Counters({ counters, label }: { counters: readonly Counter[]; label: string }) {
  return <dl className="memory-counters" aria-label={label}>
    {counters.map(counter => <div key={counter.label}><dt>{counter.label}</dt><dd>{counter.value}</dd></div>)}
  </dl>
}

export function NerdDetails({ model }: { model: NerdMetricsModel }) {
  const { bytes } = model
  return <>
    <Tiles tiles={model.tiles} />
    <div className="memory-group">
      <h4>Where it lives<span className="memory-group-aside">same scale</span></h4>
      {model.bars.map((bar, index) => <Usage key={bar.label} bar={bar} bytes={bytes} muted={index === 0} />)}
      <Legend parts={model.legend} bytes={bytes} />
    </div>
    <div className="memory-group">
      <h4>Biggest results<span className="memory-group-aside">rows <Icon name="arrow-right" /> stored</span></h4>
      {model.biggest.length === 0 ? <p className="memory-nerd-empty">{model.biggestEmpty}</p> : <ul className="memory-biggest" aria-label="Biggest results">
        {model.biggest.map(row => <li key={row.resultId}>
          <ResultName name={row.name} label={row.label} />
          <span className="memory-mini" aria-hidden="true"><span style={width(row.logicalShare)} /><span data-state={row.state} style={width(row.storedShare)} /></span>
          <span className="memory-muted"><span className="visually-hidden">rows </span>{row.logical}</span>
          <span className="memory-stored"><span className="visually-hidden">stored </span>{row.stored}</span>
          <span className="memory-state" data-state={row.state}>{row.stateLabel}</span>
        </li>)}
      </ul>}
    </div>
    <div className="memory-group">
      <h4>Codec<span className="memory-group-aside">{model.codecOn ? 'since start' : 'off'}</span></h4>
      <Counters counters={model.counters} label="Codec counters" />
    </div>
    <footer className="memory-nerd-footer"><span>{model.heap}</span><span className="memory-cozy">{model.cozy.lead}{model.cozy.accent && <> <strong>{model.cozy.accent}</strong></>}</span></footer>
  </>
}

/** The Search Indexer's part of Nerd metrics, below the results': how much of its definitions is packed and what that saved,
 *  where its budget goes, and its pool's sharing. It shows the latest explorer.index.memory event; nothing here polls. */
export function IndexDetails({ model }: { model: IndexNerdModel }) {
  const { bytes } = model
  return <section className="memory-index" aria-label="Search Indexer metrics">
    <h4>Search Indexer<span className="memory-group-aside">{model.aside}</span></h4>
    <Tiles tiles={model.tiles} />
    <div className="memory-group">
      <Usage bar={model.bar} bytes={bytes} muted={false} />
      <Legend parts={model.bar.segments} bytes={bytes} />
    </div>
    <Counters counters={model.counters} label="Search Indexer counters" />
  </section>
}
