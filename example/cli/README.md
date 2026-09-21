# Example CLI

A CLI that signs in with `@autonomous-ai/auth-sdk/node`.

```bash
npm install && npm run build
node example/cli/cli.mjs login --sso https://auth.staging.autonomousdev.xyz --client-id manual-code-test
node example/cli/cli.mjs login --manual --sso https://auth.staging.autonomousdev.xyz --client-id manual-code-test
node example/cli/cli.mjs whoami
node example/cli/cli.mjs logout
```

`login` opens a browser and listens on `127.0.0.1`; over SSH, or with `--manual`, it prints a URL and
asks for the code the page shows. The session is stored in `~/.config/auth-sdk-example/auth.json`.
The sign-in appears in the SSO Security page under Devices & apps, and `logout` removes it.

The client must list the redirect URIs it uses: `http://127.0.0.1/callback` for the loopback flow and
`https://<sso-domain>/oauth2/code` for the pasted-code flow.
