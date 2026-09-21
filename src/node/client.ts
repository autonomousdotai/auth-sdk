import { hostname } from 'node:os'
import { generateCodeChallenge, generateCodeVerifier, generateState } from '../pkce.js'
import { openBrowser, prefersManualMode } from './environment.js'
import { AuthSessionError, AuthSignInError } from './errors.js'
import { awaitLoopbackCallback } from './loopback.js'
import { defaultSignInIO, readPastedCode } from './manual.js'
import { buildAuthorizeUrl, exchangeCode, refreshSession, revokeRefreshToken } from './oauth.js'
import { fileTokenStorage } from './storage.js'
import type { NodeAuthConfig, NodeSession, NodeSignInOptions, NodeTokenStorage } from './types.js'

const DEFAULT_TIMEOUT_MS = 300_000
/** Refresh this long before the access token expires. */
const REFRESH_SKEW_MS = 60_000
const DEFAULT_CALLBACK_PATH = '/callback'

/**
 * Works out where the loopback server should listen and which path the
 * redirect_uri should use.
 *
 * - No configured redirectUri: any free port, "/callback".
 * - Configured with a port: listen on that exact port (a mismatch between the
 *   two would otherwise send the browser to a port nothing is listening on,
 *   and the sign-in would hang until TIMEOUT), using its path.
 * - Configured with no port: listen on loopbackPort (or any free port), and
 *   use the configured path with whatever port is actually bound.
 * - Anything that cannot be honoured (not a valid http://127.0.0.1 URL) is a
 *   config error, reported immediately instead of hanging.
 */
function resolveLoopbackTarget(configuredRedirectUri: string | undefined, loopbackPort: number | undefined): { listenPort: number; path: string } {
  if (!configuredRedirectUri) {
    return { listenPort: loopbackPort ?? 0, path: DEFAULT_CALLBACK_PATH }
  }
  let parsed: URL
  try {
    parsed = new URL(configuredRedirectUri)
  } catch {
    throw new AuthSignInError('SERVER', `redirectUri "${configuredRedirectUri}" is not a valid URL.`)
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    throw new AuthSignInError('SERVER', `redirectUri must be an http://127.0.0.1 URL for the loopback flow (got "${configuredRedirectUri}").`)
  }
  const path = parsed.pathname || DEFAULT_CALLBACK_PATH
  if (parsed.port) {
    return { listenPort: Number(parsed.port), path }
  }
  return { listenPort: loopbackPort ?? 0, path }
}

/** Signs a person in from a CLI and keeps the session usable. */
export class NodeAuthClient {
  private readonly storage: NodeTokenStorage
  private readonly deviceName: string
  private session: NodeSession | null = null
  private loaded = false
  private refreshing: Promise<NodeSession> | null = null

  constructor(private readonly config: NodeAuthConfig) {
    this.storage = config.storage ?? fileTokenStorage(config.appName)
    this.deviceName = config.deviceName || hostname()
  }

  private async load(): Promise<NodeSession | null> {
    if (!this.loaded) {
      this.session = await this.storage.read()
      this.loaded = true
    }
    return this.session
  }

  /**
   * Loads the stored session from disk. getSession() and isSignedIn() are
   * synchronous and return null/false until something has loaded it — call
   * this (or any other async method, e.g. getAccessToken()) once up front
   * before trusting them.
   */
  async loadSession(): Promise<NodeSession | null> {
    return this.load()
  }

  getSession(): NodeSession | null {
    return this.session
  }

  isSignedIn(): boolean {
    return this.session !== null
  }

  async signIn(options: NodeSignInOptions = {}): Promise<NodeSession> {
    const io = options.io ?? defaultSignInIO()
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const state = generateState()
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = await generateCodeChallenge(codeVerifier)
    const wanted = options.mode ?? 'auto'
    const manual = wanted === 'manual' || (wanted === 'auto' && prefersManualMode())

    const authorizeUrl = (redirectUri: string) =>
      buildAuthorizeUrl(this.config, {
        redirectUri, state, codeChallenge,
        prompt: options.prompt, loginHint: options.loginHint, entryPoint: options.entryPoint,
      })

    const runManual = async (): Promise<{ code: string; redirectUri: string }> => {
      const manualRedirectUri = `${this.config.ssoUrl.replace(/\/$/, '')}/oauth2/code`
      const url = authorizeUrl(manualRedirectUri)
      options.onAuthorizeUrl?.(url, 'manual')
      io.write(`\nOpen this URL in a browser to sign in:\n\n  ${url}\n\n`)
      const pastedCode = await readPastedCode(io, state)
      return { code: pastedCode, redirectUri: manualRedirectUri }
    }

    let redirectUri: string
    let code: string
    if (manual) {
      ;({ code, redirectUri } = await runManual())
    } else {
      const { listenPort, path } = resolveLoopbackTarget(this.config.redirectUri, this.config.loopbackPort)
      redirectUri = ''
      // awaitLoopbackCallback wraps whatever onReady throws into its own
      // AuthSignInError('SERVER', ...) before rejecting, so neither the
      // NO_BROWSER error thrown below nor the "fall back to manual" signal
      // would otherwise reach here undisguised. Track both outside the
      // promise and act on them once it settles.
      let noBrowserError: AuthSignInError | null = null
      let fallBackToManual = false
      try {
        code = await awaitLoopbackCallback({
          port: listenPort,
          path,
          state,
          timeoutMs,
          signal: options.signal,
          onReady: async (loopbackUri) => {
            redirectUri = loopbackUri
            const url = authorizeUrl(redirectUri)
            options.onAuthorizeUrl?.(url, 'loopback')
            io.write(`\nSign in to continue:\n\n  ${url}\n\n`)
            if (!(await openBrowser(url))) {
              if (wanted === 'loopback') {
                noBrowserError = new AuthSignInError('NO_BROWSER', 'No browser could be opened. Open the URL above, or sign in with the pasted-code flow.')
                throw noBrowserError
              }
              // 'auto': stop waiting on the loopback listener — which would
              // otherwise sit until TIMEOUT since nothing can ever browse to
              // it — and fall back to the manual, pasted-code flow instead.
              fallBackToManual = true
              throw new AuthSignInError('NO_BROWSER', 'No browser could be opened; falling back to the pasted-code flow.')
            }
          },
        })
      } catch (err) {
        if (!fallBackToManual) throw noBrowserError ?? err
        ;({ code, redirectUri } = await runManual())
      }
    }

    const session = await exchangeCode(this.config, { code, codeVerifier, redirectUri, deviceName: this.deviceName })
    await this.storage.withLock(() => this.storage.write(session))
    this.session = session
    this.loaded = true
    return session
  }

  async getAccessToken(): Promise<string> {
    try {
      return await this.getAccessTokenOrThrow()
    } catch (err) {
      // getAccessToken must only ever reject with AuthSessionError or
      // AuthSignInError, so callers can safely branch on `.code` — wrap
      // anything else (a lock-acquire timeout, a raw EACCES/EISDIR from the
      // filesystem, ...) instead of letting it escape unchanged.
      if (err instanceof AuthSessionError || err instanceof AuthSignInError) throw err
      throw new AuthSessionError('UNAVAILABLE', `Could not read or refresh the stored session: ${(err as Error).message}`, { cause: err })
    }
  }

  private async getAccessTokenOrThrow(): Promise<string> {
    const session = await this.load()
    if (!session) {
      throw new AuthSessionError('NO_SESSION', 'You are not signed in.')
    }
    if (session.expiresAt - REFRESH_SKEW_MS > Date.now()) {
      return session.accessToken
    }
    // One refresh per process, and one per machine: another process may have
    // rotated the token while this one waited for the lock.
    this.refreshing ??= this.storage
      .withLock(async () => {
        const current = await this.storage.read()
        if (!current) {
          // The file is gone: another process (e.g. a concurrent `logout`)
          // already cleared it. There is nothing to refresh — falling back to
          // the in-memory `session` here would resurrect a sign-out that
          // already happened.
          throw new AuthSessionError('SIGNED_OUT', 'This sign-in is no longer valid. Please sign in again.')
        }
        if (current.expiresAt - REFRESH_SKEW_MS > Date.now()) return current
        try {
          const refreshed = await refreshSession(this.config, current)
          await this.storage.write(refreshed)
          return refreshed
        } catch (err) {
          if (err instanceof AuthSessionError && err.code === 'SIGNED_OUT') {
            // Clear while still holding the lock, so there is no window
            // between releasing it and clearing in which a concurrent write
            // (another sign-in, or another process's successful refresh)
            // could land and then be clobbered by this cleanup. If the file
            // no longer holds the exact session we just tried to refresh,
            // someone else already replaced it with something valid — leave
            // it alone.
            const onDisk = await this.storage.read()
            if (onDisk && JSON.stringify(onDisk) === JSON.stringify(current)) {
              await this.storage.clear()
            }
          }
          throw err
        }
      })
      .then(
        (refreshed) => {
          this.session = refreshed
          this.refreshing = null
          return refreshed
        },
        (err) => {
          this.refreshing = null
          if (err instanceof AuthSessionError && err.code === 'SIGNED_OUT') {
            this.session = null
          }
          throw err
        },
      )
    return (await this.refreshing).accessToken
  }

  async logout(): Promise<void> {
    const session = await this.load()
    if (!session) return
    if (session.refreshToken) {
      await revokeRefreshToken(this.config, session.refreshToken)
    }
    await this.storage.withLock(() => this.storage.clear())
    this.session = null
  }
}

export function createNodeAuthClient(config: NodeAuthConfig): NodeAuthClient {
  return new NodeAuthClient(config)
}
