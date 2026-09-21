import { describe, expect, it } from 'vitest'
import { awaitLoopbackCallback } from './loopback'

describe('awaitLoopbackCallback', () => {
  it('hands back the code the browser redirected with', async () => {
    const pending = awaitLoopbackCallback({
      port: 0,
      state: 'st',
      timeoutMs: 5_000,
      async onReady(redirectUri) {
        const response = await fetch(`${redirectUri}?code=the-code&state=st`)
        expect(response.status).toBe(200)
        expect(await response.text()).toMatch(/signed in/i)
      },
    })

    await expect(pending).resolves.toBe('the-code')
  })

  it('refuses a callback whose state does not match', async () => {
    const pending = awaitLoopbackCallback({
      port: 0,
      state: 'st',
      timeoutMs: 5_000,
      async onReady(redirectUri) {
        await fetch(`${redirectUri}?code=c&state=other`)
      },
    })

    await expect(pending).rejects.toMatchObject({ code: 'STATE_MISMATCH' })
  })

  it('reports the error the server redirected with', async () => {
    const pending = awaitLoopbackCallback({
      port: 0,
      state: 'st',
      timeoutMs: 5_000,
      async onReady(redirectUri) {
        await fetch(`${redirectUri}?error=access_denied&state=st`)
      },
    })

    await expect(pending).rejects.toMatchObject({ code: 'SERVER' })
  })

  it('gives up after the timeout', async () => {
    await expect(awaitLoopbackCallback({ port: 0, state: 'st', timeoutMs: 50, onReady() {} }))
      .rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('stops when the caller aborts', async () => {
    const controller = new AbortController()
    const pending = awaitLoopbackCallback({ port: 0, state: 'st', timeoutMs: 5_000, signal: controller.signal, onReady() { controller.abort() } })
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('serves the callback at a configured path', async () => {
    const pending = awaitLoopbackCallback({
      port: 0,
      path: '/custom-callback',
      state: 'st',
      timeoutMs: 5_000,
      async onReady(redirectUri) {
        expect(new URL(redirectUri).pathname).toBe('/custom-callback')
        await fetch(`${redirectUri}?code=the-code&state=st`)
      },
    })

    await expect(pending).resolves.toBe('the-code')
  })

  it('ignores a stray request instead of failing the sign-in, and still completes afterwards', async () => {
    const pending = awaitLoopbackCallback({
      port: 0,
      state: 'st',
      timeoutMs: 5_000,
      async onReady(redirectUri) {
        const { origin } = new URL(redirectUri)
        const stray = await fetch(`${origin}/favicon.ico`)
        expect(stray.status).toBe(404)

        // A request to the callback path but with neither `code` nor `error`
        // (e.g. a preconnect probe) must also be ignored, not treated as "no
        // authorization code".
        const emptyCallback = await fetch(redirectUri)
        expect(emptyCallback.status).toBe(404)

        const response = await fetch(`${redirectUri}?code=the-code&state=st`)
        expect(response.status).toBe(200)
      },
    })

    await expect(pending).resolves.toBe('the-code')
  })

  it('sanitizes control/escape characters and caps the length of a reported error', async () => {
    const nasty = `bad[31mvalue${'x'.repeat(400)}`
    const pending = awaitLoopbackCallback({
      port: 0,
      state: 'st',
      timeoutMs: 5_000,
      async onReady(redirectUri) {
        await fetch(`${redirectUri}?error=${encodeURIComponent(nasty)}&state=st`)
      },
    })

    const err = await pending.catch((e) => e)
    expect(err).toMatchObject({ code: 'SERVER' })
    // eslint-disable-next-line no-control-regex -- asserting control chars are gone
    expect(err.message).not.toMatch(/[\x00-\x1f\x7f]/)
    expect(err.message.length).toBeLessThan(300)
  })
})
