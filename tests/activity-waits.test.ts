import { describe, expect, it } from 'vitest'
import { benignWaits, waitCategories, waitCategoryOf } from '../src/shared/activity/catalog'

const label = (waitType: string) => {
  const { category, benign } = waitCategoryOf(waitType)
  return waitCategories.find(spec => spec.id === category)!.label + (benign ? ' (benign)' : '')
}

// backend/Varia.Backend.Tests/ActivityChecks.cs classifies the same names with the embedded copy.
describe('activity monitor wait categories', () => {
  it('classifies modern wait types SSMS drops or ignores', () => {
    expect(Object.fromEntries(['SOS_SCHEDULER_YIELD', 'THREADPOOL', 'LCK_M_X_LOW_PRIORITY', 'LCK_M_SCH_M_ABORT_BLOCKERS', 'PAGEIOLATCH_SH', 'PAGELATCH_EX', 'LATCH_EX', 'CXCONSUMER',
      'CXSYNC_PORT', 'CXPACKET', 'HADR_SYNC_COMMIT', 'PREEMPTIVE_OS_WRITEFILE', 'MEMORY_ALLOCATION_EXT', 'RESOURCE_SEMAPHORE', 'WRITELOG', 'ASYNC_NETWORK_IO', 'IO_QUEUE_LIMIT',
      'POOL_LOG_RATE_GOVERNOR', 'RBIO_RG_STORAGE', 'RESOURCE_SEMAPHORE_QUERY_COMPILE', 'SQLCLR_QUANTUM_PUNISHMENT', 'XACT_OWN_TRANSACTION', 'DTC_STATE', 'FULLTEXT GATHERER', 'TRACEWRITE',
      'WAITFOR', 'BROKER_TRANSMISSION_WORK', 'DBMIRROR_SEND', 'PWAIT_HADRSIM', 'EXTERNAL_SCRIPT_NETWORK_IO'].map(name => [name, label(name)]))).toEqual({
      SOS_SCHEDULER_YIELD: 'CPU', THREADPOOL: 'Worker Thread', LCK_M_X_LOW_PRIORITY: 'Lock', LCK_M_SCH_M_ABORT_BLOCKERS: 'Lock', PAGEIOLATCH_SH: 'Buffer IO', PAGELATCH_EX: 'Buffer Latch',
      LATCH_EX: 'Latch', CXCONSUMER: 'Parallelism', CXSYNC_PORT: 'Parallelism', CXPACKET: 'Parallelism', HADR_SYNC_COMMIT: 'Replication', PREEMPTIVE_OS_WRITEFILE: 'Preemptive',
      MEMORY_ALLOCATION_EXT: 'Memory', RESOURCE_SEMAPHORE: 'Memory', WRITELOG: 'Tran Log IO', ASYNC_NETWORK_IO: 'Network IO', IO_QUEUE_LIMIT: 'Other Disk IO',
      POOL_LOG_RATE_GOVERNOR: 'Log Rate Governor', RBIO_RG_STORAGE: 'Log Rate Governor', RESOURCE_SEMAPHORE_QUERY_COMPILE: 'Compilation', SQLCLR_QUANTUM_PUNISHMENT: 'SQL CLR',
      XACT_OWN_TRANSACTION: 'Transaction', DTC_STATE: 'Transaction', 'FULLTEXT GATHERER': 'Full Text Search', TRACEWRITE: 'Tracing', WAITFOR: 'User Wait',
      BROKER_TRANSMISSION_WORK: 'Service Broker', DBMIRROR_SEND: 'Mirroring', PWAIT_HADRSIM: 'Replication', EXTERNAL_SCRIPT_NETWORK_IO: 'Network IO'
    })
  })
  it('applies Query Store\'s exceptions before its patterns', () => {
    expect([label('BROKER_RECEIVE_WAITFOR'), label('HADR_THROTTLE_LOG_RATE_GOVERNOR')]).toEqual(['User Wait', 'Log Rate Governor'])
  })
  it('puts benign waits in Idle before any pattern, and keeps Query Store\'s own idle waits unflagged', () => {
    for (const { name } of benignWaits) expect(label(name), name).toBe('Idle (benign)')
    // CLR%, HADR_%, BROKER_% and PREEMPTIVE_% would otherwise claim these.
    expect(['CLR_AUTO_EVENT', 'HADR_FILESTREAM_IOMGR_IOCOMPLETION', 'BROKER_TO_FLUSH', 'PREEMPTIVE_XE_GETTARGETSTATE', 'SOS_WORK_DISPATCHER'].map(label)).toEqual(Array(5).fill('Idle (benign)'))
    expect(['SLEEP_TASK', 'LAZYWRITER_SLEEP', 'XE_TIMER_EVENT', 'CHECKPOINT_QUEUE'].map(label)).toEqual(Array(4).fill('Idle'))
  })
  it('shows anything else as Unknown rather than dropping it, matching names exactly', () => {
    expect(['NEW_WAIT_2030', 'MSQL_XP', '', 'lck_m_x', 'LCK_M', 'PAGEIOLATCH'].map(label)).toEqual(Array(6).fill('Unknown'))
  })
})
