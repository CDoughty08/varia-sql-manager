import GuidePage from '../GuidePage'
import type { GuideProps } from '../HelpDocument'
import { CommandRef, GestureRef, SettingRef } from '../References'
import { ResultsSample } from '../Samples'

export default function ResultsGuide({ documentId }: GuideProps) {
  return <GuidePage id="results" documentId={documentId} content={{
    browse: <><p>Run a query that returns rows and select a result set. The grid’s sort and filter actions operate on returned rows; they do not add a server-side WHERE clause or run SQL again.</p><ResultsSample /></>,
    select: <><p>Click a cell or use row and column headers to select a block. Add another block with the configured gesture below; if it is off, enable it in Shortcuts.</p><p><GestureRef id="grid.addToSelection" /></p><p>With focus in the grid, use <CommandRef id="output.copy" context="resultsGrid" /> for the selected cells, or <CommandRef id="output.copyWithHeaders" context="resultsGrid" /> to include column names explicitly.</p><p><SettingRef id="queryResults.grid.includeColumnHeaders" /></p><p>This is the value currently applied to this window. Changes in Options take effect after you apply them. A disabled mouse gesture can be enabled or remapped in the Mouse view of Shortcuts.</p></>,
    limits: <><p>Sorting or filtering cannot recover rows that were not returned. Watch for truncation or budget messages before treating the grid as a complete dataset; narrow the query if needed.</p><p>Results stay in memory. Re-executing a query, closing its results or tab, or losing the backend releases them. Copy or save what you need before those actions. Reading a guide does not preserve results across a restart.</p></>
  }} />
}
