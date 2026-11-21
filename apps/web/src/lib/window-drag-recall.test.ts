import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DRAG_MARK, RECALL_MARK, installWindowDragRecall } from './window-drag-recall'

afterEach(() => {
  document.body.innerHTML = ''
  document.body.removeAttribute(RECALL_MARK)
  delete document.documentElement.dataset.platform
  vi.restoreAllMocks()
})

describe('macOS window drag base CSS contract and recall watcher', () => {
  it('defines darwin drag, recall, portal subtraction, interactive no-drag, vibrancy, and drag-bar rules in base.css', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/base.css'), 'utf8')
    expect(css).toMatch(/html\[data-platform='darwin'\],\s*html\[data-platform='darwin'\] body\s*\{[^}]*background:\s*transparent;/m)
    expect(css).toContain("html[data-platform='darwin'] [data-window-drag]")
    expect(css).toContain("html[data-platform='darwin'] [data-window-drag-recall]")
    expect(css).toContain("html[data-platform='darwin'] body > :not(#root)")
    expect(css).toContain('html[data-platform=\'darwin\'] :is(')
    expect(css).toContain('-webkit-app-region: drag;')
    expect(css).toContain('-webkit-app-region: no-drag;')
    expect(css).toContain('.youdub-desktop-drag-bar')
  })

  it('does nothing outside darwin platform', () => {
    const row = document.createElement('div')
    row.setAttribute(DRAG_MARK, '')
    document.body.appendChild(row)
    const frames: Array<() => void> = []

    const dispose = installWindowDragRecall({
      document,
      scheduleFrame: (fn) => {
        frames.push(fn)
        return () => {}
      },
    })

    expect(frames).toHaveLength(0)
    expect(document.body.hasAttribute(RECALL_MARK)).toBe(false)
    dispose()
  })

  it('pulses and clears data-window-drag-recall when a marked row mounts, moves, and settles on darwin', () => {
    document.documentElement.dataset.platform = 'darwin'
    const row = document.createElement('div')
    row.setAttribute(DRAG_MARK, '')
    let width = 240
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          x: 0,
          y: 0,
          width,
          height: 48,
          top: 0,
          left: 0,
          right: width,
          bottom: 48,
          toJSON: () => ({}),
        }) as DOMRect,
    )
    document.body.appendChild(row)

    let resizeTrigger: (() => void) | undefined
    const frameQueue: Array<() => void> = []
    const flushNext = () => {
      const next = frameQueue.shift()
      next?.()
    }

    const dispose = installWindowDragRecall({
      document,
      scheduleFrame: (fn) => {
        frameQueue.push(fn)
        return () => {}
      },
      watchBox: (_el, changed) => {
        resizeTrigger = changed
        return () => {
          resizeTrigger = undefined
        }
      },
    })

    // First frame discovers the mounted row -> sets recall mark
    flushNext()
    expect(document.body.hasAttribute(RECALL_MARK)).toBe(true)

    // Subsequent settled frame clears recall mark
    flushNext()
    expect(document.body.hasAttribute(RECALL_MARK)).toBe(false)

    // Row width changes (e.g. sidebar collapse / resize) -> pulses again then clears once settled
    width = 56
    resizeTrigger?.()
    flushNext()
    expect(document.body.hasAttribute(RECALL_MARK)).toBe(true)
    flushNext()
    expect(document.body.hasAttribute(RECALL_MARK)).toBe(false)

    dispose()
    expect(resizeTrigger).toBeUndefined()
  })
})
