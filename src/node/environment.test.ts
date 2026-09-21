import { describe, expect, it } from 'vitest'
import { prefersManualMode } from './environment'

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
