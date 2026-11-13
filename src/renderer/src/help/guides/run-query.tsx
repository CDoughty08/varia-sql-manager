import GuidePage from '../GuidePage'
import type { GuideProps } from '../HelpDocument'
import { CommandRef, GuideAction } from '../References'
import { QuerySample } from '../Samples'

export default function QueryGuide({ documentId }: GuideProps) {
  return <GuidePage id="run-query" documentId={documentId} content={{
    new: <><p>Connect first, then use <CommandRef id="file.new" context="workbench" />. Check the query’s server and database selectors before running anything; each query has its own target.</p><p>A restored query remembers its exact connection target and its own database. A server followed by Disconnected is remembered context. Reconnecting opens a fresh session, so temporary tables, SET state and transactions from the previous session are gone. An unavailable database requires your choice; Varia does not silently run the query in another database.</p><GuideAction command="file.new" label="Open a blank query" /><p>This opens an empty editor. It does not insert or execute the sample.</p></>,
    execute: <><p>Type a read-only query you understand, put focus in its SQL editor, then use <CommandRef id="query.execute" context="queryEditor" />.</p><p>A nonempty selection runs only that selection. With no selection, Execute runs the entire buffer. Select complete statements when you want to run only part of a script.</p><QuerySample /></>,
    read: <><p>Returned rows appear in Results. Messages shows completion details and server errors. Multiple statements can return multiple result sets. A successful statement can also return no rows.</p><p>If Execute asks you to connect, complete the connection first. For a lost connection, reconnect before retrying. Check Messages and the database selector when an object cannot be found or permission is denied.</p><p>Cancel Executing Query requests cancellation of a running request. It does not undo work already committed. Review statements that change data before executing them.</p></>
  }} />
}
