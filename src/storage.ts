import type { JwtPayload, TokenResponse, TokenStorage, User } from './types';

const ACCESS_TOKEN_KEY = 'auth_sdk_access_token';
const REFRESH_TOKEN_KEY = 'auth_sdk_refresh_token';
const TOKEN_EXPIRY_KEY = 'auth_sdk_token_expiry';

/**
 * Default localStorage-based token storage
 */
export const defaultStorage: TokenStorage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
  removeItem: (key: string) => localStorage.removeItem(key),
};

/**
 * Token manager for storing and retrieving tokens
 */
export class TokenManager {
  private storage: TokenStorage;

  constructor(storage: TokenStorage = defaultStorage) {
    this.storage = storage;
  }

  /**
   * Save tokens from OAuth2 response
   */
  setTokens(response: TokenResponse): void {
    this.storage.setItem(ACCESS_TOKEN_KEY, response.access_token);

    if (response.refresh_token) {
      this.storage.setItem(REFRESH_TOKEN_KEY, response.refresh_token);
    }

    if (response.expires_at) {
      this.storage.setItem(TOKEN_EXPIRY_KEY, response.expires_at.toString());
    }
  }

  /**
   * Get access token
   */
  getAccessToken(): string | null {
    return this.storage.getItem(ACCESS_TOKEN_KEY);
  }

  /**
   * Get refresh token
   */
  getRefreshToken(): string | null {
    return this.storage.getItem(REFRESH_TOKEN_KEY);
  }

  /**
   * Get token expiry timestamp (in milliseconds)
   */
  getTokenExpiry(): number | null {
    const expiry = this.storage.getItem(TOKEN_EXPIRY_KEY);
    if (!expiry) return null;

    const expiryNum = parseInt(expiry, 10);
    // Detect if stored in seconds (< year 2100 in seconds) vs milliseconds
    // Timestamps before ~2001 in ms would be < 10^12, seconds are ~10^9
    if (expiryNum < 10000000000) {
      // It's in seconds, convert to milliseconds
      return expiryNum * 1000;
    }
    return expiryNum;
  }

  /**
   * Check if access token is expired or about to expire (within 60 seconds)
   */
  isTokenExpired(bufferSeconds: number = 60): boolean {
    // First check stored expiry
    const expiry = this.getTokenExpiry();
    if (expiry) {
      return Date.now() >= expiry - bufferSeconds * 1000;
    }

    // Fallback: check JWT exp claim
    const token = this.getAccessToken();
    if (!token) return true;

    const payload = this.decodeToken(token);
    if (!payload?.exp) return true;

    // JWT exp is in seconds, convert to milliseconds
    return Date.now() >= payload.exp * 1000 - bufferSeconds * 1000;
  }

  /**
   * Check if user is authenticated (has valid token)
   */
  isAuthenticated(): boolean {
    const token = this.getAccessToken();
    if (!token) return false;

    // Check if token is expired
    return !this.isTokenExpired(0);
  }

  /**
   * Clear all tokens
   */
  clearTokens(): void {
    this.storage.removeItem(ACCESS_TOKEN_KEY);
    this.storage.removeItem(REFRESH_TOKEN_KEY);
    this.storage.removeItem(TOKEN_EXPIRY_KEY);
  }

  /**
   * Decode JWT payload (without verification)
   */
  decodeToken(token: string): JwtPayload | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const payload = parts[1];
      const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(decoded);
    } catch {
      return null;
    }
  }

  /**
   * Get user info from current access token
   */
  getUser(): User | null {
    const token = this.getAccessToken();
    if (!token) return null;

    const payload = this.decodeToken(token);
    if (!payload) return null;

    return {
      id: payload.user_id || payload.sub || '',
      email: payload.user_email,
      fullName: payload.ext_info?.full_name,
      code: payload.ext_info?.code,
      roles: payload.ext_info?.roles,
      scope: payload.ext_info?.scope,
      companyDomain: payload.ext_info?.company_domain,
      companyDomainType: payload.ext_info?.company_domain_type,
      isEppUser: payload.ext_info?.is_epp_user,
      vendorId: payload.ext_info?.vendor_id,
      vendorCode: payload.ext_info?.vendor_code,
      vendorName: payload.ext_info?.vendor_name,
      referralCode: payload.ext_info?.referral_code,
    };
  }
}
