import { describe, expect, it } from 'vitest'
import { NODE_BUDGET, showsNodes } from '../pages/overview/memoryGraph/graphView'

const size = { width: 800, height: 600 }
const big = [{ id: 0, x: 0, y: 0, r: 100, count: NODE_BUDGET * 3, label: null }]

describe('when the memory graph opens a cluster into memories', () => {
  it('shows a cluster larger than the node budget as a cluster while it is in view whole', () => {
    expect(showsNodes({ cx: 0, cy: 0, k: 2 }, size, big)).toBe(false)
  })

  it('opens that cluster into memories once the view holds a small part of it', () => {
    expect(showsNodes({ cx: 0, cy: 0, k: 40 }, size, big)).toBe(true)
  })
})
