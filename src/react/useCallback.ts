import { useEffect, useRef, useState } from 'react';
import { AuthClient } from '../client';
import type { AuthConfig, CallbackResult } from '../types';

/**
 * Hook to handle OAuth2 callback
 * Use this on your callback page to exchange code for tokens
 *
 * @example
 * ```tsx
 * function CallbackPage() {
 *   const { isLoading, error, success } = useAuthCallback(authConfig);
 *
 *   useEffect(() => {
 *     if (success) {
 *       navigate('/dashboard');
 *     }
 *   }, [success]);
 *
 *   if (isLoading) return <div>Processing login...</div>;
 *   if (error) return <div>Error: {error}</div>;
 *
 *   return null;
 * }
 * ```
 */
export function useAuthCallback(config: AuthConfig): {
  isLoading: boolean;
  error: string | null;
  success: boolean;
  result: CallbackResult | null;
  nextUrl: string | undefined;
} {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [result, setResult] = useState<CallbackResult | null>(null);
  const [nextUrl, setNextUrl] = useState<string | undefined>(undefined);
  const processedRef = useRef(false);

  useEffect(() => {
    // Guard against double-invocation (React StrictMode)
    if (processedRef.current) return;
    processedRef.current = true;

    const handleCallback = async () => {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const state = params.get('state');
      const errorParam = params.get('error');
      const errorDescription = params.get('error_description');

      // Handle OAuth2 error response
      if (errorParam) {
        setError(errorDescription || errorParam);
        setIsLoading(false);
        return;
      }

      // Validate required parameters
      if (!code || !state) {
        setError('Missing code or state parameter');
        setIsLoading(false);
        return;
      }

      try {
        const client = new AuthClient(config);
        const callbackResult = await client.handleCallback(code, state);

        setResult(callbackResult);

        if (callbackResult.success) {
          setSuccess(true);
          setNextUrl(callbackResult.nextUrl);
        } else {
          setError(callbackResult.error || 'Callback failed');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setIsLoading(false);
      }
    };

    handleCallback();
  }, [config]);

  return { isLoading, error, success, result, nextUrl };
}
