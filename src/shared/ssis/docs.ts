// Renders the generated part of docs/integration-services.md from the catalogue: everything after `generatedMarker`.
// tests/ssis-catalog.test.ts keeps the file in sync and leaves the hand-written part above the marker as it is.
import {
  catalogDatabase, describeTargets, describeViews, executableResults, loggingLevels, messageSourceTypes, messageTypes, operationStatuses, operationTypes, openStatuses,
  parameterObjectTypes, permissionTypes, referenceTypes, securableTypes, ssisErrorCodes, ssisErrorRetryable, ssisFeatureSources, ssisFeatures, ssisLimits, systemParameters,
  valueTypes, finalStatuses, type CodeLabel
} from './catalog.ts'
import { folderSpecs, kindSpecs } from '../explorer/catalog.ts'

export const generatedMarker = '<!-- Generated below from src/shared/ssis/catalog.ts. Regenerate with: npx vitest run tests/ssis-catalog.test.ts -u -->'

const cell = (value: string) => value.replaceAll('|', '\\|')
const row = (cells: readonly string[]) => '| ' + cells.map(cell).join(' | ') + ' |'
const table = (header: readonly string[], rows: readonly (readonly string[])[]) => [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n')
const code = (value: string | number) => '`' + value + '`'
const codes = (rows: readonly CodeLabel[]) => table(['Code', 'Meaning'], rows.map(item => [code(item.code), item.label]))
const versions: Readonly<Record<number, string>> = { 13: '2016', 14: '2017', 15: '2019', 16: '2022', 17: '2025' }

const limitNotes: Readonly<Record<keyof typeof ssisLimits, string>> = {
  name: 'UTF-16 code units in a folder, project, environment, parameter or variable name (sysname)',
  packageName: 'UTF-16 code units in a package name (`catalog.packages.name` is nvarchar(260))',
  description: 'Characters in a description',
  value: 'Characters of a parameter, variable or catalog property value; a longer one ends in "…"',
  rows: 'Rows one describe list holds (packages, parameters, references, variables, properties); more set `truncated`',
  describeBytes: 'Estimated bytes of one describe answer; rows past it set `truncated`',
  revision: 'Characters in a revision (a SHA-256 in hex)',
  messageChars: 'Characters in an error message',
  describeMs: 'A describe\'s budget, in ms, answered as `TIMEOUT`',
  gateWaitMs: 'How long a request waits for an SSIS read gate before `BUSY`, in ms',
  readPerConnection: 'SSIS reads at once per connection',
  readTotal: 'SSIS reads at once in all',
  registered: 'SSIS requests registered at once',
  cancelIds: 'Request ids per `varia:ssis-cancel`',
  tombstones: 'Ids main remembers that were cancelled before they were sent',
  tombstoneMs: 'How long main remembers them, in ms',
  readLockTimeoutMs: 'LOCK_TIMEOUT of the tree\'s and describe\'s reads, in ms',
  profileLockTimeoutMs: 'LOCK_TIMEOUT of the profile read (its role checks), in ms'
}

const viewNotes: Readonly<Record<typeof describeViews[number], string>> = {
  catalog: 'The connection\'s profile (band, engine, host platform, authentication, RCSI, features, roles), the folders the login may read, and `catalog_properties` for ssis_admin and sysadmin',
  folder: 'Id, name, description, creator, created time, and its project and environment counts',
  project: 'Its row (deployment, version LSN, validation), its packages, its parameters (object type 20) and its environment references',
  package: 'Its row (format, version, entry point, validation) and its parameters (object type 30)',
  environment: 'Its row and its variables; a sensitive variable\'s value is never read'
}

export function renderSsisDocs(): string {
  const tree = (['integrationServicesCatalogs', 'ssisProjects', 'ssisEnvironments', 'ssisPackages'] as const).map(id => folderSpecs[id])
  return [
    generatedMarker,
    '',
    '## Catalogue reference',
    '',
    'Everything below comes from `src/shared/ssis/catalog.ts`, which the backend embeds as `backend/Varia.Backend/Ssis/ssis-catalog.json`.',
    `The catalog is the database ${code(catalogDatabase)} (SSMS fixes the name; only an internal test option points the backend at a fake catalog).`,
    '',
    '### The tree',
    '',
    'Object Explorer serves the catalog as SSMS does, from SQL Server 2016: the server\'s Integration Services Catalogs folder lists the',
    'catalog\'s database when it exists, the catalog lists its folders directly, a folder has Projects and Environments, and a project',
    'has Packages. Packages list in deployment order (`package_id`), because a package name can be longer than a sysname cursor key; a',
    'package that is not an entry point has the subtype `child`. On SQL Server on Linux the folder says the catalog is not supported. The',
    'kinds, folders and their identity are in docs/object-explorer.md.',
    '',
    table(['Folder', 'Id', 'Lists (query)', 'Filters'], tree.map(spec => [spec.label, code(spec.id), `${(spec.rows ?? []).map(kind => kindSpecs[kind].title).join(', ')} (${code(spec.list!)})`,
      spec.filter?.length ? 'Name' : '—'])),
    '',
    'The catalog\'s listings run on the SSIS read pool (the program name plus " - Integration Services"), whose connections are in the',
    'catalog\'s database, at READ UNCOMMITTED with `LOCK_TIMEOUT 5000`. The catalog row itself is read from `sys.databases` on the Object',
    'Explorer pool. A catalog that was dropped answers `NOT_FOUND` (refresh the parent); one that is offline, restoring or single-user in',
    'use, `DATABASE_UNAVAILABLE` (retry); one the login cannot open, `NO_DB_ACCESS`.',
    '',
    '### Reads (`ssis.describe`)',
    '',
    'One request reads one view in one batch, under the SSIS gates, and answers its model with a `revision`, or an error value. The',
    'revision is a SHA-256 of what a later write depends on (names, descriptions, a project\'s deployment, parameter values,',
    'references, variables, catalog properties), not of validation results or counts, which change without a write; a truncated answer',
    'has none.',
    'Reads run READ COMMITTED when the catalog\'s database has READ_COMMITTED_SNAPSHOT on, otherwise READ UNCOMMITTED, with',
    `\`LOCK_TIMEOUT ${ssisLimits.readLockTimeoutMs}\`; a read that meets the catalog's cleanup moving rows (error 601) reads once more. The first read on a`,
    'connection also reads its profile, with the role checks at the live reads\' `LOCK_TIMEOUT 1000`, because `IS_MEMBER` waits on a pending',
    'change to a role\'s members; a sysadmin\'s are not evaluated.',
    '',
    table(['View', 'Describes', 'Model'], describeViews.map(view => [code(view), code(describeTargets[view]), viewNotes[view]])),
    '',
    table(['Feature', 'Found when the catalog has'], ssisFeatures.map(feature => [code(feature), code(ssisFeatureSources[feature])])),
    '',
    table(['Error', 'Retry helps'], ssisErrorCodes.map(item => [code(item), ssisErrorRetryable[item] ? 'Yes' : 'No'])),
    '',
    '### Code tables',
    '',
    `Operation types (\`catalog.operations.operation_type\`):`,
    '',
    codes(operationTypes),
    '',
    `Operation statuses; open: ${openStatuses.map(code).join(', ')}, final: ${finalStatuses.map(code).join(', ')}:`,
    '',
    codes(operationStatuses),
    '',
    'Message types, with the tone a log row takes:',
    '',
    table(['Code', 'Meaning', 'Tone'], messageTypes.map(item => [code(item.code), item.label, item.tone])),
    '',
    'Message source types:',
    '',
    codes(messageSourceTypes),
    '',
    'Executable results:',
    '',
    codes(executableResults),
    '',
    'Logging levels:',
    '',
    table(['Code', 'Meaning', 'Since'], loggingLevels.map(item => [code(item.code), item.label, item.since ? `${versions[item.since]} (${item.since})` : '—'])),
    '',
    'Parameter object types:',
    '',
    codes(parameterObjectTypes),
    '',
    `System parameters an execution may set: ${systemParameters.map(code).join(', ')}. \`SYNCHRONIZED\` is absent by design.`,
    '',
    'Securable types and permissions:',
    '',
    codes(securableTypes),
    '',
    table(['Code', 'Permission', 'On'], permissionTypes.map(item => [code(item.code), item.label, item.on.map(on => securableTypes.find(type => type.code === on)!.label).join(', ')])),
    '',
    `Environment reference types: ${referenceTypes.map(item => `${code(item.code)} ${item.label}`).join(', ')}. Parameter value types: ${valueTypes.map(item => `${code(item.code)} ${item.label}`).join(', ')}.`,
    '',
    '### Limits',
    '',
    table(['Limit', 'Value', 'Meaning'], (Object.keys(limitNotes) as (keyof typeof ssisLimits)[]).map(key => [code(key), ssisLimits[key].toLocaleString('en-US'), limitNotes[key]])),
    ''
  ].join('\n')
}
