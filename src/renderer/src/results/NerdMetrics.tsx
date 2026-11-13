import { useId, type CSSProperties } from 'react'
import Icon from '../Icon'
import type { Bar, NerdMetricsModel } from './memory-details'
import { panelBytes } from './memory-details'

const width = (share: number) => ({ '--memory-share': `${Math.max(0, Math.min(1, share)) * 100}%` }) as CSSProperties

function Usage({ bar }: { bar: Bar }) {
  const said = bar.segments.map(part => `${part.label} ${panelBytes(part.bytes)}`).join(', ')
  return <div className="memory-bar-row">
    <span>{bar.label}</span><span className="memory-figure">{panelBytes(bar.total)}</span>
    <div className="memory-bar" role="img" aria-label={`${bar.label}: ${panelBytes(bar.total)}${said ? `. ${said}` : ''}`}>
      {bar.segments.map(part => <span key={part.part} data-part={part.part} style={width(part.share)} />)}
    </div>
  </div>
}

/** The Memory panel's Nerd metrics: a heading that opens and closes it, and while open what results hold as read and in
 *  memory, the largest results, the page codec's counters and the managed heap. The heading joins the tab order only
 *  while the panel is pinned: a preview opened by focus must not catch the next Tab (the panel follows the whole window
 *  in the page's order), and Enter or Space on the Memory control pins it. */
export function NerdMetrics({ model, open, pinned, onToggle }: { model: NerdMetricsModel | undefined; open: boolean; pinned: boolean; onToggle: () => void }) {
  const body = useId()
  return <section className="memory-nerd" aria-label="Nerd metrics">
    <h3 className="memory-nerd-heading">
      <button type="button" className="memory-nerd-toggle" tabIndex={pinned ? undefined : -1} aria-expanded={open} aria-controls={body} onClick={onToggle}>
        <Icon name="chevron-right" /><span>Nerd metrics</span>
      </button>
      {model?.compressed && <span className="memory-nerd-ratio">{model.tiles[1].value}×</span>}
    </h3>
    <div id={body} className="memory-nerd-body" hidden={!open}>
      {open && (model ? <Details model={model} /> : <p className="memory-nerd-empty">Waiting for the backend's first report.</p>)}
    </div>
  </section>
}

function Details({ model }: { model: NerdMetricsModel }) {
  return <>
    <ul className="memory-tiles">
      {model.tiles.map(tile => <li key={tile.label} className="memory-tile" data-tone={tile.tone}>
        <span className="memory-tile-label">{tile.label}</span>
        <span className="memory-tile-value">{tile.value}{tile.unit && <small>{tile.unit}</small>}</span>
        <span className="memory-tile-note">{tile.note}</span>
      </li>)}
    </ul>
    <div className="memory-group">
      <h4>Where it lives<span>same scale</span></h4>
      {model.bars.map(bar => <Usage key={bar.label} bar={bar} />)}
      <ul className="memory-legend">
        {model.legend.map(part => <li key={part.part}><span className="memory-swatch" data-part={part.part} aria-hidden="true" />{part.label}<span className="memory-figure">{panelBytes(part.bytes)}</span></li>)}
      </ul>
    </div>
    <div className="memory-group">
      <h4>Biggest results<span>as read · stored</span></h4>
      {model.biggest.length === 0 ? <p className="memory-nerd-empty">No results held.</p> : <ul className="memory-biggest" aria-label="Biggest results">
        {model.biggest.map(row => <li key={row.resultId}>
          <span className="memory-biggest-name" title={row.name}>{row.name}</span>
          <span className="memory-mini" aria-hidden="true"><span style={width(row.logicalShare)} /><span data-state={row.state} style={width(row.storedShare)} /></span>
          <span className="memory-biggest-sizes"><span className="memory-muted">{row.logical}</span> <span aria-label={`stored in ${row.stored}`}>{row.stored}</span></span>
          <span className="memory-state" data-state={row.state}>{row.stateLabel}</span>
        </li>)}
      </ul>}
    </div>
    <div className="memory-group">
      <h4>Codec<span>{model.codecOn ? 'since start' : 'off'}</span></h4>
      <dl className="memory-counters" aria-label="Codec counters">
        {model.counters.map(counter => <div key={counter.label}><dt>{counter.label}</dt><dd>{counter.value}</dd></div>)}
      </dl>
    </div>
    <footer className="memory-nerd-footer"><span>{model.heap}</span><span className="memory-cozy">{model.cozy.lead}{model.cozy.accent && <> <strong>{model.cozy.accent}</strong></>}</span></footer>
  </>
}
