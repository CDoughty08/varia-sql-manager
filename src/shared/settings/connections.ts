import type { SettingDef } from './types'

export const connectionSettings = [
  {
    key: 'environment.connections.autoReconnect', page: 'environment.connections', label: 'Automatically reconnect on startup', type: 'boolean', default: true, varia: true,
    keywords: ['connection', 'reconnect', 'startup', 'restore', 'server', 'sign in'],
    description: 'Makes one background attempt to reconnect remembered targets that were left connected. Each connection can use this default, turn automatic reconnect On, or turn it Off. Explicitly disconnected targets stay disconnected. Reconnect uses existing credentials or silent sign-in, never opens browser sign-in, and never runs query text.'
  }
] as const satisfies readonly SettingDef[]
