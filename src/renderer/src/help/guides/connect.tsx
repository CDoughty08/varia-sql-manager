import GuidePage from '../GuidePage'
import type { GuideProps } from '../HelpDocument'
import { CommandRef, GuideAction } from '../References'
import { ConnectionSample } from '../Samples'

export default function ConnectGuide({ documentId }: GuideProps) {
  return <GuidePage id="connect" documentId={documentId} content={{
    prepare: <><p>You need a reachable SQL Server, permission to sign in and access to the database you want to use. Varia does not install a database server.</p><p>Ask your administrator for the server name (and port or instance), authentication method, database and certificate requirements. A VPN may be required.</p></>,
    'sign-in': <><p>Choose the method the server supports. SQL Server Authentication uses a SQL login; Windows Authentication uses your integrated identity; Microsoft Entra methods use an organization identity or configured application.</p><ConnectionSample /><p>The sample follows Varia’s authentication catalog. It does not collect credentials or attempt a connection.</p></>,
    next: <><ol><li>Open <CommandRef id="connection.connect" context="workbench" />.</li><li>Enter the server and authentication details. Review encryption and certificate options with your administrator.</li><li>Choose Connect. When it succeeds, expand the server and Databases in Object Explorer. Only databases your identity can see will appear.</li></ol><GuideAction command="connection.connect" label="Open Connect dialog" /><p>Opening the dialog does not submit it. You choose when to connect.</p></>,
    trouble: <><p><strong>Server not found or timeout:</strong> check the name, port, network access and VPN. <strong>Login failed:</strong> confirm the method and that the identity has access. <strong>Certificate error:</strong> check the server name and trusted certificate chain with your administrator.</p><p>A disconnected server stays in Object Explorer. Use <CommandRef id="connection.reconnect" context="workbench" /> to try again or <CommandRef id="connection.removeFromExplorer" context="workbench" /> to hide it. Saved profiles and query text remain available.</p><p>For browser sign-in, finish the account prompt and return to Varia. For integrated authentication outside Windows, confirm Kerberos is configured. Keep passwords and connection strings out of issue reports.</p></>
  }} />
}
