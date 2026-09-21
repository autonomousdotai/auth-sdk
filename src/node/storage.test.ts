import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configFilePath, fileTokenStorage } from './storage'
import type { NodeSession } from './types'

const session: NodeSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: 1_800_000_000_000,
  scope: 'openid email',
  deviceName: 'test-host',
  obtainedAt: 1_700_000_000_000,
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'auth-sdk-'))
  process.env.XDG_CONFIG_HOME = home
})

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME
})

describe('fileTokenStorage', () => {
  it('writes the session to the app config file with owner-only permissions', async () => {
    const storage = fileTokenStorage('my-cli')
    await storage.write(session)

    const path = configFilePath('my-cli')
    expect(path).toBe(join(home, 'my-cli', 'auth.json'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(session)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, 'my-cli')).mode & 0o777).toBe(0o700)
    await expect(storage.read()).resolves.toEqual(session)
  })

  it('reads nothing when there is no file, and forgets the session on clear', async () => {
    const storage = fileTokenStorage('my-cli')
    await expect(storage.read()).resolves.toBeNull()
    await storage.write(session)
    await storage.clear()
    await expect(storage.read()).resolves.toBeNull()
  })

  it('treats a corrupt file as no session and leaves it in place', async () => {
    const storage = fileTokenStorage('my-cli')
    await storage.write(session)
    writeFileSync(configFilePath('my-cli'), '{ not json')

    await expect(storage.read()).resolves.toBeNull()
    expect(readFileSync(configFilePath('my-cli'), 'utf8')).toBe('{ not json')
  })

  it('runs one locked section at a time and releases the lock afterwards', async () => {
    const storage = fileTokenStorage('my-cli')
    const order: string[] = []
    const slow = storage.withLock(async () => {
      order.push('first in')
      await new Promise((resolve) => setTimeout(resolve, 60))
      order.push('first out')
    })
    const fast = storage.withLock(async () => {
      order.push('second in')
    })

    await Promise.all([slow, fast])

    expect(order).toEqual(['first in', 'first out', 'second in'])
    await expect(storage.withLock(async () => 'free')).resolves.toBe('free')
  })

  it('releases the lock when the locked section throws', async () => {
    const storage = fileTokenStorage('my-cli')
    await expect(storage.withLock(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(storage.withLock(async () => 'free')).resolves.toBe('free')
  })
})
