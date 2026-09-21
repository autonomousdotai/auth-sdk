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
})
