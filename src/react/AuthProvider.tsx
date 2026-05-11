import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { AuthClient } from '../client';
import type { AuthConfig, AuthContextValue, AuthorizeOptions, User, TokenResponse } from '../types';

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  config: AuthConfig;
  /** Auto-refresh tokens before expiry (default: true) */
  autoRefresh?: boolean;
  /** Seconds before expiry to trigger refresh (default: 60) */
  refreshBuffer?: number;
  /** Callback when authentication state changes */
  onAuthChange?: (isAuthenticated: boolean, user: User | null) => void;
}

export function AuthProvider({
  children,
  config,
  autoRefresh = true,
  refreshBuffer = 60,
  onAuthChange,
}: AuthProviderProps) {
  const [client] = useState(() => new AuthClient(config));
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Initialize auth state
  useEffect(() => {
    const initAuth = () => {
      const authenticated = client.isAuthenticated();
      const currentUser = client.getUser();

      setIsAuthenticated(authenticated);
      setUser(currentUser);
      setIsLoading(false);

      onAuthChange?.(authenticated, currentUser);
    };

    initAuth();
  }, [client, onAuthChange]);

  // Auto-refresh token before expiry
  useEffect(() => {
    if (!autoRefresh || !isAuthenticated) return;

    const checkAndRefresh = async () => {
      if (client.isTokenExpired(refreshBuffer)) {
        try {
          await client.refreshToken();
          const newUser = client.getUser();
          setUser(newUser);
          setIsAuthenticated(true);
        } catch (err) {
          setError(err instanceof Error ? err : new Error('Token refresh failed'));
          setIsAuthenticated(false);
          setUser(null);
          onAuthChange?.(false, null);
        }
      }
    };

    // Check immediately
    checkAndRefresh();

    // Check periodically (every 30 seconds)
    const interval = setInterval(checkAndRefresh, 30000);

    return () => clearInterval(interval);
  }, [client, isAuthenticated, autoRefresh, refreshBuffer, onAuthChange]);

  const login = useCallback(
    async (options?: AuthorizeOptions) => {
      setIsLoading(true);
      setError(null);
      try {
        await client.authorize(options);
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Login failed'));
        setIsLoading(false);
      }
    },
    [client]
  );

  const logout = useCallback(
    (redirectUri?: string) => {
      client.logout(redirectUri);
    },
    [client]
  );

  const getAccessToken = useCallback(() => {
    return client.getAccessToken();
  }, [client]);

  const refreshToken = useCallback(async (): Promise<TokenResponse> => {
    const tokens = await client.refreshToken();
    const newUser = client.getUser();
    setUser(newUser);
    setIsAuthenticated(true);
    onAuthChange?.(true, newUser);
    return tokens;
  }, [client, onAuthChange]);

  const refreshAuthState = useCallback(() => {
    const authenticated = client.isAuthenticated();
    const currentUser = client.getUser();
    setIsAuthenticated(authenticated);
    setUser(currentUser);
    setIsLoading(false);
    onAuthChange?.(authenticated, currentUser);
  }, [client, onAuthChange]);

  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated,
      isLoading,
      user,
      error,
      login,
      logout,
      getAccessToken,
      refreshToken,
      refreshAuthState,
    }),
    [isAuthenticated, isLoading, user, error, login, logout, getAccessToken, refreshToken, refreshAuthState]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Hook to access auth context
 * Must be used within AuthProvider
 */
export function useAuthContext(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuthContext must be used within an AuthProvider');
  }
  return context;
}

/**
 * Get the AuthClient instance from context
 * For advanced use cases
 */
export { AuthContext };
