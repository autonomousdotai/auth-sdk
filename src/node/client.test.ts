import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNodeAuthClient } from './client'
import { fileTokenStorage } from './storage'
import type { NodeSession, NodeSignInIO } from './types'

let server: Server
let baseUrl: string
let requests: { url: string; body: URLSearchParams }[]
let tokenReply: { status: number; body: unknown }

beforeEach(async () => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'auth-sdk-'))
  requests = []
  tokenReply = { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } }
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      requests.push({ url: req.url ?? '', body: new URLSearchParams(raw) })
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
  const stored = (expiresAt: number): NodeSession => ({ accessToken: 'stored', refreshToken: 'rt', expiresAt, deviceName: 'test-host', obtainedAt: 0 })

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

  it('says there is no session at all', async () => {
    await expect(client().getAccessToken()).rejects.toMatchObject({ code: 'NO_SESSION' })
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
})
