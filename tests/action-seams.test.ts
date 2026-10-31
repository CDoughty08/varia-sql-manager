// Wave 5's shared seams (PR W5-0b): the server engines actions run on, the login rules, the widened action step and its
// bounds in main, secrets only on actions.execute, and no Varia source that reads a password hash or LOGINPROPERTY.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { requestSchemas, resultSchemas, validateResult } from '../src/main/validation'
import { methodPolicies } from '../src/shared/ipc/methods'
import { actionLimits, actionServes, actionsCatalogJson, objectActions, objectActionSpecs } from '../src/shared/actions/catalog'
import { actionExecuteResultSchema, actionScriptRequestSchema, actionStepSchema } from '../src/shared/actions/schema'
import {
  loginLimits, loginMessages, loginRefusal, loginRules, loginsCatalog, loginSubtypeOf, loginSubtypes, loginVerbs, type LoginFacts, type LoginSubtype, type LoginVerb
} from '../src/shared/actions/logins'
import { kindSpecs, nodeSubtypes, serverEngineOf, serverEngines } from '../src/shared/explorer/catalog'
import { designerCatalogJson, designerEngines } from '../src/shared/designer/catalog'

const uuid = () => crypto.randomUUID()
const rename = () => ({ action: 'rename', connectionId: uuid(), requestId: uuid(), target: { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' }, newName: 'Orders2' })

describe('server engines', () => {
  it('tells Managed Instance apart from the box editions and the cloud', () => {
    expect([1, 2, 3, 4, 8, 5, 6, 9, 11, 12].map(serverEngineOf)).toEqual(['box', 'box', 'box', 'box', 'managedInstance', 'cloud', 'cloud', 'cloud', 'cloud', 'cloud'])
    expect(serverEngines).toEqual(['box', 'managedInstance', 'cloud'])
  })
  it('lets each action declare the engines it runs on, and the backend reads them from the catalogue', () => {
    expect(objectActions.filter(action => actionServes(action, 'cloud'))).toEqual(['selectTop'])
    // Attach is SQL Server's box editions' alone (decision 10).
    expect(objectActions.filter(action => actionServes(action, 'managedInstance'))).toEqual(objectActions.filter(action => action !== 'attach'))
    expect(objectActions.filter(action => !actionServes(action, 'managedInstance'))).toEqual(['attach'])
    const json = JSON.parse(actionsCatalogJson()) as { version: number; actions: { action: string; engines: string[]; cleanupMs: number }[]; limits: Record<string, number> }
    expect(json.version).toBe(3)
    for (const row of json.actions) {
      expect(row.engines, row.action).toEqual([...objectActionSpecs[row.action as keyof typeof objectActionSpecs].engines])
      expect(row.cleanupMs, row.action).toBe(actionLimits.cleanupMs)
    }
    expect(json.limits.cleanupMs).toBe(10_000)
    expect(designerEngines).toEqual(['box', 'managedInstance'])
    expect(JSON.parse(designerCatalogJson()).engines).toEqual(['box', 'managedInstance'])
  })
})

describe('login rules', () => {
  it('derives a subtype as the backend does: sa by principal_id, SQL Server\'s own by ##name##, else by type', () => {
    const cases: [number, string, string, LoginSubtype | undefined][] = [
      [1, 'S', 'renamed_sa', 'sa'], [1, 'S ', 'sa', 'sa'], [270, 'C', '##MS_PolicySigningCertificate##', 'system'], [270, 'S', '##MS_PolicyTsqlExecutionLogin##', 'system'],
      [300, 'S', '##', 'sql'], [300, 'S', 'app', 'sql'], [300, 'U', 'D\\u', 'windowsUser'], [300, 'G', 'D\\g', 'windowsGroup'], [300, 'C', 'c', 'certificateMapped'],
      [300, 'K', 'k', 'asymmetricKeyMapped'], [300, 'E', 'e@x', 'externalUser'], [300, 'X', 'g', 'externalGroup'], [3, 'R', 'sysadmin', undefined]
    ]
    expect(cases.map(([id, type, name]) => loginSubtypeOf(id, type, name))).toEqual(cases.map(item => item[3]))
  })
  it('refuses verbs by the protected-principal rules, the own login and the permissions (the same table as SeamChecks.Logins)', () => {
    const facts = (subtype: LoginSubtype, extra: Partial<LoginFacts> = {}) => ({ subtype, own: false, sysadmin: false, canAlter: true, canControlServer: true, ...extra })
    const cases: [ReturnType<typeof facts>, LoginVerb, keyof typeof loginMessages | undefined][] = [
      [facts('sa'), 'delete', 'saDelete'], [facts('sa'), 'disable', undefined], [facts('system'), 'rename', 'system'], [facts('system'), 'enable', 'system'],
      [facts('windowsGroup'), 'disable', 'windowsGroupDisable'], [facts('windowsGroup'), 'enable', 'notOffered'], [facts('windowsUser'), 'unlock', 'notOffered'],
      [facts('externalUser'), 'rename', 'externalRename'], [facts('externalGroup'), 'delete', undefined], [facts('sql'), 'unlock', undefined],
      [facts('sql', { own: true }), 'disable', 'own'], [facts('sql', { own: true }), 'rename', 'own'], [facts('sql', { own: true }), 'delete', 'own'], [facts('sql', { own: true }), 'enable', undefined],
      [facts('sql', { canAlter: false }), 'rename', 'alterAnyLogin'], [facts('sql', { sysadmin: true, canControlServer: false }), 'disable', 'controlServer'], [facts('sql', { sysadmin: true }), 'disable', undefined]
    ]
    expect(cases.map(([value, verb]) => loginRefusal(value, verb))).toEqual(cases.map(item => item[2]))
  })
  it('covers every subtype in Object Explorer and in the backend\'s copy, with a reason for each greyed verb', () => {
    expect(kindSpecs.login.subtypes).toEqual([...loginSubtypes])
    for (const subtype of loginSubtypes) expect((nodeSubtypes as readonly string[]).includes(subtype), subtype).toBe(true)
    const catalog = loginsCatalog()
    expect(catalog.rules.map(rule => rule.subtype)).toEqual([...loginSubtypes])
    for (const rule of catalog.rules) for (const verb of loginVerbs) {
      expect(rule[verb]).toBe(loginRules[rule.subtype][verb])
      expect(verb in rule.greyed, `${rule.subtype} ${verb}`).toBe(rule[verb] === 'greyed')
    }
    expect(JSON.parse(actionsCatalogJson()).logins).toEqual(JSON.parse(JSON.stringify(catalog)))
  })
})

describe('action steps and secrets', () => {
  it('checks actions.execute\'s answer in main with the bounds C# clips to (ActionSteps.Bound)', () => {
    const ok = { status: 'failed', title: 'Rename', message: 'm', detail: 'd', compensates: true, progress: 100 }
    expect(actionStepSchema.safeParse(ok).success).toBe(true)
    for (const bad of [{ status: 'done' }, { ...ok, title: 't'.repeat(loginLimits.stepTitle + 1) }, { ...ok, detail: 'd'.repeat(loginLimits.stepDetail + 1) },
      { ...ok, message: 'm'.repeat(actionLimits.messageChars + 1) }, { ...ok, progress: 101 }, { ...ok, progress: 1.5 }, { ...ok, status: 'undone' }, { ...ok, extra: 1 }]) {
      expect(actionStepSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false)
    }
    const answer = { steps: [{ status: 'done', title: 'Rename' }], messages: ['Caution'], elapsedMs: 1 }
    expect(resultSchemas['actions.execute']).toBe(actionExecuteResultSchema)
    expect(validateResult('actions.execute', answer)).toEqual(answer)
    expect(() => validateResult('actions.execute', { ...answer, steps: [{ status: 'done', message: 'Rename' }] })).toThrow()
    expect(() => validateResult('actions.execute', { ...answer, steps: Array.from({ length: actionLimits.statements + 9 }, () => ({ status: 'done', title: 'x' })) })).toThrow()
    expect(() => validateResult('actions.execute', { ...answer, error: { code: 'NOPE', message: 'x', retryable: false } })).toThrow()
  })
  it('never lets a secret cross on actions.script, and zeroes actions.execute\'s frames as a whole', () => {
    expect(requestSchemas['actions.script']).toBe(actionScriptRequestSchema)
    expect(actionScriptRequestSchema.safeParse(rename()).success).toBe(true)
    expect(actionScriptRequestSchema.safeParse({ ...rename(), secrets: { password: 'Throwaway-1' } }).success).toBe(false)
    expect(actionScriptRequestSchema.safeParse({ ...rename(), secrets: undefined }).success).toBe(false)
    // No action takes one yet: execute's strict schemas refuse it too, until New Login (D4) adds its own.
    expect(requestSchemas['actions.execute'].safeParse({ ...rename(), secrets: { password: 'Throwaway-1' } }).success).toBe(false)
    expect(methodPolicies['actions.execute'].sensitive).toBe(true)
    expect(methodPolicies['actions.script'].sensitive).toBeUndefined()
  })
})

describe('password hashes', () => {
  const files = (dir: string, pattern: RegExp): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return ['bin', 'obj', 'node_modules'].includes(entry.name) ? [] : files(path, pattern)
    return pattern.test(entry.name) ? [path] : []
  })
  it('appear in no Varia source but the lint lists that refuse them and comments (critic A15)', () => {
    const root = join(__dirname, '..')
    const sources = [...files(join(root, 'backend', 'Varia.Backend'), /\.cs$/), ...files(join(root, 'src'), /\.tsx?$/)]
    const offending: string[] = []
    for (const file of sources) {
      const name = relative(root, file).replaceAll('\\', '/')
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        const comment = /^\s*(\/\/|\*|\/\*\*)/.test(line)
        // CatalogSql.SecretUses, the lint every other lint calls.
        const lint = name === 'backend/Varia.Backend/Explorer/CatalogSql.cs'
          && /^\s*(if \(LoginFunction\(\)\.IsMatch|foreach \(var token in new\[\] \{ "password_hash", "PasswordHash" \}|\[GeneratedRegex\(@"\\bLOGINPROPERTY|if \(text\.Contains\("sql_logins")/.test(line)
        // A star over sys.sql_logins reads password_hash without naming it (COUNT(*) aside).
        if (/sql_logins/i.test(line) && /(?<!\(\s*)\*/.test(line) && !comment && !lint) offending.push(`${name}:${index + 1} (*)`)
        if (!/password_?hash|LOGINPROPERTY/i.test(line)) return
        const list = line.includes('"LOGINPROPERTY(", "password_hash", "PasswordHash"')
        const docs = name === 'src/shared/actions/docs.ts' && !/password_?hash/i.test(line)
        if (!comment && !list && !docs && !lint) offending.push(`${name}:${index + 1}`)
      })
    }
    expect(offending).toEqual([])
    const catalogSql = readFileSync(join(root, 'backend', 'Varia.Backend', 'Explorer', 'CatalogSql.cs'), 'utf8')
    expect(catalogSql).toContain('"LOGINPROPERTY(", "password_hash", "PasswordHash"]')
    expect(catalogSql).toContain('[GeneratedRegex(@"\\bLOGINPROPERTY\\s*\\(", RegexOptions.IgnoreCase)]')
  })
})
