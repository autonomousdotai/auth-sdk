import { SDK_VERSION } from '../version'
import { AuthSessionError, AuthSignInError } from './errors'
import type { NodeAuthConfig, NodeSession } from './types'

const DEFAULT_SCOPE = 'openid profile email'
const TOKEN_TIMEOUT_MS = 30_000
const REVOKE_TIMEOUT_MS = 2_000

/**
 * Timeouts for outgoing requests. A plain module constant can't be shortened
 * from a test file (imported bindings are read-only), so this is exposed as a
 * mutable object instead — production code should never need to touch it.
 */
export const oauthTimeouts = { tokenMs: TOKEN_TIMEOUT_MS }

const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === 'AbortError'

const trimUrl = (url: string) => url.replace(/\/$/, '')

export function buildAuthorizeUrl(
  config: NodeAuthConfig,
  args: { redirectUri: string; state: string; codeChallenge: string; prompt?: string; loginHint?: string; entryPoint?: string },
): string {
  const url = new URL('/oauth2/authorize', trimUrl(config.ssoUrl))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('scope', config.scope || DEFAULT_SCOPE)
  url.searchParams.set('state', args.state)
  url.searchParams.set('code_challenge', args.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (args.prompt) url.searchParams.set('prompt', args.prompt)
  if (args.loginHint) url.searchParams.set('login_hint', args.loginHint)
  if (args.entryPoint) url.searchParams.set('entry_point', args.entryPoint)
  return url.toString()
}

/** auth-service answers expires_in; expires_at (unix seconds) is the fallback. */
export function sessionFromTokenResponse(body: Record<string, unknown>, deviceName: string, now = Date.now()): NodeSession {
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : undefined
  const expiresAt = typeof body.expires_at === 'number' ? body.expires_at : undefined
  return {
    accessToken: String(body.access_token),
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt: expiresIn !== undefined ? now + expiresIn * 1000 : expiresAt !== undefined ? expiresAt * 1000 : now,
    scope: typeof body.scope === 'string' ? body.scope : undefined,
    deviceName,
    obtainedAt: now,
  }
}

async function postForm(config: NodeAuthConfig, path: string, form: Record<string, string>, signal?: AbortSignal) {
  const response = await fetch(new URL(path, trimUrl(config.ssoUrl)).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...form, client_id: config.clientId, autonomous_sdk_version: SDK_VERSION }),
    signal,
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { response, body }
}

export async function exchangeCode(
  config: NodeAuthConfig,
  args: { code: string; codeVerifier: string; redirectUri: string; deviceName: string },
): Promise<NodeSession> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), oauthTimeouts.tokenMs)
  let result: Awaited<ReturnType<typeof postForm>>
  try {
    result = await postForm(config, '/oauth2/token', {
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: args.redirectUri,
      code_verifier: args.codeVerifier,
      device_name: args.deviceName,
    }, controller.signal)
  } catch (err) {
    if (isAbortError(err)) {
      throw new AuthSignInError('SERVER', `The sign-in request to ${config.ssoUrl} timed out. Please try again.`)
    }
    throw new AuthSignInError('SERVER', `Could not reach ${config.ssoUrl}: ${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
  const data = (result.body.data as Record<string, unknown>) ?? result.body
  if (!result.response.ok || typeof data.access_token !== 'string') {
    throw new AuthSignInError('SERVER', `The sign-in could not be completed (${result.response.status}). Please sign in again.`)
  }
  return sessionFromTokenResponse(data, args.deviceName)
}

export async function refreshSession(config: NodeAuthConfig, session: NodeSession): Promise<NodeSession> {
  if (!session.refreshToken) {
    throw new AuthSessionError('SIGNED_OUT', 'This session has no refresh token. Please sign in again.')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), oauthTimeouts.tokenMs)
  let result: Awaited<ReturnType<typeof postForm>>
  try {
    result = await postForm(config, '/oauth2/token', { grant_type: 'refresh_token', refresh_token: session.refreshToken }, controller.signal)
  } catch (err) {
    if (isAbortError(err)) {
      throw new AuthSessionError('UNAVAILABLE', `The sign-in service at ${config.ssoUrl} timed out. Please try again.`)
    }
    throw new AuthSessionError('UNAVAILABLE', `Could not reach ${config.ssoUrl}: ${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
  // 401 is what auth-service answers for a revoked grant, 400 for a refused one.
  if (result.response.status === 400 || result.response.status === 401) {
    throw new AuthSessionError('SIGNED_OUT', 'This sign-in is no longer valid. Please sign in again.')
  }
  const data = (result.body.data as Record<string, unknown>) ?? result.body
  if (!result.response.ok || typeof data.access_token !== 'string') {
    throw new AuthSessionError('UNAVAILABLE', `The sign-in service is unavailable (${result.response.status}). Please try again.`)
  }
  const refreshed = sessionFromTokenResponse(data, session.deviceName)
  return { ...refreshed, refreshToken: refreshed.refreshToken ?? session.refreshToken }
}

/** Best effort: the sign-in leaves the user's "Devices & apps" list. */
export async function revokeRefreshToken(config: NodeAuthConfig, refreshToken: string): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS)
  try {
    await postForm(config, '/oauth2/revoke', { token: refreshToken, token_type_hint: 'refresh_token' }, controller.signal)
  } catch {
    // Signing out locally matters more than the server-side revoke.
  } finally {
    clearTimeout(timer)
  }
}
