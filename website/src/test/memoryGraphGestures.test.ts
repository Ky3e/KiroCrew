import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachGraphGestures, type GestureTarget } from '../pages/overview/memoryGraphGestures'
import { panBy, zoomAt, type View } from '../pages/overview/memoryGraph/graphView'

const SIZE = { width: 400, height: 300 }

/** The real view maths behind the gestures, one layout unit per pixel at the start. */
function mount(overNode = false) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const view: { current: View } = { current: { cx: 0, cy: 0, k: 1 } }
  const target: GestureTarget = {
    panBy: d => { view.current = panBy(view.current, d) },
    zoomAt: (at, f) => { view.current = zoomAt(view.current, SIZE, at, f) },
  }
  const handlers = { overNode: () => overNode, onBox: vi.fn(), onSelect: vi.fn(), onClear: vi.fn() }
  const detach = attachGraphGestures(container, target, handlers)
  return { container, view, handlers, detach }
}
const pointer = (type: string, target: EventTarget, init: Record<string, unknown>, pointerType = 'mouse', pointerId = 1) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.assign(event, { pointerId, pointerType })
  target.dispatchEvent(event)
  return event
}

// jsdom's WheelEvent drops the modifier keys from its init, so they are set on the event.
const wheel = (init: WheelEventInit, keys: { ctrlKey?: boolean; metaKey?: boolean } = {}) => {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
  for (const [key, value] of Object.entries(keys)) Object.defineProperty(event, key, { value })
  return event
}

afterEach(() => { document.body.replaceChildren() })

describe('the memory graph gestures (Figma model)', () => {
  it('pans on a wheel without ctrl, leaving the zoom alone, and keeps the page still', () => {
    const { container, view } = mount()
    const event = wheel({ deltaX: 30, deltaY: 50 })
    container.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(view.current.k).toBe(1)
    expect(view.current.cx).toBeCloseTo(30)
    expect(view.current.cy).toBeCloseTo(-50)
  })

  it('zooms on a pinch (a wheel with ctrl) or Cmd + wheel, around the pointer', () => {
    const { container, view } = mount()
    container.dispatchEvent(wheel({ deltaY: -100 }, { ctrlKey: true }))
    expect(view.current.k).toBeGreaterThan(1)
    const zoomed = view.current.k
    container.dispatchEvent(wheel({ deltaY: 100 }, { metaKey: true }))
    expect(view.current.k).toBeLessThan(zoomed)
  })

  it('draws a box on an empty-canvas drag and hands it over without moving the view', () => {
    const { container, view, handlers } = mount()
    pointer('pointerdown', container, { button: 0, clientX: 10, clientY: 10 })
    pointer('pointermove', window, { clientX: 120, clientY: 90 })
    expect(handlers.onBox).toHaveBeenLastCalledWith({ x: 10, y: 10, width: 110, height: 80 })
    pointer('pointerup', window, { clientX: 120, clientY: 90 })
    expect(handlers.onSelect).toHaveBeenCalledWith({ x: 10, y: 10, width: 110, height: 80 })
    expect(view.current).toEqual({ cx: 0, cy: 0, k: 1 })
  })

  it('pans on Space + drag, with the grab cursor, and leaves node presses to the click', () => {
    const { container, view, handlers } = mount()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', cancelable: true }))
    expect(container.style.cursor).toBe('grab')
    pointer('pointerdown', container, { button: 0, clientX: 100, clientY: 100 })
    pointer('pointermove', window, { clientX: 60, clientY: 100 })
    pointer('pointerup', window, { clientX: 60, clientY: 100 })
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ' }))
    // The content follows the hand: dragging left moves the view right.
    expect(view.current.cx).toBeCloseTo(40)
    expect(handlers.onSelect).not.toHaveBeenCalled()
    const node = mount(true)
    pointer('pointerdown', node.container, { button: 0, clientX: 10, clientY: 10 })
    pointer('pointermove', window, { clientX: 90, clientY: 90 })
    expect(node.handlers.onBox).not.toHaveBeenCalled()
  })

  it('pans on a middle-button drag too', () => {
    const { container, view } = mount()
    pointer('pointerdown', container, { button: 1, clientX: 100, clientY: 100 })
    pointer('pointermove', window, { clientX: 100, clientY: 50 })
    pointer('pointerup', window, { clientX: 100, clientY: 50 })
    expect(view.current.cy).toBeCloseTo(-50)
  })

  it('pans with one finger and zooms with two on a touch screen, with no box', () => {
    const { container, view, handlers } = mount()
    pointer('pointerdown', container, { clientX: 100, clientY: 100 }, 'touch', 1)
    pointer('pointermove', window, { clientX: 70, clientY: 100 }, 'touch', 1)
    expect(view.current.cx).toBeCloseTo(30)
    pointer('pointerdown', container, { clientX: 170, clientY: 100 }, 'touch', 2)
    const before = view.current.k
    // The fingers spread from 100 px apart to 200 px: twice the zoom.
    pointer('pointermove', window, { clientX: 270, clientY: 100 }, 'touch', 2)
    expect(view.current.k).toBeCloseTo(before * 2)
    pointer('pointerup', window, { clientX: 270, clientY: 100 }, 'touch', 2)
    pointer('pointerup', window, { clientX: 70, clientY: 100 }, 'touch', 1)
    expect(handlers.onBox).not.toHaveBeenCalled()
  })
})
