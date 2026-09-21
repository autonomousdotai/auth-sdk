import { spawn } from 'node:child_process'

/**
 * Whether the manual-code flow is the right default here: a browser on this
 * machine cannot reach a loopback listener over SSH, and a Linux box without a
 * display has no browser to open.
 */
export function prefersManualMode(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true
  return false
}

/** Opens the system browser. false when there is nothing to open it with. */
export function openBrowser(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]] :
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
    ['xdg-open', [url]]
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args as string[], { stdio: 'ignore', detached: true })
      child.on('error', () => resolve(false))
      child.on('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}
