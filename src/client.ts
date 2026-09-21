import { generateCodeChallenge, generateCodeVerifier, generateState, pkceStorage } from './pkce.js';
import { TokenManager, defaultStorage } from './storage.js';
import type {
  AuthConfig,
  AuthorizeOptions,
  CallbackResult,
  TokenResponse,
  User,
} from './types.js';
import { SDK_VERSION } from './version.js';

/** A slow or failing revoke never holds up logout for longer than this. */
const REVOKE_TIMEOUT_MS = 2000;

/**
 * Auth Client for OAuth2 SSO flow with PKCE
 */
export class AuthClient {
  private config: Required<AuthConfig>;
  private tokenManager: TokenManager;

  constructor(config: AuthConfig) {
    this.config = {
      scope: 'openid profile email',
      storage: defaultStorage,
      ...config,
    };
    this.tokenManager = new TokenManager(this.config.storage);
  }

  /**
   * Start OAuth2 authorization flow with PKCE
   * Redirects the browser to SSO login page
   */
  async authorize(options?: AuthorizeOptions): Promise<void> {
    // Generate and store PKCE code verifier
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    pkceStorage.setCodeVerifier(codeVerifier);

    // Generate and store state for CSRF protection
    const state = generateState();
    pkceStorage.setState(state);

    // Build authorization URL
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scope,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      autonomous_sdk_version: SDK_VERSION,
    });

    // Store next URL for post-login redirect
    if (options?.nextUrl) {
      pkceStorage.setNextUrl(options.nextUrl);
    }

    // Add optional parameters
    if (options?.prompt) {
      params.set('prompt', options.prompt);
    }
    if (options?.loginHint) {
      params.set('login_hint', options.loginHint);
    }
    if (options?.entryPoint) {
      params.set('entry_point', options.entryPoint);
    }

    // Redirect to SSO authorization endpoint
    window.location.href = `${this.config.ssoUrl}/oauth2/authorize?${params.toString()}`;
  }

  /**
   * Handle OAuth2 callback - exchange code for tokens
   * Call this from your callback page
   */
  async handleCallback(code: string, state: string): Promise<CallbackResult> {
    try {
      // Verify state to prevent CSRF
      const storedState = pkceStorage.getState();
      if (!storedState || storedState !== state) {
        return {
          success: false,
          error: 'Invalid state parameter - possible CSRF attack',
        };
      }

      // Get PKCE code verifier
      const codeVerifier = pkceStorage.getCodeVerifier();
      if (!codeVerifier) {
        return {
          success: false,
          error: 'Missing code verifier - PKCE flow incomplete',
        };
      }

      // Exchange code for tokens
      const response = await fetch(`${this.config.ssoUrl}/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: this.config.redirectUri,
          client_id: this.config.clientId,
          code_verifier: codeVerifier,
          autonomous_sdk_version: SDK_VERSION,
        }),
      });

      // Get next URL before clearing PKCE storage
      const nextUrl = pkceStorage.getNextUrl() || undefined;

      // Clear PKCE storage after use
      pkceStorage.clear();

      const result: TokenResponse = await response.json();

      // Check for OAuth2 error response
      if (!result.access_token) {
        return {
          success: false,
          error: 'Token exchange failed',
        };
      }

      // Store tokens
      this.tokenManager.setTokens(result);

      return {
        success: true,
        tokens: result,
        nextUrl,
      };
    } catch (err) {
      pkceStorage.clear();
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error during callback',
      };
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshToken(): Promise<TokenResponse> {
    const refreshToken = this.tokenManager.getRefreshToken();
    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    const response = await fetch(`${this.config.ssoUrl}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.config.clientId,
        autonomous_sdk_version: SDK_VERSION,
      }),
    });

    const result: TokenResponse = await response.json();

    // Check for OAuth2 error response
    if (!result.access_token) {
      // Clear tokens on refresh failure
      this.tokenManager.clearTokens();
      throw new Error('Token refresh failed');
    }

    this.tokenManager.setTokens(result);

    return result;
  }

  /**
   * Logout - revokes this app's sign-in, clears tokens and redirects to SSO logout
   */
  async logout(redirectUri?: string): Promise<void> {
    const postLogoutRedirectUri = redirectUri || window.location.origin;
    const idToken = this.tokenManager.getAccessToken();
    const refreshToken = this.tokenManager.getRefreshToken();

    // Clear local tokens
    this.tokenManager.clearTokens();
    pkceStorage.clear();

    // Remove this sign-in from the user's "Devices & apps" list (best effort).
    if (refreshToken) {
      await this.revokeToken(refreshToken);
    }

    // Build logout URL
    const params = new URLSearchParams({
      post_logout_redirect_uri: postLogoutRedirectUri,
    });

    if (idToken) {
      params.set('id_token_hint', idToken);
    }

    // Redirect to SSO logout endpoint
    window.location.href = `${this.config.ssoUrl}/oauth2/logout?${params.toString()}`;
  }

  /**
   * Revoke a token at the SSO server (RFC 7009). Errors and timeouts are ignored.
   */
  private async revokeToken(token: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS);
    try {
      await fetch(`${this.config.ssoUrl}/oauth2/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          token,
          token_type_hint: 'refresh_token',
          client_id: this.config.clientId,
        }),
        signal: controller.signal,
        keepalive: true,
      });
    } catch {
      // Best effort: the user is logged out locally either way.
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return this.tokenManager.isAuthenticated();
  }

  /**
   * Get current access token
   */
  getAccessToken(): string | null {
    return this.tokenManager.getAccessToken();
  }

  /**
   * Get current refresh token
   */
  getRefreshToken(): string | null {
    return this.tokenManager.getRefreshToken();
  }

  /**
   * Get user info from current token
   */
  getUser(): User | null {
    return this.tokenManager.getUser();
  }

  /**
   * Check if token is expired or about to expire
   */
  isTokenExpired(bufferSeconds: number = 60): boolean {
    return this.tokenManager.isTokenExpired(bufferSeconds);
  }

  /**
   * Get a valid access token, refreshing if needed
   */
  async getValidAccessToken(): Promise<string> {
    if (this.isTokenExpired()) {
      await this.refreshToken();
    }

    const token = this.getAccessToken();
    if (!token) {
      throw new Error('No access token available');
    }

    return token;
  }

  /**
   * Clear all stored tokens (local logout without SSO redirect)
   */
  clearTokens(): void {
    this.tokenManager.clearTokens();
    pkceStorage.clear();
  }
}

/**
 * Create a new AuthClient instance
 */
export function createAuthClient(config: AuthConfig): AuthClient {
  return new AuthClient(config);
}
