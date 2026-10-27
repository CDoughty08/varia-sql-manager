# Icons

Generated from `src/shared/icons.ts` by `npx vitest run tests/icons.test.ts -u`; do not edit by hand.

Catalogues (commands, Object Explorer kinds and folders, document kinds, dialog pages) name icons only by these ids, and
the renderer draws them only through `Icon.tsx`. Varia's own icons are drawn to codicon metrics: a 16 px grid with the
drawing inside 1-15 px, 1 px strokes with round caps and joins, `currentColor` and no fills. Straight lines sit on
half pixels, so they are sharp at 100 % zoom where the icon's box starts on a whole pixel; one placed after text of
fractional width (document tabs after the first) is not. An id below replaces the codicon of the
same name. Icons are sized with the `--varia-glyph-*` tokens ([metrics](themes/metrics.md)) and coloured
with theme keys; Microsoft's SSMS icons are never used.

## Varia's icons (14)

| Id | Use |
| --- | --- |
| `varia` | The brand mark in the title bar. |
| `server` | Servers: Object Explorer's server nodes, saved and discovered connections. |
| `database` | Databases, and query documents. |
| `table` | Tables and table types, the table designer. |
| `view` | Views. |
| `procedure` | Stored procedures. |
| `key` | Keys: primary-key columns, credentials, asymmetric, symmetric and column keys. |
| `login` | Logins. |
| `role` | Server, database and application roles. |
| `shield` | Audits, audit specifications, security policies. |
| `execution-plan` | Execution plan documents. |
| `agent-job` | SQL Server Agent jobs (planned). |
| `ssis-package` | Integration Services packages (planned). |
| `ssis-environment` | Integration Services environments (planned). |

## Codicons (105)

From the codicon font bundled with Monaco ([reference](https://microsoft.github.io/vscode-codicons/dist/codicon.html)):

`add`, `archive`, `arrow-left`, `arrow-small-down`, `bell`, `book`, `bookmark`, `case-sensitive`, `check`, `chevron-down`, `chevron-right`, `circle-filled`, `circle-outline`, `circle-slash`, `circuit-board`, `clear-all`, `clippy`, `close`, `close-all`, `cloud`, `code`, `collapse-all`, `comment`, `copy`, `debug-disconnect`, `debug-pause`, `debug-restart`, `debug-stop`, `device-camera`, `discard`, `edit`, `error`, `file`, `file-code`, `filter`, `filter-filled`, `folder`, `folder-opened`, `git-compare`, `go-to-file`, `graph`, `history`, `info`, `insert`, `json`, `law`, `layers`, `layout`, `link`, `list-flat`, `list-ordered`, `list-tree`, `loading`, `lock`, `milestone`, `multiple-windows`, `new-file`, `output`, `package`, `pass`, `person`, `play`, `plug`, `redo`, `references`, `refresh`, `remote`, `remove`, `replace`, `save`, `save-all`, `save-as`, `screen-full`, `search`, `settings-gear`, `split-horizontal`, `star-empty`, `star-full`, `symbol-color`, `symbol-constant`, `symbol-field`, `symbol-function`, `symbol-key`, `symbol-namespace`, `symbol-numeric`, `symbol-operator`, `symbol-parameter`, `symbol-ruler`, `symbol-snippet`, `symbol-structure`, `tag`, `tools`, `trash`, `triangle-right`, `type-hierarchy`, `verified`, `warning`, `watch`, `whitespace`, `window`, `word-wrap`, `workspace-trusted`, `zap`, `zoom-in`, `zoom-out`.
