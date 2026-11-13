# Disconnect prompt integration

Explorer owns App and workbench registration. Add one `DisconnectPromptService` to the workbench and dispose it with
the workbench. Mount `<DisconnectDialog service={workbench.disconnectPrompts} />` once in App's main-window modal
layer. Import both modules from `src/renderer/src/disconnect/`. Popout commands must use this same service, rather
than mounting another dialog or creating another service.

The disconnect coordinator calls `disconnectPrompts.request({ targetId, name, tabs })`, with each affected query tab's
`id`, `name`, `dirty` and `running` flags. It resolves to `keep-tabs`, `close-query-tabs` or `cancel`. The dialog only
collects this choice: the coordinator still owns save and transaction preflight, revalidation, cancellation and the
backend disconnect. The service serializes prompts, ignores stale answers and resolves pending requests to Cancel on
disposal. Cancel takes initial focus and Escape cancels. The shared focus helpers bring an originating popout forward
when the prompt closes.

This module is additive until the Explorer integration is applied. The implementation plan remains the behavior
reference; README and guides should describe the completed integrated feature rather than claim this dialog alone is
available in the running application.
