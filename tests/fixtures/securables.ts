// The Securables page's lists (D2d) for the renderer's tests: the catalogue's permissions per type, as a SQL Server 2025 lists them,
// and a few objects of each named type.
import { securableSpecs, type SecurablesModel } from '../../src/shared/actions/securables'

export const securablesModel = (changes: Partial<SecurablesModel> = {}): SecurablesModel => ({
  server: 'DEV-SQL',
  permissions: {
    server: securableSpecs.server.permissions, endpoint: securableSpecs.endpoint.permissions, login: securableSpecs.login.permissions,
    serverRole: securableSpecs.serverRole.permissions, availabilityGroup: securableSpecs.availabilityGroup.permissions
  },
  objects: { endpoint: ['Dedicated Admin Connection', 'TSQL Default TCP'], login: ['app', 'sa'], serverRole: ['auditors'], availabilityGroup: [] },
  truncated: false,
  ...changes
})
