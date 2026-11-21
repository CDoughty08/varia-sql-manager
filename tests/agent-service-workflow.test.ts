import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// SQL Server Agent's service control (AG-2) needs Windows' Service Control Manager, so it has a workflow of its own
// (docs/ci.md): a named instance on a Windows runner, never a required check, and cheap for pull requests that do not touch it.
const yaml = readFileSync('.github/workflows/agent-service.yml', 'utf8')
const on = yaml.slice(yaml.indexOf('\non:'), yaml.indexOf('\nconcurrency:'))

describe('the Agent service workflow', () => {
  it('runs for pull requests that touch service control, daily, and on demand', () => {
    expect(on).toMatch(/\n {2}pull_request:\n {4}paths:\n/)
    expect([...on.matchAll(/^ {6}- (\S+)$/gm)].map(match => match[1])).toEqual([
      '.github/workflows/agent-service.yml', 'backend/Varia.Backend/Agent/**', 'backend/Varia.Backend/Actions/AgentJobs.cs',
      // The service verbs' dispatch and preflight, and the ServiceController package they call.
      'backend/Varia.Backend/Actions/ActionService.cs', 'backend/Varia.Backend/Varia.Backend.csproj', 'backend/Varia.Backend/packages.lock.json',
      'backend/Varia.Backend.Tests/AgentActionLiveChecks.cs', 'backend/Varia.Backend.Tests/AgentLiveChecks.cs', 'backend/Varia.Backend.Tests/LiveGroups.cs'
    ])
    expect(on).toMatch(/\n {2}schedule:\n {4}- cron: '[^']+'\n {2}workflow_dispatch:\n/)
    expect(on).not.toContain('push:')
  })
  it('cancels a pull request\'s superseded run and reads nothing it does not need', () => {
    expect(yaml).toContain("\nconcurrency:\n  group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}\n  cancel-in-progress: true\n")
    expect(yaml).toContain('\npermissions:\n  contents: read\n')
    expect(yaml).toContain('persist-credentials: false')
  })
  it('stops and starts a named instance\'s real Agent on Windows, with Windows authentication and no password', () => {
    expect(yaml).toMatch(/runs-on: windows-\d+/)
    expect(yaml).toContain('/INSTANCENAME:VARIA')
    expect(yaml).toContain("VARIA_TEST_SQL_AGENT_SERVICE: '1'")
    expect(yaml).toContain('-- --live-suite Agent,AgentService\n')
    expect(yaml).not.toMatch(/VARIA_TEST_SQL_(USER|PASSWORD)|SAPWD/)
  })
  it('is not part of ci.yml, so the required "CI result" check never waits on it', () => {
    expect(readFileSync('.github/workflows/ci.yml', 'utf8')).not.toContain('VARIA_TEST_SQL_AGENT_SERVICE')
  })
})
