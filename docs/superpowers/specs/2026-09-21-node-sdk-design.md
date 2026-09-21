# Node SDK (`@autonomous-ai/auth-sdk/node`) — Design

Status: approved in brainstorming on 2026-09-21. Scope: **auth-sdk only** (plus an example CLI in this repo).

## Why

CLIs and scripts that sign a person in with Autonomous SSO have to implement the same flow every time:
a loopback redirect, PKCE, token storage, refresh, and revoke on logout. The harness CLI did it by hand
and got three details wrong (no `device_name`, no revoke on logout, and a refresh that treats a revoked
grant as an outage). This entry point makes that flow a library call.

auth-service already serves both halves: the loopback redirect (RFC 8252, registered
`http://127.0.0.1/<path>` matches any port) and the manual-code sign-in
(`redirect_uri = {SSO_DOMAIN}/oauth2/code`, released in v1.0.61).

The harness CLI is **not** changed here; the first consumer is the example CLI in this repo.

## Decisions

| Question | Decision |
|---|---|
| Sign-in method | `mode: 'auto'` (default) uses the loopback redirect when a browser can be opened, else the manual-code flow. `'loopback'` and `'manual'` force one. |
| Token storage | A file per app: `~/.config/<appName>/auth.json` (`XDG_CONFIG_HOME`, `%APPDATA%` on Windows), directory `0700`, file `0600`. A custom `storage` may replace it. |
| Package shape | A new `./node` entry point in the same package; no runtime dependencies; Node ≥ 20; the browser and React entry points are unchanged. |
| PKCE | Reuses `src/pkce.ts` (Web Crypto, available in Node ≥ 20), S256 only. |
| Refresh failure | HTTP 400 **or** 401 → the session is gone: clear it and throw `SIGNED_OUT`. Network error or 5xx → keep the tokens and throw `UNAVAILABLE`. |
| Example CLI | `example/cli` with `login` / `whoami` / `logout`, used to test by hand against staging. |
| Release | `1.1.0` on npm, with the user's approval. |

## API

```ts
import { createNodeAuthClient } from '@autonomous-ai/auth-sdk/node'

const auth = createNodeAuthClient({
  ssoUrl: 'https://auth.autonomous.ai',
  clientId: 'my-cli',
  appName: 'my-cli',          // picks the config directory
  scope?: 'openid profile email',
  redirectUri?: string,       // override the loopback path (default http://127.0.0.1:<port>/callback)
  loopbackPort?: number,      // default 0 = any free port
  deviceName?: string,        // default os.hostname()
  storage?: NodeTokenStorage, // default fileTokenStorage(appName)
})

await auth.signIn(options?: NodeSignInOptions): Promise<NodeSession>
await auth.getAccessToken(): Promise<string>   // refreshes when it expires within 60 s
auth.getSession(): NodeSession | null
auth.isSignedIn(): boolean
await auth.logout(): Promise<void>             // revokes the refresh token, then clears storage
```

```ts
interface NodeSignInOptions {
  mode?: 'auto' | 'loopback' | 'manual'   // default 'auto'
  prompt?: 'select_account' | 'login'
  loginHint?: string
  entryPoint?: string
  timeoutMs?: number                      // default 300_000
  signal?: AbortSignal
  /** Where the sign-in URL and the "paste the code" prompt are shown. Default: stderr + stdin. */
  io?: { write(text: string): void; readLine(prompt: string): Promise<string> }
  /** Called with the URL before the browser is opened, e.g. to print it in a different style. */
  onAuthorizeUrl?(url: string, mode: 'loopback' | 'manual'): void
}

interface NodeSession {
  accessToken: string
  refreshToken?: string
  expiresAt: number        // unix ms
  scope?: string
  deviceName: string
  obtainedAt: number       // unix ms
}

interface NodeTokenStorage {
  read(): Promise<NodeSession | null>
  write(session: NodeSession): Promise<void>
  clear(): Promise<void>
  /** Runs fn while no other process of this app writes the file. */
  withLock<T>(fn: () => Promise<T>): Promise<T>
}
```

Errors are `AuthSignInError` (`code: 'TIMEOUT' | 'CANCELLED' | 'STATE_MISMATCH' | 'SERVER' | 'NO_BROWSER'`)
and `AuthSessionError` (`code: 'SIGNED_OUT' | 'UNAVAILABLE' | 'NO_SESSION'`). Both carry a sentence a CLI
can print as is; `SIGNED_OUT` says to sign in again.

## Sign-in

### Choosing the mode (`'auto'`)

Manual when any of these holds, loopback otherwise:

- `SSH_CONNECTION` or `SSH_TTY` is set;
- Linux without `DISPLAY` and without `WAYLAND_DISPLAY`;
- the browser could not be opened (the opener command failed or is missing);
- `mode: 'manual'` was passed.

`mode: 'loopback'` never falls back; if the browser cannot be opened it throws `NO_BROWSER` (the URL is
still printed, so a user can open it themselves and the callback will arrive).

### Loopback

1. Listen on `127.0.0.1:<loopbackPort>` (0 = any free port); `redirect_uri = http://127.0.0.1:<port>/callback`.
2. Open `{ssoUrl}/oauth2/authorize?...` with PKCE S256 and a random `state` (`open` on macOS,
   `xdg-open` on Linux, `cmd /c start` on Windows).
3. On the callback: compare `state`, answer a small "You're signed in. You can close this tab." page
   (or the error page when the query carries `error`), then close the server.
4. Exchange the code at `/oauth2/token` with `code_verifier`, `client_id`, `redirect_uri` and `device_name`.

### Manual code

1. `redirect_uri = {ssoUrl}/oauth2/code`; the same PKCE and `state`.
2. Print the URL and prompt "Paste the code from your browser:".
3. Accept `code#state`, ignoring surrounding whitespace; a pasted full URL carrying `code`/`state` is
   accepted too. Mismatching `state` → `STATE_MISMATCH`.
4. The same token exchange as above.

Both modes write the session through `storage.withLock`.

## Tokens

- `getAccessToken()` returns the stored token while it has more than 60 s left; otherwise it refreshes.
- Refresh is coalesced in the process (one in-flight promise) and wrapped in `storage.withLock`, so two
  processes cannot overwrite each other's rotation. Inside the lock the file is re-read first: another
  process may already have refreshed it.
- `POST /oauth2/token` with `grant_type=refresh_token`, `client_id`, and `autonomous_sdk_version`.
- 400/401 → `storage.clear()` and `AuthSessionError('SIGNED_OUT')`. Network error, timeout or 5xx →
  `AuthSessionError('UNAVAILABLE')`, tokens kept.
- `logout()` posts the refresh token to `/oauth2/revoke` (RFC 7009, 2 s timeout, failures ignored) and
  then clears storage — so the grant leaves the user's "Devices & apps" list.

## File storage

- Path: `$XDG_CONFIG_HOME/<appName>/auth.json`, else `~/.config/<appName>/auth.json`; on Windows
  `%APPDATA%\<appName>\auth.json`.
- The directory is created `0700`, the file written `0600` through a temp file + rename, so a crash
  cannot leave half a file.
- `withLock` creates `auth.json.lock` with `wx`; it retries for up to 10 s, and treats a lock file older
  than 30 s as stale and removes it. The lock is released in `finally`.
- Unreadable or corrupt JSON is treated as "no session" (and the file is left alone).

## Example CLI (`example/cli`)

`node cli.mjs login [--manual] [--sso <url>] [--client-id <id>]`, `whoami`, `logout`. It prints what the
SDK returns (never the tokens: `whoami` shows the account and the expiry). Used for the staging check.

## Testing

- vitest as a dev dependency; tests run offline against a local `node:http` server standing in for
  auth-service.
- Cases: loopback receives the callback and exchanges the code (including `device_name` and `state`
  mismatch); manual mode reads `code#state` from the injected `io`; mode selection per environment
  variable; refresh coalescing and the lock; 401 clears the session while 500 keeps it; `logout` posts to
  `/oauth2/revoke` and clears storage; file permissions and the temp-file rename.
- By hand on staging with the `manual-code-test` client: `login`, `login --manual`, `whoami`, `logout`,
  and the row appearing and disappearing in the SSO Security page.

## Out of scope

- Changing the harness CLI (a separate change, once this ships).
- The Go and Flutter SDKs, and the device flow (RFC 8628) for keyboardless devices.
- Storing tokens in an OS keychain.
- Multiple accounts per app (one session per `appName`).
