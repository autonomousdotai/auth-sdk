import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthClient } from './client'
import type { AuthorizeOptions } from './types'

// The browser client redirects by assigning window.location.href and keeps its
// PKCE state in sessionStorage; both are stood in for here.
const memoryStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

let location: { href: string }

beforeEach(() => {
  location = { href: '' }
  vi.stubGlobal('window', { location })
  vi.stubGlobal('sessionStorage', memoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function authorizeUrl(options?: AuthorizeOptions): Promise<URL> {
  const client = new AuthClient({
    ssoUrl: 'https://auth.test',
    clientId: 'web-app',
    redirectUri: 'https://app.test/callback',
    storage: memoryStorage(),
  })
  await client.authorize(options)
  return new URL(location.href)
}

describe('AuthClient.authorize', () => {
  it('redirects to the SSO with a PKCE authorization request', async () => {
    const url = await authorizeUrl()

    expect(url.origin + url.pathname).toBe('https://auth.test/oauth2/authorize')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'web-app',
      redirect_uri: 'https://app.test/callback',
      scope: 'openid profile email',
      code_challenge_method: 'S256',
    })
    expect(url.searchParams.get('state')).toBe(sessionStorage.getItem('auth_sdk_oauth2_state'))
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    for (const name of ['prompt', 'login_hint', 'entry_point', 'provider']) {
      expect(url.searchParams.has(name), name).toBe(false)
    }
  })

  it('passes the options through, the provider hint included', async () => {
    const url = await authorizeUrl({ prompt: 'select_account', loginHint: 'a@b.c', entryPoint: 'header', provider: 'google' })

    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      prompt: 'select_account',
      login_hint: 'a@b.c',
      entry_point: 'header',
      provider: 'google',
    })
  })

  it.each(['google', 'apple'] as const)('asks the SSO to start with %s', async (provider) => {
    expect((await authorizeUrl({ provider })).searchParams.get('provider')).toBe(provider)
  })
})
