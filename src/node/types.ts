/** A CLI's stored sign-in. Times are unix milliseconds. */
export interface NodeSession {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
  deviceName: string
  obtainedAt: number
}

/** Where a CLI keeps its session. fileTokenStorage is the default. */
export interface NodeTokenStorage {
  read(): Promise<NodeSession | null>
  write(session: NodeSession): Promise<void>
  clear(): Promise<void>
  /** Runs fn while no other process of this app writes the file. */
  withLock<T>(fn: () => Promise<T>): Promise<T>
}

export type NodeSignInMode = 'auto' | 'loopback' | 'manual'

/** Where the sign-in URL and the "paste the code" prompt go. */
export interface NodeSignInIO {
  write(text: string): void
  readLine(prompt: string): Promise<string>
}

export interface NodeSignInOptions {
  mode?: NodeSignInMode
  prompt?: 'select_account' | 'login'
  loginHint?: string
  entryPoint?: string
  timeoutMs?: number
  signal?: AbortSignal
  io?: NodeSignInIO
  onAuthorizeUrl?(url: string, mode: 'loopback' | 'manual'): void
}

export interface NodeAuthConfig {
  ssoUrl: string
  clientId: string
  /** Names the config directory, e.g. ~/.config/<appName>/auth.json */
  appName: string
  scope?: string
  redirectUri?: string
  loopbackPort?: number
  deviceName?: string
  storage?: NodeTokenStorage
}
