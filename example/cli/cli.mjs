#!/usr/bin/env node
// Example CLI for @autonomous-ai/auth-sdk/node. Run it from the repo root
// after `npm run build`:
//   node example/cli/cli.mjs login --sso https://auth.staging.autonomousdev.xyz --client-id manual-code-test
import { AuthSessionError, AuthSignInError, configFilePath, createNodeAuthClient } from '../../dist/node/index.js'

const args = process.argv.slice(2)
const command = args[0]
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const auth = createNodeAuthClient({
  ssoUrl: flag('sso', 'https://auth.autonomous.ai'),
  clientId: flag('client-id', 'manual-code-test'),
  scope: "openid profile email cart company",
  appName: flag('app', 'auth-sdk-example'),
})

const die = (message) => {
  console.error(`\n  ✗ ${message}\n`)
  process.exit(1)
}

try {
  switch (command) {
    case 'login': {
      const session = await auth.signIn({ mode: args.includes('--manual') ? 'manual' : 'auto' })
      console.log(`\n  ✓ Signed in on ${session.deviceName}. Session stored in ${configFilePath(flag('app', 'auth-sdk-example'))}\n`)
      break
    }
    case 'whoami': {
      await auth.getAccessToken() // refreshes when needed
      const session = auth.getSession()
      console.log(JSON.stringify({
        device_name: session.deviceName,
        scope: session.scope,
        expires_at: new Date(session.expiresAt).toISOString(),
      }, null, 2))
      break
    }
    case 'logout': {
      await auth.logout()
      console.log('\n  ✓ Signed out. The session is gone from this machine and from Devices & apps.\n')
      break
    }
    default:
      console.log('Usage: cli.mjs <login [--manual] | whoami | logout> [--sso URL] [--client-id ID] [--app NAME]')
      process.exit(command ? 1 : 0)
  }
} catch (err) {
  if (err instanceof AuthSessionError || err instanceof AuthSignInError) die(`${err.message} (${err.code})`)
  throw err
}
