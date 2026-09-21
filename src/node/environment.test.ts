import { describe, expect, it } from 'vitest'
import { browserCommand, prefersManualMode } from './environment'

describe('prefersManualMode', () => {
  it('is true over SSH', () => {
    expect(prefersManualMode({ SSH_CONNECTION: '10.0.0.1 22' }, 'darwin')).toBe(true)
    expect(prefersManualMode({ SSH_TTY: '/dev/pts/0' }, 'linux')).toBe(true)
  })

  it('is true on Linux without a display', () => {
    expect(prefersManualMode({}, 'linux')).toBe(true)
    expect(prefersManualMode({ DISPLAY: ':0' }, 'linux')).toBe(false)
    expect(prefersManualMode({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(false)
  })

  it('is false on a desktop session', () => {
    expect(prefersManualMode({}, 'darwin')).toBe(false)
    expect(prefersManualMode({}, 'win32')).toBe(false)
  })
})

describe('browserCommand', () => {
  it('quotes the URL for cmd.exe on Windows so an "&" in the query string is not treated as a command separator', () => {
    const url = 'http://127.0.0.1:54321/callback?code=abc&state=xyz'
    const { command, args, options } = browserCommand(url, 'win32')

    expect(command).toBe('cmd')
    expect(args).toEqual(['/c', 'start', '""', `"${url}"`])
    // Node must not re-escape the quotes we already added.
    expect(options?.windowsVerbatimArguments).toBe(true)
  })

  it('opens the URL directly on macOS, with no shell quoting to worry about', () => {
    expect(browserCommand('https://a.b/?x=1&y=2', 'darwin')).toEqual({ command: 'open', args: ['https://a.b/?x=1&y=2'] })
  })

  it('opens the URL directly on Linux, with no shell quoting to worry about', () => {
    expect(browserCommand('https://a.b/?x=1&y=2', 'linux')).toEqual({ command: 'xdg-open', args: ['https://a.b/?x=1&y=2'] })
  })
})
