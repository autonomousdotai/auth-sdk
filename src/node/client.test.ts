import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNodeAuthClient } from './client'
import { openBrowser, prefersManualMode } from './environment'
import { AuthSessionError } from './errors'
import { fileTokenStorage } from './storage'
import type { NodeSession, NodeSignInIO, NodeTokenStorage } from './types'

// signIn's loopback path calls environment's openBrowser and prefersManualMode;
// wrapping both (while delegating to the real implementation by default) lets
// individual tests force "no browser could be opened" or "not an SSH/headless
// box" deterministically, regardless of the host actually running the suite.
vi.mock('./environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./environment')>()
  return { ...actual, openBrowser: vi.fn().mockResolvedValue(false), prefersManualMode: vi.fn(actual.prefersManualMode) }
})

let server: Server
let baseUrl: string
let requests: { url: string; body: URLSearchParams }[]
let tokenReply: { status: number; body: unknown }
// When set, the server waits on this promise after receiving a token request
// and before answering it — lets a test land a concurrent write while a
// request is provably still in flight.
let respondAfter: Promise<void> | null

beforeEach(async () => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'auth-sdk-'))
  requests = []
  tokenReply = { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } }
  respondAfter = null
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', async () => {
      requests.push({ url: req.url ?? '', body: new URLSearchParams(raw) })
      if (respondAfter) await respondAfter
      res.writeHead(tokenReply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(tokenReply.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  delete process.env.XDG_CONFIG_HOME
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const client = () => createNodeAuthClient({ ssoUrl: baseUrl, clientId: 'my-cli', appName: 'my-cli', deviceName: 'test-host' })

function io(answers: string[]): NodeSignInIO & { written: string[] } {
  const written: string[] = []
  return { written, write: (t) => { written.push(t) }, readLine: async () => answers.shift() ?? '' }
}

const stored = (expiresAt: number): NodeSession => ({ accessToken: 'stored', refreshToken: 'rt', expiresAt, deviceName: 'test-host', obtainedAt: 0 })

describe('signIn in manual mode', () => {
  it('prints the manual-code URL, exchanges the pasted code and stores the session', async () => {
    const auth = client()
    let printed = ''
    const answers = io([])
    answers.readLine = async () => {
      const url = new URL(printed)
      return `pasted-code#${url.searchParams.get('state')}`
    }

    const session = await auth.signIn({ mode: 'manual', io: answers, onAuthorizeUrl: (url) => { printed = url } })

    const authorizeUrl = new URL(printed)
    expect(authorizeUrl.pathname).toBe('/oauth2/authorize')
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`${baseUrl}/oauth2/code`)
    expect(Object.fromEntries(requests[0].body)).toMatchObject({
      grant_type: 'authorization_code', code: 'pasted-code', device_name: 'test-host',
      redirect_uri: `${baseUrl}/oauth2/code`,
    })
    expect(session.accessToken).toBe('at')
    expect(auth.isSignedIn()).toBe(true)
    await expect(fileTokenStorage('my-cli').read()).resolves.toMatchObject({ accessToken: 'at', deviceName: 'test-host' })
  })
})

describe('getAccessToken', () => {
  it('returns the stored token while it is still valid', async () => {
    await fileTokenStorage('my-cli').write(stored(Date.now() + 600_000))
    await expect(client().getAccessToken()).resolves.toBe('stored')
    expect(requests).toHaveLength(0)
  })

  it('refreshes an expiring token once, even when asked twice at the same time', async () => {
    await fileTokenStorage('my-cli').write(stored(Date.now() + 10_000))
    const auth = client()

    const [first, second] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()])

    expect(first).toBe('at')
    expect(second).toBe('at')
    expect(requests.filter((r) => r.body.get('grant_type') === 'refresh_token')).toHaveLength(1)
    await expect(fileTokenStorage('my-cli').read()).resolves.toMatchObject({ accessToken: 'at' })
  })

  it('clears the session when the refresh is refused', async () => {
    await fileTokenStorage('my-cli').write(stored(0))
    tokenReply = { status: 401, body: { error: { message: 'invalid_grant' } } }

    await expect(client().getAccessToken()).rejects.toMatchObject({ code: 'SIGNED_OUT' })
    await expect(fileTokenStorage('my-cli').read()).resolves.toBeNull()
  })

  it('keeps the session when the service is unavailable', async () => {
    await fileTokenStorage('my-cli').write(stored(0))
    tokenReply = { status: 503, body: {} }

    await expect(client().getAccessToken()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(fileTokenStorage('my-cli').read()).resolves.not.toBeNull()
  })

  it('does not delete a session written by another process while a refused refresh is in flight', async () => {
    await fileTokenStorage('my-cli').write(stored(0))
    let releaseResponse: () => void
    respondAfter = new Promise<void>((resolve) => { releaseResponse = resolve })
    tokenReply = { status: 401, body: { error: { message: 'invalid_grant' } } }

    const auth = client()
    const pending = auth.getAccessToken()

    // Wait until the refresh request has actually reached the server — this
    // proves the in-flight refresh already read the stale session from disk
    // — before writing a fresh session behind its back through a second
    // storage instance (standing in for another process). Only then let the
    // gated 401 response through.
    await vi.waitFor(() => {
      expect(requests.filter((r) => r.body.get('grant_type') === 'refresh_token')).toHaveLength(1)
    })
    const fresh = stored(Date.now() + 600_000)
    await fileTokenStorage('my-cli').write(fresh)
    releaseResponse!()

    await expect(pending).rejects.toMatchObject({ code: 'SIGNED_OUT' })
    await expect(fileTokenStorage('my-cli').read()).resolves.toMatchObject(fresh)
  })

  it('says there is no session at all', async () => {
    await expect(client().getAccessToken()).rejects.toMatchObject({ code: 'NO_SESSION' })
  })

  it('treats a session file removed by another process as signed out, instead of refreshing the in-memory copy', async () => {
    let reads = 0
    const fakeStorage: NodeTokenStorage = {
      // First read is the initial load() (an expired session); the in-lock
      // re-read simulates a concurrent `logout` from another process having
      // already deleted the file.
      async read() {
        reads += 1
        return reads === 1 ? stored(0) : null
      },
      async write() {},
      async clear() {},
      async withLock(fn) {
        return fn()
      },
    }
    const auth = createNodeAuthClient({ ssoUrl: baseUrl, clientId: 'my-cli', appName: 'my-cli', storage: fakeStorage })

    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'SIGNED_OUT' })
    expect(auth.isSignedIn()).toBe(false)
    expect(requests.filter((r) => r.body.get('grant_type') === 'refresh_token')).toHaveLength(0)
  })
})

describe('getAccessToken error wrapping', () => {
  it('wraps a lock-acquire timeout as AuthSessionError UNAVAILABLE instead of the raw Error', async () => {
    const lockError = new Error('Timed out waiting for /tmp/auth-sdk/auth.json.lock')
    const fakeStorage: NodeTokenStorage = {
      async read() { return stored(0) },
      async write() {},
      async clear() {},
      async withLock() { throw lockError },
    }
    const auth = createNodeAuthClient({ ssoUrl: baseUrl, clientId: 'my-cli', appName: 'my-cli', storage: fakeStorage })

    const err = await auth.getAccessToken().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(AuthSessionError)
    expect(err).toMatchObject({ code: 'UNAVAILABLE', cause: lockError })
  })

  it('wraps a raw filesystem error from read() as AuthSessionError UNAVAILABLE instead of letting it escape', async () => {
    const fsError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const fakeStorage: NodeTokenStorage = {
      async read() { throw fsError },
      async write() {},
      async clear() {},
      async withLock(fn) { return fn() },
    }
    const auth = createNodeAuthClient({ ssoUrl: baseUrl, clientId: 'my-cli', appName: 'my-cli', storage: fakeStorage })

    const err = await auth.getAccessToken().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(AuthSessionError)
    expect(err).toMatchObject({ code: 'UNAVAILABLE', cause: fsError })
  })
})

describe('loadSession', () => {
  it('is what makes the synchronous getters reflect an on-disk session', async () => {
    await fileTokenStorage('my-cli').write(stored(Date.now() + 600_000))
    const auth = client()

    expect(auth.isSignedIn()).toBe(false)
    expect(auth.getSession()).toBeNull()

    const loaded = await auth.loadSession()

    expect(loaded).toMatchObject({ accessToken: 'stored' })
    expect(auth.isSignedIn()).toBe(true)
    expect(auth.getSession()).toMatchObject({ accessToken: 'stored' })
  })
})

describe('logout', () => {
  it('revokes the refresh token and forgets the session', async () => {
    await fileTokenStorage('my-cli').write({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 60_000, deviceName: 'test-host', obtainedAt: 0 })
    const auth = client()

    await auth.logout()

    expect(requests.map((r) => r.url)).toContain('/oauth2/revoke')
    await expect(fileTokenStorage('my-cli').read()).resolves.toBeNull()
    expect(auth.isSignedIn()).toBe(false)
  })

  it('is fine when there is nothing to sign out of', async () => {
    await expect(client().logout()).resolves.toBeUndefined()
    expect(requests).toHaveLength(0)
  })
})

describe('mode selection', () => {
  it('uses the manual flow over SSH without opening a browser', async () => {
    vi.stubEnv('SSH_CONNECTION', '10.0.0.1 22')
    const auth = client()
    let printed = ''
    const answers = io([])
    answers.readLine = async () => `pasted-code#${new URL(printed).searchParams.get('state')}`

    await auth.signIn({ io: answers, onAuthorizeUrl: (url) => { printed = url } })

    expect(new URL(printed).searchParams.get('redirect_uri')).toBe(`${baseUrl}/oauth2/code`)
    vi.unstubAllEnvs()
  })

  it('fails with NO_BROWSER when the loopback flow cannot open a browser and exchanges nothing', async () => {
    const auth = client()

    await expect(auth.signIn({ mode: 'loopback', io: io([]) })).rejects.toMatchObject({ code: 'NO_BROWSER' })
    expect(requests).toHaveLength(0)
  })

  it("falls back to the manual flow when 'auto' cannot open a browser, instead of waiting out the loopback timeout", async () => {
    // Force the loopback branch even if this host happens to look headless
    // (e.g. a Linux CI runner without DISPLAY, where prefersManualMode()
    // would otherwise go straight to manual and never exercise the fallback).
    vi.mocked(prefersManualMode).mockReturnValueOnce(false)
    const auth = client()
    let printed = ''
    let printedMode: 'loopback' | 'manual' | undefined
    const answers = io([])
    answers.readLine = async () => `pasted-code#${new URL(printed).searchParams.get('state')}`

    const session = await auth.signIn({
      io: answers,
      timeoutMs: 5_000,
      onAuthorizeUrl: (url, mode) => { printed = url; printedMode = mode },
    })

    expect(printedMode).toBe('manual')
    expect(new URL(printed).searchParams.get('redirect_uri')).toBe(`${baseUrl}/oauth2/code`)
    expect(session.accessToken).toBe('at')
    expect(Object.fromEntries(requests[0].body)).toMatchObject({
      code: 'pasted-code', redirect_uri: `${baseUrl}/oauth2/code`,
    })
  })
})

describe('loopback redirectUri', () => {
  it('binds the exact port from a configured redirectUri that has one, instead of hanging on a mismatched port', async () => {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const probeAddress = probe.address()
    if (!probeAddress || typeof probeAddress === 'string') throw new Error('no port')
    const port = probeAddress.port
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    vi.mocked(openBrowser).mockResolvedValueOnce(true)
    const auth = createNodeAuthClient({
      ssoUrl: baseUrl, clientId: 'my-cli', appName: 'my-cli', deviceName: 'test-host',
      redirectUri: `http://127.0.0.1:${port}/custom-callback`,
    })
    let authorizeUrl = ''
    const signInPromise = auth.signIn({ mode: 'loopback', io: io([]), onAuthorizeUrl: (url) => { authorizeUrl = url } })

    await vi.waitFor(() => expect(authorizeUrl).not.toBe(''))
    const redirect = new URL(authorizeUrl).searchParams.get('redirect_uri')
    expect(redirect).toBe(`http://127.0.0.1:${port}/custom-callback`)
    const state = new URL(authorizeUrl).searchParams.get('state')

    await fetch(`${redirect}?code=the-code&state=${state}`)
    const session = await signInPromise
    expect(session.accessToken).toBe('at')
  })

  it('uses the configured path together with the actual ephemeral port when redirectUri has no port', async () => {
    vi.mocked(openBrowser).mockResolvedValueOnce(true)
    const auth = createNodeAuthClient({
      ssoUrl: baseUrl, clientId: 'my-cli', appName: 'my-cli', deviceName: 'test-host',
      redirectUri: 'http://127.0.0.1/custom-callback',
    })
    let authorizeUrl = ''
    const signInPromise = auth.signIn({ mode: 'loopback', io: io([]), onAuthorizeUrl: (url) => { authorizeUrl = url } })

    await vi.waitFor(() => expect(authorizeUrl).not.toBe(''))
    const redirect = new URL(authorizeUrl).searchParams.get('redirect_uri')
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/custom-callback$/)
    const state = new URL(authorizeUrl).searchParams.get('state')

    await fetch(`${redirect}?code=the-code&state=${state}`)
    const session = await signInPromise
    expect(session.accessToken).toBe('at')
  })

  it('throws a clear config error instead of hanging when redirectUri cannot be honoured', async () => {
    const auth = createNodeAuthClient({
      ssoUrl: baseUrl, clientId: 'my-cli', appName: 'my-cli',
      redirectUri: 'https://example.com/callback',
    })

    await expect(auth.signIn({ mode: 'loopback', io: io([]), timeoutMs: 60_000 })).rejects.toMatchObject({ code: 'SERVER' })
    expect(requests).toHaveLength(0)
  })
})
