/**
 * Window drag recollection for the macOS desktop shell. Electron rebuilds the
 * window's `-webkit-app-region` rects only when a style pass changes a computed
 * app-region value (`electron#32341`), and Blink skips hidden boxes when it
 * collects them, so a chrome row that mounts, moves, or collapses without such
 * a change would leave native drag hit rects stale. This watcher keeps drag
 * geometry synchronized across transitions and layout changes.
 */

export const DRAG_MARK = 'data-window-drag'
export const RECALL_MARK = 'data-window-drag-recall'

const ROW_SELECTOR = `[${DRAG_MARK}]`
const GRACE_FRAMES = 2
const MOTION_EVENTS = ['transitionstart', 'transitionend', 'animationstart', 'animationend'] as const

export interface WindowDragRecallOptions {
  readonly document: Document
  readonly scheduleFrame?: (frame: () => void) => () => void
  readonly watchBox?: (row: Element, changed: () => void) => () => void
}

/**
 * Watch marked drag regions on macOS and pulse `data-window-drag-recall` on
 * `document.body` whenever any marked region mounts, unmounts, moves, or resizes.
 */
export function installWindowDragRecall(options: WindowDragRecallOptions): () => void {
  const doc = options.document
  if (doc.documentElement.dataset.platform !== 'darwin' || !doc.body) return () => {}

  const scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame
  const watchBox = options.watchBox ?? defaultWatchBox
  let geometry = new Map<Element, string>()
  const boxes = new Map<Element, () => void>()
  let scheduled = false
  let disposed = false
  let cancelPending: (() => void) | undefined
  let grace = 0

  const watchBoxes = (rows: readonly Element[]): void => {
    for (const [row, dispose] of boxes) {
      if (rows.includes(row)) continue
      dispose()
      boxes.delete(row)
    }
    for (const row of rows) {
      if (boxes.has(row)) continue
      boxes.set(row, watchBox(row, arm))
    }
  }

  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    cancelPending = scheduleFrame(() => {
      scheduled = false
      cancelPending = undefined
      if (disposed) return
      measure()
    })
  }

  const arm = (): void => {
    grace = GRACE_FRAMES
    schedule()
  }

  const measure = (): void => {
    // Clearing before measuring ensures a computed style pass observes an
    // app-region change back when moved rows settle.
    doc.body.removeAttribute(RECALL_MARK)
    const rows = Array.from(doc.querySelectorAll(ROW_SELECTOR))
    watchBoxes(rows)
    const next = new Map(rows.map((row) => [row, readBox(row)] as const))
    const moved =
      rows.length !== geometry.size || rows.some((row) => geometry.get(row) !== next.get(row))
    geometry = next
    if (moved) {
      doc.body.setAttribute(RECALL_MARK, '')
      grace = 0
      schedule()
      return
    }
    if (grace === 0) return
    grace -= 1
    schedule()
  }

  const onMotion = (event: Event): void => {
    if (movesRows(event.target)) arm()
  }

  const observer = new MutationObserver((records) => {
    if (records.some((record) => touchesRows(record, geometry.keys()))) arm()
  })
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true, characterData: true })
  for (const type of MOTION_EVENTS) doc.addEventListener(type, onMotion, true)
  arm()

  return () => {
    disposed = true
    observer.disconnect()
    for (const type of MOTION_EVENTS) doc.removeEventListener(type, onMotion, true)
    if (cancelPending !== undefined) cancelPending()
    for (const dispose of boxes.values()) dispose()
    boxes.clear()
    geometry.clear()
    doc.body.removeAttribute(RECALL_MARK)
  }
}

function readBox(row: Element): string {
  const rect = row.getBoundingClientRect()
  return `${rect.x},${rect.y},${rect.width},${rect.height}`
}

function movesRows(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest(ROW_SELECTOR) !== null || target.querySelector(ROW_SELECTOR) !== null
}

function touchesRows(record: MutationRecord, rows: Iterable<Element>): boolean {
  if (record.attributeName === RECALL_MARK) return false
  for (const node of [...record.addedNodes, ...record.removedNodes]) {
    if (
      node instanceof Element &&
      (node.matches(ROW_SELECTOR) || node.querySelector(ROW_SELECTOR) !== null)
    ) {
      return true
    }
  }
  const target = record.target instanceof Element ? record.target : record.target.parentElement
  if (target === null) return false
  if (record.type === 'childList') {
    for (const row of rows) {
      if (target.contains(row)) return true
    }
    return false
  }
  return target.closest(ROW_SELECTOR) !== null || target.querySelector(ROW_SELECTOR) !== null
}

function defaultScheduleFrame(frame: () => void): () => void {
  const handle = requestAnimationFrame(frame)
  return () => {
    cancelAnimationFrame(handle)
  }
}

function defaultWatchBox(row: Element, changed: () => void): () => void {
  if (typeof ResizeObserver !== 'function') return () => {}
  const observer = new ResizeObserver(changed)
  observer.observe(row)
  return () => {
    observer.disconnect()
  }
}
