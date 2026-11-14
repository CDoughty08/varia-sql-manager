import { useId, type CSSProperties, type ReactNode } from 'react'
import Icon from '../Icon'
import type { Bar, BytesFormat, NerdMetricsModel } from './memory-details'

const width = (share: number) => ({ '--memory-share': `${Math.max(0, Math.min(1, share)) * 100}%` }) as CSSProperties

function Usage({ bar, bytes, index }: { bar: Bar; bytes: BytesFormat; index: number }) {
  const said = bar.segments.map(part => `${part.label} ${bytes(part.bytes)}`).join(', ')
  return <div className="memory-bar-row">
    <span>{bar.label}</span><span className="memory-figure">{bytes(bar.total)}</span>
    <div className="memory-bar" data-bar={index === 0 ? 'read' : 'now'} role="img" aria-label={`${bar.label}: ${bytes(bar.total)}${said ? `. ${said}` : ''}`}>
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
function ResultName({ name }: { name: string }) {
  const at = name.lastIndexOf(' · ')
  return <span className="memory-biggest-name" title={name}>
    {at < 0 ? <span>{name}</span> : <><span className="memory-biggest-tab">{name.slice(0, at)}</span><span>{name.slice(at)}</span></>}
  </span>
}

export function NerdDetails({ model }: { model: NerdMetricsModel }) {
  const { bytes } = model
  return <>
    <ul className="memory-tiles">
      {model.tiles.map(tile => <li key={tile.label} className="memory-tile" data-tone={tile.tone}>
        <span className="memory-tile-label">{tile.label}</span>
        <span className="memory-tile-value">{tile.value}{tile.unit && <small>{tile.unit}</small>}</span>
        <span className="memory-tile-note">{tile.note}</span>
      </li>)}
    </ul>
    <div className="memory-group">
      <h4>Where it lives<span className="memory-group-aside">same scale</span></h4>
      {model.bars.map((bar, index) => <Usage key={bar.label} bar={bar} bytes={bytes} index={index} />)}
      <ul className="memory-legend">
        {model.legend.map(part => <li key={part.part}><span className="memory-swatch" data-part={part.part} aria-hidden="true" />{part.label}<span className="memory-figure">{bytes(part.bytes)}</span></li>)}
      </ul>
    </div>
    <div className="memory-group">
      <h4>Biggest results<span className="memory-group-aside">rows <Icon name="arrow-right" /> stored</span></h4>
      {model.biggest.length === 0 ? <p className="memory-nerd-empty">No results held.</p> : <ul className="memory-biggest" aria-label="Biggest results">
        {model.biggest.map(row => <li key={row.resultId}>
          <ResultName name={row.name} />
          <span className="memory-mini" aria-hidden="true"><span style={width(row.logicalShare)} /><span data-state={row.state} style={width(row.storedShare)} /></span>
          <span className="memory-muted"><span className="visually-hidden">rows </span>{row.logical}</span>
          <span className="memory-stored"><span className="visually-hidden">stored </span>{row.stored}</span>
          <span className="memory-state" data-state={row.state}>{row.stateLabel}</span>
        </li>)}
      </ul>}
    </div>
    <div className="memory-group">
      <h4>Codec<span className="memory-group-aside">{model.codecOn ? 'since start' : 'off'}</span></h4>
      <dl className="memory-counters" aria-label="Codec counters">
        {model.counters.map(counter => <div key={counter.label}><dt>{counter.label}</dt><dd>{counter.value}</dd></div>)}
      </dl>
    </div>
    <footer className="memory-nerd-footer"><span>{model.heap}</span><span className="memory-cozy">{model.cozy.lead}{model.cozy.accent && <> <strong>{model.cozy.accent}</strong></>}</span></footer>
  </>
}
