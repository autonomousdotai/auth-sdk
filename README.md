# @autonomous-ai/auth-sdk

Client SDK for the auth-service SSO flow — OAuth2 Authorization Code + PKCE (S256), with first-class React bindings.

- **Zero runtime dependencies** — React is an optional peer dependency
- **ESM only**, ships TypeScript types
- Automatic token refresh before expiry
- Post-login redirect via `nextUrl`, no server-side changes needed

## Installation

```bash
npm install @autonomous-ai/auth-sdk
```

React is optional — only needed if you import `@autonomous-ai/auth-sdk/react`:

```bash
npm install react   # >= 18
```

### Local development

```bash
npm install && npm run build
npm link                       # in this repo
npm link @autonomous-ai/auth-sdk   # in the consuming app
```

## Entry points

| Import path                     | Contents                                             |
| ------------------------------- | ---------------------------------------------------- |
| `@autonomous-ai/auth-sdk`       | `AuthClient`, `TokenManager`, PKCE helpers, all types |
| `@autonomous-ai/auth-sdk/react` | `AuthProvider`, `useAuth`, `useUser`, `useAuthCallback` |

## Quick Start (React)

### 1. Wrap your app with AuthProvider

Define `authConfig` outside the component (or memoize it) — a new object identity on every render re-triggers the provider's effects.

```tsx
import { AuthProvider } from "@autonomous-ai/auth-sdk/react";

const authConfig = {
  ssoUrl: "https://sso.example.com",
  clientId: "my-app",
  redirectUri: "https://app.example.com/callback",
  scope: "openid profile email",
};

function App() {
  return (
    <AuthProvider config={authConfig}>
      <YourApp />
    </AuthProvider>
  );
}
```

### 2. Use the hooks

```tsx
import { useAuth, useUser } from "@autonomous-ai/auth-sdk/react";

function LoginButton() {
  const { isAuthenticated, login, logout, isLoading } = useAuth();

  if (isLoading) return <div>Loading...</div>;

  if (isAuthenticated) {
    return <button onClick={() => logout()}>Logout</button>;
  }

  return <button onClick={() => login()}>Login with SSO</button>;
}

function UserProfile() {
  const user = useUser();

  if (!user) return null;

  return <p>Welcome, {user.fullName || user.email}!</p>;
}
```

### 3. Handle the OAuth2 callback

Mount this on the route you registered as `redirectUri`. The hook reads `code` / `state` from the URL, exchanges them for tokens, and is guarded against React StrictMode double-invocation.

```tsx
import { useEffect } from "react";
import { useAuthCallback, useAuth } from "@autonomous-ai/auth-sdk/react";
import { useNavigate } from "react-router-dom";

function CallbackPage() {
  const navigate = useNavigate();
  const { refreshAuthState } = useAuth();
  const { isLoading, error, success, nextUrl } = useAuthCallback(authConfig);

  useEffect(() => {
    if (success) {
      refreshAuthState(); // re-read tokens written by the callback
      navigate(nextUrl || "/");
    }
  }, [success, nextUrl, navigate, refreshAuthState]);

  if (isLoading) return <div>Processing login...</div>;
  if (error) return <div>Login failed: {error}</div>;

  return null;
}
```

### 4. Post-login redirect (`nextUrl`)

Pass `nextUrl` to `login()` to send the user back to the page they started from. It is stored in `sessionStorage` before the SSO redirect and returned by `useAuthCallback` after a successful exchange.

```tsx
import { useEffect } from "react";
import { useAuth } from "@autonomous-ai/auth-sdk/react";
import { useLocation } from "react-router-dom";

function ProtectedPage() {
  const location = useLocation();
  const { isAuthenticated, isLoading, login } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      login({
        nextUrl: `${location.pathname}${location.search}${location.hash}`,
      });
    }
  }, [isAuthenticated, isLoading, login, location]);

  if (isLoading || !isAuthenticated) {
    return <div>Redirecting to login...</div>;
  }

  return <div>Protected content</div>;
}
```

## Vanilla JavaScript / TypeScript

```typescript
import { AuthClient } from "@autonomous-ai/auth-sdk";

const client = new AuthClient({
  ssoUrl: "https://sso.example.com",
  clientId: "my-app",
  redirectUri: "https://app.example.com/callback",
  scope: "openid profile email",
});

// Start login (redirects the browser to SSO)
await client.authorize({ nextUrl: "/dashboard" });

// On the callback page
const params = new URLSearchParams(window.location.search);
const result = await client.handleCallback(
  params.get("code")!,
  params.get("state")!
);

if (result.success) {
  if (result.nextUrl) window.location.href = result.nextUrl;
} else {
  console.error(result.error);
}

// Auth status
if (client.isAuthenticated()) {
  console.log("User:", client.getUser());
}

// Access token for API calls — refreshes automatically if expired
const token = await client.getValidAccessToken();
await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });

// Logout (clears tokens and redirects to SSO logout)
client.logout();
```

## API Reference

### AuthClient

| Method                          | Returns                    | Description                              |
| ------------------------------- | -------------------------- | ---------------------------------------- |
| `authorize(options?)`           | `Promise<void>`            | Start OAuth2 login flow (redirects away)  |
| `handleCallback(code, state)`   | `Promise<CallbackResult>`  | Exchange authorization code for tokens    |
| `refreshToken()`                | `Promise<TokenResponse>`   | Refresh the access token                  |
| `logout(redirectUri?)`          | `void`                     | Clear tokens and redirect to SSO logout   |
| `isAuthenticated()`             | `boolean`                  | Whether a valid session exists            |
| `getAccessToken()`              | `string \| null`           | Current access token                      |
| `getRefreshToken()`             | `string \| null`           | Current refresh token                     |
| `getUser()`                     | `User \| null`             | User decoded from the JWT                 |
| `isTokenExpired(buffer = 60)`   | `boolean`                  | Expiry check with a seconds buffer        |
| `getValidAccessToken()`         | `Promise<string>`          | Token, refreshed if expired               |
| `clearTokens()`                 | `void`                     | Clear tokens without an SSO logout        |

`createAuthClient(config)` is a factory shorthand for `new AuthClient(config)`.

### Login source tracking

- `login({ entryPoint: 'header' })` / `authorize({ entryPoint })` tells auth-service which UI placement started the sign-in.
- After the callback, `result.tokens.first_time_in_app` is `true` the first time this user gets a session in your app (use it for onboarding). `result.tokens.first_time` is `true` for their first sign-in anywhere in the Autonomous ecosystem.

### AuthConfig

| Option        | Type           | Default          | Description                          |
| ------------- | -------------- | ---------------- | ------------------------------------ |
| `ssoUrl`      | `string`       | required         | SSO server base URL                  |
| `clientId`    | `string`       | required         | OAuth2 client ID                     |
| `redirectUri` | `string`       | required         | Callback URL registered with the SSO |
| `scope`       | `string?`      | -                | Space-separated scopes               |
| `storage`     | `TokenStorage?` | `localStorage`  | Custom token storage                 |

### AuthorizeOptions

| Option      | Type                                    | Description                               |
| ----------- | --------------------------------------- | ----------------------------------------- |
| `prompt`    | `'select_account' \| 'none' \| 'login'` | Force account selection or silent auth    |
| `loginHint` | `string`                                | Pre-fill email for login                  |
| `nextUrl`   | `string`                                | URL to redirect to after successful login |

### User

Parsed from the JWT's `ext_info` claim.

| Field                | Type        | Description               |
| -------------------- | ----------- | ------------------------- |
| `id`                 | `string`    | User ID                   |
| `email`              | `string`    | User email                |
| `fullName`           | `string?`   | Full name                 |
| `code`               | `string?`   | User code                 |
| `roles`              | `string[]?` | User roles                |
| `scope`              | `string?`   | Granted scope             |
| `companyDomain`      | `string?`   | Company domain            |
| `companyDomainType`  | `string?`   | Company domain type       |
| `isEppUser`          | `boolean?`  | Employee Purchase Program |
| `vendorId`           | `string?`   | Vendor ID                 |
| `vendorCode`         | `string?`   | Vendor code               |
| `vendorName`         | `string?`   | Vendor name               |
| `referralCode`       | `string?`   | Referral code             |

### CallbackResult

| Field     | Type              | Description                            |
| --------- | ----------------- | -------------------------------------- |
| `success` | `boolean`         | Whether the code exchange succeeded    |
| `tokens`  | `TokenResponse?`  | Tokens returned by auth-service        |
| `error`   | `string?`         | Error message when `success` is false  |
| `nextUrl` | `string?`         | Post-login redirect target             |

### React hooks

| Hook                      | Returns                                                     | Description            |
| ------------------------- | ----------------------------------------------------------- | ---------------------- |
| `useAuth()`               | `AuthContextValue`                                           | Auth state and actions |
| `useUser()`               | `User \| null`                                               | Current user           |
| `useAuthCallback(config)` | `{ isLoading, error, success, result, nextUrl }`             | Handle OAuth2 callback |

`useAuth()` returns `isAuthenticated`, `isLoading`, `user`, `error`, plus `login()`, `logout()`, `getAccessToken()`, `refreshToken()` and `refreshAuthState()`.

`useAuthCallback` creates its own `AuthClient` and works outside `AuthProvider` — but call `refreshAuthState()` afterwards so the provider picks up the new tokens.

### AuthProvider props

| Prop            | Type         | Default  | Description                      |
| --------------- | ------------ | -------- | -------------------------------- |
| `config`        | `AuthConfig` | required | Auth configuration               |
| `autoRefresh`   | `boolean`    | `true`   | Auto-refresh tokens              |
| `refreshBuffer` | `number`     | `60`     | Seconds before expiry to refresh |
| `onAuthChange`  | `function`   | -        | Called on auth state change      |

## Custom storage

Tokens go to `localStorage` by default. Supply any object implementing `TokenStorage` to change that — e.g. `sessionStorage` so the session dies with the tab:

```typescript
const client = new AuthClient({
  ...config,
  storage: {
    getItem: (key) => sessionStorage.getItem(key),
    setItem: (key, value) => sessionStorage.setItem(key, value),
    removeItem: (key) => sessionStorage.removeItem(key),
  },
});
```

The PKCE verifier and `state` always use `sessionStorage`, regardless of this setting.

## Security

- PKCE (S256) prevents authorization code interception
- `state` parameter for CSRF protection, validated on callback
- PKCE verifier kept in `sessionStorage`, never in `localStorage`
- Tokens refreshed automatically before expiry (`refreshBuffer`)

## License

MIT
