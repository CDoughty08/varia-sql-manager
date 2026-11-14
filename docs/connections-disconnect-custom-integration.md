# Custom document target integration

These provider hooks are now wired through the workbench and `TargetService`. The implementation checklist below is
retained as a design reference. Background startup reconnect attaches wanted queries only; explicit manual reconnect
may rebind exact-target custom documents. It never executes query buffers, and retained drafts remain intact.

The disconnect track's custom providers preserve drafts and retain their original target while a backend handle is
replaced. Their shared `CustomDocumentTargets` helper keeps a target binding captured when the document opens. It is a
consistency check; authentication and credential equivalence remain main-owned.

The Explorer workbench owner must pass a `targetIdOf(connectionId)` resolver to Table Designer, Database Properties,
Activity Monitor, SSIS properties, SSIS operations, Restore Database, New Database and Peek Tabs. The lookup must resolve
backend handle IDs to stable target UUIDs, including handles in the compatibility ConnectionService. Resolve it from the
existing registry snapshot
(`target.lifecycle.state` is `connected` or `disconnecting` and `target.lifecycle.handle.id === connectionId`),
or from the compatibility adapter's equivalent lookup. No new frozen registry API is required.
An absent lookup keeps a legacy document on its original live handle and refuses reassociation by server name.

The persistence owner must add this optional method to `CustomDocumentProvider` and a matching `DocumentService`
delegation, then call it from `TargetService` before replacing a custom document's runtime connection ID:

```ts
canFollowTarget?(id: string, targetId: string): boolean

canFollowTarget(id: string, targetId: string): boolean {
  return this.provider(id)?.canFollowTarget?.(id, targetId) ?? false
}
```

The provider implementations already expose `canFollowTarget`. SSIS properties registers it on each of its four
providers. Replace `documents.follows(document.id, server)` with
`documents.canFollowTarget(document.id, targetId)` where `targetId` is the durable identity proven by the target
registry, and require the document's retained target association to match as well. Only then update the live
`connectionId`. Retain each custom document's durable target association on disconnect and in hidden-target reference
counts. Do not derive the target from server labels, profile IDs, account display text or settings guesses.

The deprecated `follows(id, server)` implementations now return false, making the intermediate integration
conservative. Database Properties no longer reuses an orphan based on server name. SSIS properties no longer moves a
disconnected tab to an arbitrary connection created later on the same server. A wrong-target document update leaves
dependent operations unavailable; view owners also refuse to move their live subscriptions across targets. Replies
from the old handle cannot populate a document after a replacement handle is attached.

Only query documents belong in Disconnect and Close Query Tabs. Custom draft documents stay open. Preserve existing
Apply, Restore, Create Catalog and other management-operation blockers; changing target association must never bypass
those blockers. A successful exact reconnect restores operation eligibility, while Activity Monitor and SSIS live
view restore policy remains explicit (restoring a workspace must not resume subscriptions automatically).

The disconnect host's `detached(targetId, handle)` callback must clear runtime `connectionId` on every attached custom
and query document while retaining durable target identity. Publish the compatibility connection snapshot with the old
handle removed or marked lost as part of the same completion. LiveService's `documentOwner` listens to document
changes: returning `undefined` from its runtime connection lookup ends the old subscription. Keeping the old runtime
handle on a document does not notify that owner of a disconnect. Activity Monitor and SSIS Operations additionally
wrap the owner lookup with their exact target binding; generic future live document owners need the same identity rule.
No separate LiveService disconnect API is needed when this detach publication is made.

Object Search listens to the compatibility connection snapshot. Its single-target searches now cancel pending reads
and typing tasks on loss, keep filter drafts and completed hits, mark the scope disconnected and reject late replies
from the old handle. All Servers searches retain their existing explicit multi-target scope. It does not infer
reassociation from server names (`follows` remains false). If a lifecycle integration automatically moves a single-target
search on reconnect, prove the search's retained durable target against the new handle before invoking its existing
`setConnection(id, connectionId)` path; that path is also the intentional user-selected scope change. Do not call it
merely because a newly connected server has the same display text. Publishing connection loss is the Object Search
stop hook; direct mutation of the target registry alone is insufficient until the compatibility adapter publishes it.

The Getting Started Connect/Run Query guides and sample buffers do not describe custom-document reconnect behavior;
this helper change adds no new guide or sample action. The owning connection lifecycle integration updates their
connection guidance.
