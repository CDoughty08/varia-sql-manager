import GuidePage from '../GuidePage'
import type { GuideProps } from '../HelpDocument'
import { CommandRef, GestureRef, SettingRef } from '../References'
import { MultiServerSample } from '../Samples'

export default function MultiServerQueryGuide({ documentId }: GuideProps) {
  return <GuidePage id="multi-server-query" documentId={documentId} content={{
    select: <>
      <p>Connect two or more SQL Server instances or two or more BigQuery projects, then select top-level server rows in Object Explorer using <GestureRef id="explorer.addToSelection" /> or <CommandRef id="explorer.toggleMultiSelect" context="explorerServer" />.</p>
      <p>The first server you pick locks multi-selection to that engine so SQL Server and BigQuery targets are not mixed accidentally. Once two or more servers are selected, choose <strong>New Query</strong> on Object Explorer’s selection bar or <CommandRef id="explorer.newMultiServerQuery" context="workbench" /> from the server context menu.</p>
      <p>Inside a multi-server query tab, open the target trigger in the query bar to check or uncheck servers, pick each server’s database or default dataset, apply a shared SQL Server database across targets, or reconnect an offline target. Dragging another server of the same engine onto the tab adds it to the target list.</p>
    </>,
    modes: <>
      <p>When two or more targets are enabled, <CommandRef id="query.execute" context="queryEditor" /> opens the Run Mode dialog before sending anything. Unchecking targets down to a single enabled server skips the Run Mode dialog and runs directly as an ephemeral single-target execution.</p>
      <p><strong>Coordinated Transaction</strong> opens a fresh local transaction (SQL Server, no MSDTC) or ephemeral DML session (BigQuery) on each target, waits at a barrier after execution, and commits only if every target succeeds—otherwise all targets roll back. Non-transactional statements and duplicate connections to the same physical SQL Server are refused in pre-flight.</p>
      <p><strong>Fire and Forget</strong> runs each target independently without cross-server rollback, with optional sequential rollout (stop on first error) and, for BigQuery, a free pre-flight dry run. BigQuery multi-project runs show each project’s estimated bytes and on-demand cost inside the Run Mode dialog against <SettingRef id="queryExecution.bigQuery.costThreshold" />. Use <CommandRef id="query.cancel" context="queryEditor" /> to cancel all active targets.</p>
      <MultiServerSample />
    </>,
    'cross-engine': <>
      <p>To query SQL Server and BigQuery side by side, use <CommandRef id="explorer.newCrossEngineQuery" context="workbench" />. The tab opens in <strong>Dual-Dialect Split</strong> with a Transact-SQL pane and a GoogleSQL pane (stacking vertically in narrow groups), and can toggle to the single-file <code>-- #Dialect</code> format used for Save, Hot Exit and AutoRecover.</p>
      <p>Cross-Engine tabs are strictly read-only (<code>SELECT</code> and <code>WITH</code> only) across three layers: live red squiggles and a guard strip in the editor, pre-execute refusal before any IPC is sent, and backend AST and BigQuery dry-run verification. If a statement is blocked, the guard strip offers <strong>Open in SQL Server tab</strong> or <strong>Open in BigQuery tab</strong> to move the script to a single-engine tab.</p>
    </>,
    results: <>
      <p>Multi-server runs open a <strong>Summary</strong> view (in both Tabs and Stacked layouts, following <SettingRef id="queryResults.grid.layout" />) showing every target’s outcome, row counts, duration, and errors—even on pure-DDL or DML scripts that return no row sets.</p>
      <p>When two or more targets return in-memory rows and the merged result fits within the remaining query memory budget, Varia builds a <strong>Combined</strong> tab with a prepended <code>_server</code> column that supports sorting, filtering, Pivot, Transpose, Column Profile, Copy and Save Results As. Windowed BigQuery results stay out of Combined until loaded into memory.</p>
      <p>Use <CommandRef id="output.compare" context="resultsGrid" /> from Summary or Combined to diff results across two targets (or across SQL Server and BigQuery). Messages adds a server filter bar above the log while keeping Copy scoped to message lines, and error links jump directly to the matching dialect pane and line.</p>
    </>
  }} />
}
