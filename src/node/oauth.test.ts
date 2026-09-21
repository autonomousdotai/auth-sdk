import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthSessionError, AuthSignInError } from './errors'
import { buildAuthorizeUrl, exchangeCode, oauthTimeouts, refreshSession, revokeRefreshToken, sessionFromTokenResponse } from './oauth'
import type { NodeAuthConfig } from './types'

let server: Server
let baseUrl: string
let requests: { url: string; body: URLSearchParams }[] = []
let reply: { status: number; body: unknown } = { status: 200, body: {} }
// When true, the handler records the request but never responds, so the
// client has to fall back to its own timeout — exercising that path without
// waiting out the real (30s) production default.
let hang = false

beforeEach(async () => {
  requests = []
  hang = false
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      requests.push({ url: req.url ?? '', body: new URLSearchParams(raw) })
      if (hang) return
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  oauthTimeouts.tokenMs = 30_000
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const config = (): NodeAuthConfig => ({ ssoUrl: baseUrl, clientId: 'my-cli', appName: 'my-cli' })

describe('buildAuthorizeUrl', () => {
  it('asks for a code with PKCE and passes the options through', () => {
    const url = new URL(buildAuthorizeUrl(
      { ssoUrl: 'https://auth.test', clientId: 'my-cli', appName: 'my-cli' },
      { redirectUri: 'http://127.0.0.1:5555/callback', state: 'st', codeChallenge: 'ch', prompt: 'select_account', loginHint: 'a@b.c', entryPoint: 'cli' },
    ))

    expect(url.origin + url.pathname).toBe('https://auth.test/oauth2/authorize')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'my-cli',
      redirect_uri: 'http://127.0.0.1:5555/callback',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      scope: 'openid profile email',
      prompt: 'select_account',
      login_hint: 'a@b.c',
      entry_point: 'cli',
    })
  })
})

describe('sessionFromTokenResponse', () => {
  it('prefers expires_in and falls back to expires_at in seconds', () => {
    const now = 1_700_000_000_000
    expect(sessionFromTokenResponse({ access_token: 'at', expires_in: 3600 }, 'host', now).expiresAt)
      .toBe(now + 3_600_000)
    expect(sessionFromTokenResponse({ access_token: 'at', expires_at: 1_700_000_900 }, 'host', now).expiresAt)
      .toBe(1_700_000_900_000)
  })
})

describe('exchangeCode', () => {
  it('posts the code with the verifier and the device name', async () => {
    reply = { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 60, scope: 'openid' } }

    const session = await exchangeCode(config(), {
      code: 'the-code', codeVerifier: 'the-verifier', redirectUri: `${baseUrl}/oauth2/code`, deviceName: 'my-laptop',
    })

    expect(requests[0].url).toBe('/oauth2/token')
    expect(Object.fromEntries(requests[0].body)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: 'the-verifier',
      client_id: 'my-cli',
      redirect_uri: `${baseUrl}/oauth2/code`,
      device_name: 'my-laptop',
    })
    expect(requests[0].body.get('autonomous_sdk_version')).toBeTruthy()
    expect(session).toMatchObject({ accessToken: 'at', refreshToken: 'rt', deviceName: 'my-laptop', scope: 'openid' })
  })

  it('reports a refused exchange as a sign-in error', async () => {
    reply = { status: 400, body: { error: { message: 'invalid_grant' } } }
    await expect(exchangeCode(config(), { code: 'c', codeVerifier: 'v', redirectUri: 'r', deviceName: 'd' }))
      .rejects.toThrow(/sign in/i)
  })

  it('times out instead of hanging on an unresponsive server', async () => {
    hang = true
    oauthTimeouts.tokenMs = 50
    await expect(exchangeCode(config(), { code: 'c', codeVerifier: 'v', redirectUri: 'r', deviceName: 'd' }))
      .rejects.toBeInstanceOf(AuthSignInError)
  })
})

describe('refreshSession', () => {
  const stored = { accessToken: 'old', refreshToken: 'rt', expiresAt: 0, deviceName: 'host', obtainedAt: 0 }

  it('returns the rotated session', async () => {
    reply = { status: 200, body: { access_token: 'new', refresh_token: 'rt2', expires_in: 3600 } }

    const session = await refreshSession(config(), stored)

    expect(Object.fromEntries(requests[0].body)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt', client_id: 'my-cli' })
    expect(session).toMatchObject({ accessToken: 'new', refreshToken: 'rt2', deviceName: 'host' })
  })

  it.each([400, 401])('treats %i as signed out', async (status) => {
    reply = { status, body: { error: { message: 'invalid_grant' } } }
    await expect(refreshSession(config(), stored)).rejects.toMatchObject({ code: 'SIGNED_OUT' })
  })

  it.each([500, 502])('treats %i as a temporary outage', async (status) => {
    reply = { status, body: {} }
    await expect(refreshSession(config(), stored)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('treats an unreachable server as a temporary outage', async () => {
    const dead = { ssoUrl: 'http://127.0.0.1:1', clientId: 'my-cli', appName: 'my-cli' }
    await expect(refreshSession(dead, stored)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('refuses a session with no refresh token', async () => {
    await expect(refreshSession(config(), { ...stored, refreshToken: undefined }))
      .rejects.toBeInstanceOf(AuthSessionError)
  })

  it('times out instead of hanging on an unresponsive server', async () => {
    hang = true
    oauthTimeouts.tokenMs = 50
    await expect(refreshSession(config(), stored)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})

describe('revokeRefreshToken', () => {
  it('posts to the revocation endpoint and ignores failures', async () => {
    reply = { status: 500, body: {} }
    await expect(revokeRefreshToken(config(), 'rt')).resolves.toBeUndefined()
    expect(requests[0].url).toBe('/oauth2/revoke')
    expect(Object.fromEntries(requests[0].body)).toMatchObject({ token: 'rt', token_type_hint: 'refresh_token', client_id: 'my-cli' })
  })
})
