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

interface BrowserCommand {
  command: string
  args: string[]
  options?: { windowsVerbatimArguments?: boolean }
}

/**
 * Builds the command used to open `url` in the system browser, without
 * running it — kept separate from openBrowser so the Windows quoting can be
 * tested on any host platform.
 *
 * On Windows, `cmd /c start "" <url>` leaves the URL as several unquoted
 * command-line arguments: cmd.exe treats `&` (common in query strings) as a
 * command separator and truncates everything after it. Quoting the URL and
 * passing `windowsVerbatimArguments` (so Node does not re-escape the quotes
 * we already added) keeps it intact.
 */
export function browserCommand(url: string, platform: string = process.platform): BrowserCommand {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'start', '""', `"${url}"`],
      options: { windowsVerbatimArguments: true },
    }
  }
  return { command: 'xdg-open', args: [url] }
}

/** Opens the system browser. false when there is nothing to open it with. */
export function openBrowser(url: string): Promise<boolean> {
  const { command, args, options } = browserCommand(url)
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true, ...options })
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
