// A loopback BigQuery REST fake for smoke suites, set as VARIA_TEST_BIGQUERY_ENDPOINT (emulator mode: anonymous
// credentials, no connect probe, faked estimates). It answers what the backend asks of a query's windowed result: the
// connection's dataset, jobs.insert, getQueryResults, jobs.get with the statement and destination table, tables.get,
// tabledata.list and jobs.cancel, and the metadata lists Object Explorer and the index read on connect (empty past the one
// dataset). A query that names TABLESAMPLE answers the first `sampleRows` rows, as BigQuery's pick would. Nothing leaves
// the machine and no real project is involved (docs/bigquery.md, Testing).
import { createServer } from 'node:http'
import { gunzipSync } from 'node:zlib'

/** Starts the fake on a free loopback port; `expire(table)` makes a result table answer 404, as an expired one does. */
export async function startBigQueryRest({ project = 'varia-emulator', dataset = 'varia_fixture', rows = 60_000, sampleRows = 400 } = {}) {
  const schema = { fields: [{ name: 'n', type: 'INTEGER', mode: 'NULLABLE' }, { name: 's', type: 'STRING', mode: 'NULLABLE' }] }
  const row = i => ({ f: [{ v: String(i) }, { v: `row ${i}` }] })
  /** Result tables by id: their row count. */
  const tables = new Map()
  /** Jobs by id: the statement, its table and its rows. */
  const jobs = new Map()
  const expired = new Set()
  const inserted = []
  const unanswered = []
  let next = 0
  const reference = jobId => ({ projectId: project, jobId, location: 'US' })
  const destination = table => ({ projectId: project, datasetId: '_anon_fake', tableId: table })
  const job = (id, state = 'DONE') => {
    const entry = jobs.get(id)
    return {
      kind: 'bigquery#job', id: `${project}:US.${id}`, jobReference: reference(id), status: { state },
      configuration: { jobType: 'QUERY', query: { query: entry.query, useLegacySql: false, destinationTable: destination(entry.table), ...entry.dataset ? { defaultDataset: entry.dataset } : {} } },
      statistics: { creationTime: '1', startTime: '1', endTime: '2', query: { statementType: 'SELECT', totalBytesProcessed: '0', totalBytesBilled: '0', cacheHit: false } }
    }
  }
  const notFound = what => [404, { error: { code: 404, message: `Not found: ${what}`, errors: [{ reason: 'notFound', message: `Not found: ${what}` }] } }]
  const page = (count, query, total) => {
    const start = query.get('pageToken') ? Number(query.get('pageToken').slice(5)) : Number(query.get('startIndex') ?? 0)
    const asked = Number(query.get('maxResults') ?? 100_000)
    const end = Math.min(total, start + asked)
    return { rows: Array.from({ length: Math.max(0, end - start) }, (_, k) => row(start + k)), ...end < Math.min(total, count) ? { pageToken: `page-${end}` } : {} }
  }

  function answer(method, path, query, body) {
    const base = `/bigquery/v2/projects/${project}`
    if (method === 'GET' && path === '/bigquery/v2/projects') return [200, { kind: 'bigquery#projectList', projects: [{ id: project, numericId: '1', friendlyName: project }] }]
    if (!path.startsWith(base)) return notFound(path)
    const rest = path.slice(base.length)
    if (method === 'GET' && rest === '/datasets') return [200, { kind: 'bigquery#datasetList', datasets: [{ datasetReference: { projectId: project, datasetId: dataset }, location: 'US' }] }]
    if (method === 'GET' && rest === `/datasets/${dataset}`) return [200, { kind: 'bigquery#dataset', datasetReference: { projectId: project, datasetId: dataset }, location: 'US' }]
    if (method === 'GET' && /^\/datasets\/[^/]+\/(tables|routines|models)$/.test(rest)) return [200, { kind: 'bigquery#list' }]
    if (method === 'POST' && rest === '/jobs') {
      const config = body.configuration?.query ?? {}
      const id = body.jobReference?.jobId ?? `job_${++next}`
      const sample = /TABLESAMPLE/i.test(config.query ?? '')
      const table = `anon_${++next}`
      tables.set(table, sample ? Math.min(sampleRows, rows) : rows)
      jobs.set(id, { query: config.query ?? '', table, dataset: config.defaultDataset })
      inserted.push({ id, query: config.query ?? '', parameters: config.queryParameters ?? [] })
      return [200, job(id)]
    }
    let match = /^\/jobs\/([^/]+)\/cancel$/.exec(rest)
    if (method === 'POST' && match) return jobs.has(match[1]) ? [200, { kind: 'bigquery#jobCancelResponse', job: job(match[1]) }] : notFound(match[1])
    match = /^\/jobs\/([^/]+)$/.exec(rest)
    if (method === 'GET' && match) return jobs.has(match[1]) ? [200, job(match[1])] : notFound(match[1])
    match = /^\/queries\/([^/]+)$/.exec(rest)
    if (method === 'GET' && match) {
      const entry = jobs.get(match[1])
      if (!entry) return notFound(match[1])
      const count = tables.get(entry.table)
      return [200, { kind: 'bigquery#getQueryResultsResponse', jobReference: reference(match[1]), jobComplete: true, schema, totalRows: String(count), totalBytesProcessed: '0', cacheHit: false, ...page(count, query, count) }]
    }
    match = /^\/datasets\/_anon_fake\/tables\/([^/]+)(\/data)?$/.exec(rest)
    if (method === 'GET' && match) {
      const count = tables.get(match[1])
      if (count === undefined || expired.has(match[1])) return notFound(`Table ${project}:_anon_fake.${match[1]}`)
      if (!match[2]) return [200, { kind: 'bigquery#table', tableReference: destination(match[1]), numRows: String(count), numBytes: String(count * 20), schema }]
      return [200, { kind: 'bigquery#tableDataList', totalRows: String(count), ...page(count, query, count) }]
    }
    return notFound(path)
  }

  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => { chunks.push(chunk) })
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      let status, json
      try {
        // Google's client gzips its request bodies.
        const raw = Buffer.concat(chunks), text = (request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString('utf8')
        ;[status, json] = answer(request.method ?? 'GET', url.pathname.replace(/\/+$/, ''), url.searchParams, text ? JSON.parse(text) : {})
      }
      catch (error) { [status, json] = [500, { error: { code: 500, message: String(error), errors: [{ reason: 'backendError', message: String(error) }] } }] }
      if (status === 404 || status === 500) unanswered.push(`${request.method} ${url.pathname}${status === 500 ? ` (${json.error.message})` : ''}`)
      response.writeHead(status, { 'content-type': 'application/json; charset=UTF-8' })
      response.end(JSON.stringify(json))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    endpoint: `http://127.0.0.1:${port}`, project, dataset, inserted, unanswered,
    /** The result table the latest job wrote, by its statement's text (a substring). */
    tableOf: text => [...jobs.values()].reverse().find(entry => entry.query.includes(text))?.table,
    expire: table => { expired.add(table) },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) })
  }
}
