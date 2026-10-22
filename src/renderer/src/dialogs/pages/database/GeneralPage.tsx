import { useState } from 'react'
import { databaseStatusText } from '../../../../../shared/actions/database.ts'
import { displayText } from '../../../../../shared/explorer/refs.ts'
import PropertyGrid, { type GridGroup } from '../../../settings/PropertyGrid'
import type { PageProps } from '../../ObjectDialog'
import { databaseState, dateText, DescriptionPane, megabytes } from './shared'

/** Learn's General page texts (the memory-optimized labels are unverified). */
const rows = {
  lastBackup: ['Last Database Backup', 'Displays the date and time of the last full database backup.'],
  lastLogBackup: ['Last Database Log Backup', 'Displays the date and time of the last transaction log backup.'],
  name: ['Name', 'Displays the name of the database.'],
  status: ['Status', 'Displays the database state.'],
  owner: ['Owner', 'Displays the name of the database owner. The owner can be changed on the Files page.'],
  created: ['Date Created', 'Displays the date and time that the database was created.'],
  size: ['Size', 'Displays the size of the database in megabytes.'],
  spaceAvailable: ['Space Available', 'Displays the amount of available space in the database in megabytes.'],
  users: ['Number of Users', 'Displays the number of users configured for the database.'],
  memoryAllocated: ['Memory Allocated To Memory Optimized Objects', 'Memory allocated to memory-optimized tables and indexes, in megabytes (needs VIEW DATABASE STATE).'],
  memoryUsed: ['Memory Used By Memory Optimized Objects', 'Memory used by memory-optimized tables and indexes, in megabytes (needs VIEW DATABASE STATE).'],
  collation: ['Collation', 'Displays the collation used for the database. The collation can be changed on the Options page.']
} as const

/** Database Properties' General page: SSMS's read-only facts under Backup, Database and Maintenance. */
export default function GeneralPage({ open }: PageProps) {
  const [focused, setFocused] = useState<keyof typeof rows>()
  const { model } = databaseState(open)
  if (!model) return <p className="field-note">{open.phase === 'loading' ? 'Loading…' : ''}</p>
  const general = model.general
  const values: Record<keyof typeof rows, string> = {
    lastBackup: dateText(general.lastBackup), lastLogBackup: dateText(general.lastLogBackup), name: displayText(general.name), status: databaseStatusText(general.status, { standby: general.standby, readOnly: model.options.readOnly === 'true' }),
    owner: general.owner ? displayText(general.owner) : '', created: dateText(general.created), size: megabytes(general.sizeMb), spaceAvailable: megabytes(general.spaceAvailableMb),
    users: general.users === undefined ? '' : String(general.users), memoryAllocated: megabytes(general.memoryAllocatedMb), memoryUsed: megabytes(general.memoryUsedMb),
    collation: general.collation ?? ''
  }
  const row = (key: keyof typeof rows) => ({ key, label: rows[key][0], description: rows[key][1], control: 'readonly' as const, value: values[key], changed: false, disabled: false })
  const groups: GridGroup[] = [
    { label: 'Backup', rows: [row('lastBackup'), row('lastLogBackup')] },
    { label: 'Database', rows: [row('name'), row('status'), row('owner'), row('created'), row('size'), row('spaceAvailable'), row('users'), row('memoryAllocated'), row('memoryUsed')] },
    { label: 'Maintenance', rows: [row('collation')] }
  ]
  return <div className="database-page">
    <PropertyGrid label="General" groups={groups} idPrefix="database-general-" focused={focused} onFocusRow={key => setFocused(key as keyof typeof rows)} onChange={() => {}} />
    <DescriptionPane title={focused ? rows[focused][0] : 'General'} text={focused ? rows[focused][1] : ''} />
  </div>
}
