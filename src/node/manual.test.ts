import { describe, expect, it } from 'vitest'
import { readPastedCode } from './manual'
import type { NodeSignInIO } from './types'

function io(answers: string[]): NodeSignInIO & { written: string[] } {
  const written: string[] = []
  return {
    written,
    write(text) { written.push(text) },
    async readLine() { return answers.shift() ?? '' },
  }
}

describe('readPastedCode', () => {
  it('accepts code#state, ignoring surrounding whitespace', async () => {
    await expect(readPastedCode(io(['  the-code#st \n']), 'st')).resolves.toBe('the-code')
  })

  it('accepts a pasted callback URL', async () => {
    await expect(readPastedCode(io(['https://auth.test/oauth2/code?code=the-code&state=st']), 'st')).resolves.toBe('the-code')
  })

  it('refuses a code whose state does not match', async () => {
    await expect(readPastedCode(io(['the-code#other']), 'st')).rejects.toMatchObject({ code: 'STATE_MISMATCH' })
  })

  it('refuses an empty paste', async () => {
    await expect(readPastedCode(io(['   ']), 'st')).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})
