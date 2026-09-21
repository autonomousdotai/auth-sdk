export type SignInErrorCode = 'TIMEOUT' | 'CANCELLED' | 'STATE_MISMATCH' | 'SERVER' | 'NO_BROWSER'
export type SessionErrorCode = 'SIGNED_OUT' | 'UNAVAILABLE' | 'NO_SESSION'

/** A sign-in that did not complete. message is safe to print to a user. */
export class AuthSignInError extends Error {
  constructor(readonly code: SignInErrorCode, message: string) {
    super(message)
    this.name = 'AuthSignInError'
  }
}

/** A stored session that cannot be used. SIGNED_OUT means: sign in again. */
export class AuthSessionError extends Error {
  /** The lower-level error this was wrapped from, when there is one. */
  readonly cause?: unknown

  constructor(readonly code: SessionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'AuthSessionError'
    if (options?.cause !== undefined) this.cause = options.cause
  }
}
