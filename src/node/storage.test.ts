import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { chmod, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configDirPath, configFilePath, fileTokenStorage } from './storage'
import type { NodeSession } from './types'

// Permission bits are not enforced for root (uid 0) and node:fs chmod modes are
// not meaningful on Windows, so the permission-error tests below can't run there.
const canEnforcePermissions =
  process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

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

  it('takes over a lock left behind by a process that died, once it is stale', async () => {
    const storage = fileTokenStorage('my-cli')
    await storage.write(session) // ensures the config dir exists
    const lockPath = `${configFilePath('my-cli')}.lock`
    writeFileSync(lockPath, '')
    // Older than LOCK_STALE_MS (120s) but comfortably within LOCK_TIMEOUT_MS
    // (10s) of "now" being irrelevant here — the point is the takeover must
    // not wait out the full retry loop.
    const staleTime = new Date(Date.now() - 130_000)
    await utimes(lockPath, staleTime, staleTime)

    const start = Date.now()
    await expect(storage.withLock(async () => 'took it over')).resolves.toBe('took it over')
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  it.skipIf(!canEnforcePermissions)('throws when the session file exists but cannot be read', async () => {
    const storage = fileTokenStorage('my-cli')
    await storage.write(session)
    const path = configFilePath('my-cli')
    await chmod(path, 0o000)

    try {
      await expect(storage.read()).rejects.toThrow()
    } finally {
      await chmod(path, 0o600)
    }
  })

  it.skipIf(!canEnforcePermissions)(
    'withLock fails fast with the underlying error when the lock file cannot be created',
    async () => {
      const storage = fileTokenStorage('my-cli')
      await storage.write(session) // creates the config dir
      const dir = configDirPath('my-cli')
      await chmod(dir, 0o500) // read + execute only: no permission to create a file in it

      try {
        const start = Date.now()
        await expect(storage.withLock(async () => 'never')).rejects.toThrow(/Could not create lock file/)
        // Must fail immediately, not after LOCK_TIMEOUT_MS (10s) of retrying.
        expect(Date.now() - start).toBeLessThan(5_000)
      } finally {
        await chmod(dir, 0o700)
      }
    },
    15_000,
  )
})
