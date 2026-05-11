import { useAuthContext } from './AuthProvider';
import type { AuthContextValue } from '../types';

/**
 * Hook to access authentication state and actions
 *
 * @example
 * ```tsx
 * function LoginButton() {
 *   const { isAuthenticated, login, logout, isLoading } = useAuth();
 *
 *   if (isLoading) return <div>Loading...</div>;
 *
 *   if (isAuthenticated) {
 *     return <button onClick={() => logout()}>Logout</button>;
 *   }
 *
 *   return <button onClick={() => login()}>Login</button>;
 * }
 * ```
 */
export function useAuth(): AuthContextValue {
  return useAuthContext();
}
