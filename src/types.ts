/**
 * Configuration for AuthClient
 */
export interface AuthConfig {
  /** SSO server URL (e.g., https://sso.example.com) */
  ssoUrl: string;
  /** OAuth2 client ID */
  clientId: string;
  /** OAuth2 redirect URI after login */
  redirectUri: string;
  /** OAuth2 scopes (space-separated) */
  scope?: string;
  /** Custom storage implementation (defaults to localStorage) */
  storage?: TokenStorage;
}

/**
 * Token storage interface for custom implementations
 */
export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Options for authorize flow
 */
export interface AuthorizeOptions {
  /** Force account selection screen */
  prompt?: 'select_account' | 'none' | 'login';
  /** Pre-fill login hint (email) */
  loginHint?: string;
  /** URL to redirect to after successful login callback */
  nextUrl?: string;
}

/**
 * OAuth2 token response from server
 */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_at: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  /** Extra fields from auth-service */
  first_time?: boolean;
  cart_id?: string;
  epp_user?: boolean;
  company_domain?: string;
  company_name?: string;
  company_domain_type?: string;
}

/**
 * OAuth2 error response
 */
export interface OAuth2Error {
  error: string;
  error_description?: string;
}

/**
 * API Response wrapper used by auth-service
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Decoded JWT payload
 */
export interface JwtPayload {
  /** Subject (user ID) */
  sub?: string;
  /** User ID */
  user_id: string;
  /** User email */
  user_email: string;
  /** Issued at timestamp */
  iat: number;
  /** Expiration timestamp */
  exp: number;
  /** Extended info */
  ext_info?: JwtExtInfo;
}

/**
 * JWT extended information
 */
export interface JwtExtInfo {
  code?: string;
  referral_code?: string;
  full_name?: string;
  roles?: string[];
  vendor_id?: string;
  vendor_code?: string;
  vendor_name?: string;
  oauth2?: boolean;
  scope?: string;
  company_domain?: string;
  company_domain_type?: string;
  is_epp_user?: boolean;
}

/**
 * Parsed user info from JWT
 */
export interface User {
  id: string;
  email: string;
  fullName?: string;
  code?: string;
  roles?: string[];
  scope?: string;
  companyDomain?: string;
  companyDomainType?: string;
  isEppUser?: boolean;
  vendorId?: string;
  vendorCode?: string;
  vendorName?: string;
  referralCode?: string;
}

/**
 * Auth state for React context
 */
export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: User | null;
  error: Error | null;
}

/**
 * Auth context value
 */
export interface AuthContextValue extends AuthState {
  /** Start OAuth2 login flow */
  login: (options?: AuthorizeOptions) => Promise<void>;
  /** Logout and clear tokens */
  logout: (redirectUri?: string) => void;
  /** Get current access token */
  getAccessToken: () => string | null;
  /** Refresh access token */
  refreshToken: () => Promise<TokenResponse>;
  /** Re-read auth state from storage (call after callback completes) */
  refreshAuthState: () => void;
}

/**
 * Callback result from OAuth2 callback handling
 */
export interface CallbackResult {
  success: boolean;
  tokens?: TokenResponse;
  error?: string;
  /** URL to redirect to after successful callback */
  nextUrl?: string;
}
