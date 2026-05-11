import { useAuthContext } from './AuthProvider';
import type { User } from '../types';

/**
 * Hook to get current user information
 *
 * @example
 * ```tsx
 * function UserProfile() {
 *   const user = useUser();
 *
 *   if (!user) return <div>Not logged in</div>;
 *
 *   return (
 *     <div>
 *       <p>Email: {user.email}</p>
 *       <p>Name: {user.fullName}</p>
 *     </div>
 *   );
 * }
 * ```
 */
export function useUser(): User | null {
  const { user } = useAuthContext();
  return user;
}
