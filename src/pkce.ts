/**
 * PKCE (Proof Key for Code Exchange) utilities
 * Implements RFC 7636 for OAuth2 authorization code flow security
 */

const CODE_VERIFIER_KEY = 'auth_sdk_pkce_verifier';
const STATE_KEY = 'auth_sdk_oauth2_state';
const NEXT_URL_KEY = 'auth_sdk_next_url';

/**
 * Generate a cryptographically random code verifier (43-128 chars)
 */
export function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/**
 * Generate code challenge from verifier using SHA-256 (S256 method)
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Generate random state for CSRF protection
 */
export function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Base64 URL encode (RFC 4648 Section 5)
 */
function base64UrlEncode(buffer: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buffer.byteLength; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * PKCE and state storage using sessionStorage
 * (More secure than localStorage for PKCE verifier)
 */
export const pkceStorage = {
  setCodeVerifier(verifier: string): void {
    sessionStorage.setItem(CODE_VERIFIER_KEY, verifier);
  },

  getCodeVerifier(): string | null {
    return sessionStorage.getItem(CODE_VERIFIER_KEY);
  },

  clearCodeVerifier(): void {
    sessionStorage.removeItem(CODE_VERIFIER_KEY);
  },

  setState(state: string): void {
    sessionStorage.setItem(STATE_KEY, state);
  },

  getState(): string | null {
    return sessionStorage.getItem(STATE_KEY);
  },

  clearState(): void {
    sessionStorage.removeItem(STATE_KEY);
  },

  setNextUrl(url: string): void {
    sessionStorage.setItem(NEXT_URL_KEY, url);
  },

  getNextUrl(): string | null {
    return sessionStorage.getItem(NEXT_URL_KEY);
  },

  clearNextUrl(): void {
    sessionStorage.removeItem(NEXT_URL_KEY);
  },

  /** Clear all PKCE-related data */
  clear(): void {
    this.clearCodeVerifier();
    this.clearState();
    this.clearNextUrl();
  },
};
