import { hostname } from 'node:os'
import { generateCodeChallenge, generateCodeVerifier, generateState } from '../pkce'
import { openBrowser, prefersManualMode } from './environment'
import { AuthSessionError, AuthSignInError } from './errors'
import { awaitLoopbackCallback } from './loopback'
import { defaultSignInIO, readPastedCode } from './manual'
import { buildAuthorizeUrl, exchangeCode, refreshSession, revokeRefreshToken } from './oauth'
import { fileTokenStorage } from './storage'
import type { NodeAuthConfig, NodeSession, NodeSignInOptions, NodeTokenStorage } from './types'

const DEFAULT_TIMEOUT_MS = 300_000
/** Refresh this long before the access token expires. */
const REFRESH_SKEW_MS = 60_000

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

    let redirectUri: string
    let code: string
    if (manual) {
      redirectUri = `${this.config.ssoUrl.replace(/\/$/, '')}/oauth2/code`
      const url = authorizeUrl(redirectUri)
      options.onAuthorizeUrl?.(url, 'manual')
      io.write(`\nOpen this URL in a browser to sign in:\n\n  ${url}\n\n`)
      code = await readPastedCode(io, state)
    } else {
      redirectUri = this.config.redirectUri ?? ''
      code = await awaitLoopbackCallback({
        port: this.config.loopbackPort ?? 0,
        state,
        timeoutMs,
        signal: options.signal,
        onReady: async (loopbackUri) => {
          redirectUri = this.config.redirectUri ?? loopbackUri
          const url = authorizeUrl(redirectUri)
          options.onAuthorizeUrl?.(url, 'loopback')
          io.write(`\nSign in to continue:\n\n  ${url}\n\n`)
          if (!(await openBrowser(url)) && wanted === 'loopback') {
            throw new AuthSignInError('NO_BROWSER', 'No browser could be opened. Open the URL above, or sign in with the pasted-code flow.')
          }
        },
      })
    }

    const session = await exchangeCode(this.config, { code, codeVerifier, redirectUri, deviceName: this.deviceName })
    await this.storage.withLock(() => this.storage.write(session))
    this.session = session
    this.loaded = true
    return session
  }

  async getAccessToken(): Promise<string> {
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
        const current = (await this.storage.read()) ?? session
        if (current.expiresAt - REFRESH_SKEW_MS > Date.now()) return current
        const refreshed = await refreshSession(this.config, current)
        await this.storage.write(refreshed)
        return refreshed
      })
      .then(
        (refreshed) => {
          this.session = refreshed
          this.refreshing = null
          return refreshed
        },
        async (err) => {
          this.refreshing = null
          if (err instanceof AuthSessionError && err.code === 'SIGNED_OUT') {
            await this.storage.clear()
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
