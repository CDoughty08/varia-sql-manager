# Live data

<!-- Generated from src/shared/live/catalog.ts. Regenerate with: npx vitest run tests/live-catalog.test.ts -u -->

Periodic data (the Activity Monitor, SSIS monitoring, later Object Explorer status) flows through one stream method,
`live.subscribe`, and one control method, `live.update` ([docs/ipc.md](ipc.md#live-subscriptions)). A subscription
names one source and up to 8 of its probes; the backend schedules every probe and sends one `live.tick` per
scheduler wake, only after the renderer has applied the previous one. This page lists the sources and probes the
catalogue declares, and what each probe emits. Sources marked test only are accepted only by an unpackaged smoke run
(main's test schemas) and a backend started with `VARIA_BACKEND_TEST_HOOKS=1`.

## Sources

| Source | Scope | Probes | Test only | Description |
| --- | --- | --- | --- | --- |
| `debug.synthetic` | none | `debug.synthetic.metrics`, `debug.synthetic.table`, `debug.synthetic.status` | yes | Generated values for protocol, renderer and smoke tests. It runs no SQL, so any connection id is accepted; a disconnect of that id still ends it. |

## Probes

| Probe | Interval (default, min, max) | Emits | Description |
| --- | --- | --- | --- |
| `debug.synthetic.metrics` | 1 s, 1 s, 3,600 s | series `counter` (count), `wave` (percent), `rate` (perSecond) | Three series: the sample number, a wave between 0 and 100, and a rate that follows it. |
| `debug.synthetic.table` | 1 s, 1 s, 3,600 s | snapshot table 0 `rows`: `id` int, `label` nvarchar, `value` int; key `id` | A snapshot table whose rows move on by one id per sample, so rows leave at the top and arrive at the bottom. |
| `debug.synthetic.status` | 1 s, 1 s, 3,600 s | status `phase`, `samples` | The phase (even or odd) and the sample count. |

## Limits

| Item | Value |
| --- | --- |
| Subscriptions | 16 per results port (main), 32 per backend, 8 per SQL connection |
| Probes | 8 per subscription; 4 snapshot and 4 append tables per probe, 8 tables per tick |
| Interval | 1 s to 3,600 s requested, then clamped to the probe's own minimum and maximum |
| Frames | one unacknowledged per subscription; initial credit 64 KiB; at most 256 KiB each, and the catalogue's worst case at most 192 KiB |
| Series, status values, errors | 64 series per probe; 16 status values of 128 characters; 8 probe errors of 2,000 characters per tick |
| Sort, filter, tracking | 4 sort columns; filter text 400 characters on 8 columns; 64 tracked keys of 512 characters per table |
| Resume token, kept results | 256 base64url characters; 64 results kept when a source ends |
