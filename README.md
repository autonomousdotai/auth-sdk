# @autonomous2026/auth-sdk

Client SDK for auth-service SSO OAuth2 flow with PKCE support.

## Installation

```bash
npm install @autonomous2026/auth-sdk
```

Or link locally:

```bash
cd sdk && npm install && npm run build
cd .. && npm link ./sdk
```

## Quick Start (React)

### 1. Wrap your app with AuthProvider

```tsx
import { AuthProvider } from "@autonomous2026/auth-sdk/react";

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
import { useAuth, useUser } from "@autonomous2026/auth-sdk/react";

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

  return (
    <div>
      <p>Welcome, {user.fullName || user.email}!</p>
    </div>
  );
}
```

### 3. Handle OAuth2 callback

```tsx
import { useAuthCallback } from "@autonomous2026/auth-sdk/react";
import { useNavigate } from "react-router-dom";

function CallbackPage() {
  const navigate = useNavigate();
  const { isLoading, error, success, nextUrl } = useAuthCallback(authConfig);

  useEffect(() => {
    if (success) {
      // Redirect to nextUrl if provided, otherwise go to home
      navigate(nextUrl || "/");
    }
  }, [success, navigate, nextUrl]);

  if (isLoading) return <div>Processing login...</div>;
  if (error) return <div>Login failed: {error}</div>;

  return null;
}
```

### 4. Post-login redirect (nextUrl)

Use `nextUrl` to redirect users back to the page they were on before login. This is useful for protected pages that require authentication.

```tsx
import { useAuth } from "@autonomous2026/auth-sdk/react";
import { useLocation } from "react-router-dom";

function ProtectedPage() {
  const location = useLocation();
  const { isAuthenticated, isLoading, login } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      // Save current URL and redirect to SSO
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

The `nextUrl` is stored in `sessionStorage` before redirecting to SSO, and is returned via `useAuthCallback` after successful authentication. No server-side changes are needed.

## Vanilla JavaScript Usage

```typescript
import { AuthClient } from "@autonomous2026/auth-sdk";

const client = new AuthClient({
  ssoUrl: "https://sso.example.com",
  clientId: "my-app",
  redirectUri: "https://app.example.com/callback",
  scope: "openid profile email",
});

// Start login (with optional nextUrl for post-login redirect)
await client.authorize({ nextUrl: "/dashboard" });

// Handle callback (on callback page)
const result = await client.handleCallback(code, state);
if (result.success) {
  console.log("Logged in!", result.tokens);
  // Redirect to nextUrl if provided
  if (result.nextUrl) {
    window.location.href = result.nextUrl;
  }
}

// Check auth status
if (client.isAuthenticated()) {
  const user = client.getUser();
  console.log("User:", user);
}

// Get access token (auto-refreshes if expired)
const token = await client.getValidAccessToken();

// Logout
client.logout();
```

## API Reference

### AuthClient

| Method                        | Description                     |
| ----------------------------- | ------------------------------- |
| `authorize(options?)`         | Start OAuth2 login flow         |
| `handleCallback(code, state)` | Exchange code for tokens        |
| `refreshToken()`              | Refresh access token            |
| `logout(redirectUri?)`        | Logout and redirect to SSO      |
| `isAuthenticated()`           | Check if user is logged in      |
| `getAccessToken()`            | Get current access token        |
| `getUser()`                   | Get decoded user from JWT       |
| `getValidAccessToken()`       | Get token, refresh if expired   |
| `clearTokens()`               | Clear tokens without SSO logout |

### AuthorizeOptions

| Option      | Type                                    | Description                                    |
| ----------- | --------------------------------------- | ---------------------------------------------- |
| `prompt`    | `'select_account' \| 'none' \| 'login'` | Force account selection or silent auth         |
| `loginHint` | `string`                                | Pre-fill email for login                       |
| `nextUrl`   | `string`                                | URL to redirect to after successful login      |

### User Object

| Field           | Type        | Description     |
| --------------- | ----------- | --------------- |
| `id`            | `string`    | User ID         |
| `email`         | `string`    | User email      |
| `fullName`      | `string?`   | Full name       |
| `roles`         | `string[]?` | User roles      |
| `companyDomain` | `string?`   | Company domain  |
| `isEppUser`     | `boolean?`  | EPP user status |

### React Hooks

| Hook                      | Returns            | Description            |
| ------------------------- | ------------------ | ---------------------- |
| `useAuth()`               | `AuthContextValue` | Auth state and actions |
| `useUser()`               | `User \| null`     | Current user info      |
| `useAuthCallback(config)` | Callback state     | Handle OAuth2 callback |

### AuthProvider Props

| Prop            | Type         | Default  | Description                      |
| --------------- | ------------ | -------- | -------------------------------- |
| `config`        | `AuthConfig` | required | Auth configuration               |
| `autoRefresh`   | `boolean`    | `true`   | Auto-refresh tokens              |
| `refreshBuffer` | `number`     | `60`     | Seconds before expiry to refresh |
| `onAuthChange`  | `function`   | -        | Callback on auth state change    |

## Custom Storage

By default, tokens are stored in `localStorage`. You can provide a custom storage:

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

## Security

- Uses PKCE (S256) to prevent authorization code interception
- State parameter for CSRF protection
- PKCE verifier stored in sessionStorage (not localStorage)
- Automatic token refresh before expiry
