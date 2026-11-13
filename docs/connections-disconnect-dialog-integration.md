# Disconnect prompt integration

The workbench owns one `DisconnectPromptService` and disposes it with the workbench. App mounts
`<DisconnectDialog service={workbench.disconnectPrompts} />` once in its main-window modal layer. Both modules live in
`src/renderer/src/disconnect/`. Popout commands use this same service and prompt.

The disconnect coordinator calls `disconnectPrompts.request({ targetId, name, tabs })`, with each affected query tab's
`id`, `name`, `dirty` and `running` flags. It resolves to `keep-tabs`, `close-query-tabs` or `cancel`. The dialog only
collects this choice: the coordinator still owns save and transaction preflight, revalidation, cancellation and the
backend disconnect. The service serializes prompts, ignores stale answers and resolves pending requests to Cancel on
disposal. Cancel takes initial focus and Escape cancels. The shared focus helpers bring an originating popout forward
when the prompt closes.

The dialog is integrated with the workbench coordinator. README and [connection roots](connections-explorer.md)
describe the available behavior.
