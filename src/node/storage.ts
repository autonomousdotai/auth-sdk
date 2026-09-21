import { constants } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { NodeSession, NodeTokenStorage } from './types.js'

// Invariant: LOCK_STALE_MS > oauth's TOKEN_TIMEOUT_MS > LOCK_TIMEOUT_MS. The
// longest thing that legitimately runs inside the lock is the refresh POST,
// bounded by oauth.ts's token timeout; a lock is only ever taken over once
// its holder could not possibly still be doing that work, and a waiter gives
// up well before it would consider the lock stale itself.
const LOCK_TIMEOUT_MS = 10_000
const LOCK_STALE_MS = 120_000
const LOCK_RETRY_MS = 50

/** The directory a CLI's session file lives in. */
export function configDirPath(appName: string): string {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, appName)
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, appName)
}

export function configFilePath(appName: string): string {
  return join(configDirPath(appName), 'auth.json')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const errorCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined

/** Session storage in a file only this user can read. */
export function fileTokenStorage(appName: string): NodeTokenStorage {
  const path = configFilePath(appName)
  const lockPath = `${path}.lock`
  // Serializes withLock calls made on this instance in invocation order. The file
  // lock below is what makes withLock safe *across processes*; without this queue,
  // two calls from the *same* process would race each other for the file lock with
  // no ordering guarantee at all.
  let queue: Promise<void> = Promise.resolve()

  const ensureDir = async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  }

  const acquireLock = async () => {
    await ensureDir()
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    for (;;) {
      try {
        const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
        await handle.close()
        return
      } catch (err) {
        if (errorCode(err) !== 'EEXIST') {
          // Not "the lock is held" — a real problem (permissions, no space, ...).
          // Surface it instead of retrying for LOCK_TIMEOUT_MS and reporting a
          // misleading timeout.
          const wrapped = new Error(`Could not create lock file ${lockPath}: ${(err as Error).message}`)
          ;(wrapped as Error & { cause?: unknown }).cause = err
          throw wrapped
        }
        const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0)
        if (age > LOCK_STALE_MS) {
          // The process holding it died; take it over.
          await rm(lockPath, { force: true })
          continue
        }
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${lockPath}`)
        }
        await sleep(LOCK_RETRY_MS)
      }
    }
  }

  return {
    async read() {
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (err) {
        const code = errorCode(err)
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return null
        }
        // A real filesystem problem (e.g. EACCES, EISDIR) is not "signed out".
        throw err
      }
      try {
        const parsed = JSON.parse(raw) as NodeSession
        return parsed && typeof parsed.accessToken === 'string' ? parsed : null
      } catch {
        // A half-written or hand-edited file is not a session; leave it alone.
        return null
      }
    },

    async write(session) {
      await ensureDir()
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, path)
    },

    async clear() {
      await rm(path, { force: true })
    },

    async withLock(fn) {
      const previous = queue
      let release: () => void
      queue = new Promise((resolve) => {
        release = resolve
      })
      await previous
      try {
        await acquireLock()
        try {
          return await fn()
        } finally {
          await rm(lockPath, { force: true })
        }
      } finally {
        release!()
      }
    },
  }
}
