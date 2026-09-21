import { createInterface } from 'node:readline/promises'
import { AuthSignInError } from './errors'
import type { NodeSignInIO } from './types'

/** Prompts on stderr and reads from stdin, so stdout stays free for output. */
export function defaultSignInIO(): NodeSignInIO {
  return {
    write(text) {
      process.stderr.write(text)
    },
    async readLine(prompt) {
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        return await rl.question(prompt)
      } finally {
        rl.close()
      }
    },
  }
}

/**
 * Reads what the confirmation page showed: "code#state", or the whole callback
 * URL if the person copied that instead.
 */
export async function readPastedCode(io: NodeSignInIO, state: string): Promise<string> {
  const answer = (await io.readLine('Paste the code from your browser: ')).trim()
  if (!answer) {
    throw new AuthSignInError('CANCELLED', 'No code was pasted.')
  }
  let code: string | null = null
  let pastedState: string | null = null
  if (answer.includes('://')) {
    const url = new URL(answer)
    code = url.searchParams.get('code')
    pastedState = url.searchParams.get('state')
  } else {
    const [rawCode, rawState = ''] = answer.split('#')
    code = rawCode.trim() || null
    pastedState = rawState.trim() || null
  }
  if (!code) {
    throw new AuthSignInError('CANCELLED', "That does not look like a sign-in code. It looks like 'code#state'.")
  }
  if (pastedState !== state) {
    throw new AuthSignInError('STATE_MISMATCH', 'That code belongs to a different sign-in. Start again.')
  }
  return code
}
