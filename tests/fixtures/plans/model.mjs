// The fake backend's known multi-statement fixture. C# checks parse the accompanying XML with the real parser.
const node = (id, physicalOp, extra = {}) => ({ id, nodeId: id, physicalOp, parentId: null, logicalOp: physicalOp, object: '', estimatedRows: 1,
  estimatedCost: 0.1, actualRows: null, elapsedMs: null, cpuMs: null, executions: null, warnings: [], properties: [], ...extra })
export const fixturePlan = { version: '1.6', build: '16.0.1000.6', notices: [], statements: [
  { id: 's0', text: "SELECT SUM(Amount) FROM dbo.Orders WHERE Status = N'完了'", type: 'SELECT', estimatedCost: 0.45, warnings: ['Missing index (estimated impact 72.4%)'], nodes: [
    node('s0n1', 'Stream Aggregate', { actualRows: 1, elapsedMs: 42, cpuMs: 12 }),
    node('s0n2', 'Index Scan', { parentId: 's0n1', object: '[Sales].[dbo].[Orders].[IX_Status]', actualRows: 100, estimatedRows: 100, elapsedMs: 40, cpuMs: 18,
      warnings: ['PlanAffectingConvert'], properties: [{ name: 'ScalarOperator.ScalarString', value: "[Status]=N'完了'" }] })
  ] },
  { id: 's1', text: 'SELECT Name FROM dbo.Customers', type: 'SELECT', estimatedCost: 0.03, warnings: [], nodes: [node('s1n1', 'Future SQL Operator', { object: '[Sales].[dbo].[Customers]' })] }
] }
