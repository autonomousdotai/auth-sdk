import { createServer } from 'node:http'
import { AuthSignInError } from './errors.js'

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;padding:64px">
<h1>You're signed in</h1><p>You can close this tab and return to your terminal.</p></body>`

const FAILED_PAGE = `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;padding:64px">
<h1>Sign-in failed</h1><p>You can close this tab and try again in your terminal.</p></body>`

const MAX_ERROR_LEN = 200

/**
 * Makes an `error` query value safe to print to a terminal: strips ASCII
 * control/escape characters (a malicious or buggy redirect could otherwise
 * inject terminal escape sequences) and caps the length.
 */
function sanitizeErrorParam(value: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately stripping control/escape bytes
  const stripped = value.replace(/[\x00-\x1f\x7f]/g, '')
  return stripped.length > MAX_ERROR_LEN ? `${stripped.slice(0, MAX_ERROR_LEN)}…` : stripped
}

/**
 * Serves one OAuth callback on 127.0.0.1 and resolves with its code. The
 * browser must run on this machine — see prefersManualMode for when it cannot.
 */
export function awaitLoopbackCallback(args: {
  port: number
  /** The callback path, e.g. "/callback". Defaults to "/callback". */
  path?: string
  state: string
  timeoutMs: number
  signal?: AbortSignal
  onReady(redirectUri: string): void | Promise<void>
}): Promise<string> {
  const path = args.path ?? '/callback'
  return new Promise<string>((resolve, reject) => {
    const server = createServer()
    let settled = false
    const finish = (err: AuthSignInError | null, code?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      args.signal?.removeEventListener('abort', onAbort)
      server.close(() => (err ? reject(err) : resolve(code as string)))
      // Belt-and-suspenders for any socket that didn't pick up Connection: close
      // in time (or never sent a request at all, e.g. timeout/abort) — force it
      // shut now rather than let server.close()'s callback wait on it.
      server.closeAllConnections()
    }
    const timer = setTimeout(() => finish(new AuthSignInError('TIMEOUT', 'Timed out waiting for the browser sign-in.')), args.timeoutMs)
    const onAbort = () => finish(new AuthSignInError('CANCELLED', 'The sign-in was cancelled.'))
    args.signal?.addEventListener('abort', onAbort, { once: true })

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      // A favicon probe, a preconnect, or another tab hitting this port is
      // not the OAuth callback — answer 404 and keep waiting for the real one,
      // instead of aborting the whole sign-in on the first stray request.
      if (url.pathname !== path || (!code && !error)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
        res.end('Not found')
        return
      }
      const ok = !error && code && state === args.state
      // Tell Node (and the browser) to close this socket once the response is
      // sent, instead of leaving it idle on keep-alive — otherwise server.close()
      // below waits out the client's keep-alive timeout before its callback fires.
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
      res.end(ok ? DONE_PAGE : FAILED_PAGE)
      if (error) return finish(new AuthSignInError('SERVER', `The sign-in was refused: ${sanitizeErrorParam(error)}`))
      if (!code) return finish(new AuthSignInError('SERVER', 'The browser came back without an authorization code.'))
      if (state !== args.state) return finish(new AuthSignInError('STATE_MISMATCH', 'The browser came back with an unexpected state value.'))
      finish(null, code)
    })
    server.on('error', (err) => finish(new AuthSignInError('SERVER', `Could not listen on 127.0.0.1: ${err.message}`)))
    server.listen(args.port, '127.0.0.1', async () => {
      const address = server.address()
      if (!address || typeof address === 'string') return finish(new AuthSignInError('SERVER', 'Could not open a local port.'))
      try {
        await args.onReady(`http://127.0.0.1:${address.port}${path}`)
      } catch (err) {
        finish(new AuthSignInError('SERVER', (err as Error).message))
      }
    })
  })
}
