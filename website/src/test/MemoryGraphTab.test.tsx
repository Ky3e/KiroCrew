import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// cosmos.gl draws with WebGL, which the test DOM lacks: a stand-in records what
// the tab asks it to draw and lets a test fire its callbacks.
type Config = Record<string, unknown> & {
  onPointClick?: (i: number) => void
  onPointMouseOver?: (i: number) => void
}
const cosmos = vi.hoisted(() => {
  const instances: FakeGraph[] = []
  const state = { failNext: false, deviceFails: false }
  class FakeGraph {
    config: Config
    positions = new Float32Array()
    colors = new Float32Array()
    renders: (number | undefined)[] = []
    ready: Promise<void>
    constructor(_el: HTMLElement, config: Config) {
      if (state.failNext) { state.failNext = false; throw new Error('no WebGL') }
      this.config = { ...config }; instances.push(this)
      this.ready = state.deviceFails ? Promise.reject(new Error('no WebGL device')) : Promise.resolve()
    }
    setPointPositions(p: Float32Array) { this.positions = p }
    setPointColors(c: Float32Array) { this.colors = c }
    setPointSizes() {}
    setConfigPartial(c: Config) { Object.assign(this.config, c) }
    render(_alpha?: number, duration?: number) { this.renders.push(duration) }
    transforms = 0
    setViewTransform() { this.transforms++ }
    destroy() {}
  }
  return { instances, FakeGraph, set failNext(v: boolean) { state.failNext = v }, set deviceFails(v: boolean) { state.deviceFails = v } }
})
type FakeGraph = InstanceType<typeof cosmos.FakeGraph>
vi.mock('@cosmos.gl/graph', () => ({ Graph: cosmos.FakeGraph }))

vi.mock('../api/client', () => ({
  api: {
    memoryGraphOverview: vi.fn(), memoryGraphNodes: vi.fn(),
    memoryGraphSearch: vi.fn(), memoryGraphSelect: vi.fn(),
  },
}))
const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('../hooks/useReducedMotion', () => ({ useReducedMotion: () => motion.reduced }))

import { api } from '../api/client'
import MemoryGraphTab from '../pages/overview/MemoryGraphTab'
import { MemoryJumpContext } from '../pages/overview/memoryPage/memoryJump'

const node = (id: string, kind: 'episode' | 'fact' | 'lesson', x: number, y: number, weight = 1) => ({
  id, kind, x, y, cluster: 0, weight, label: `${id} text`, ref: `${id.padEnd(10, '0')}`.slice(0, 10),
  record: { kind: kind === 'lesson' ? 'directive' : kind, id },
})
const NODES = [node('aa', 'fact', -50, 0), node('bb', 'lesson', 50, 0), node('cc', 'episode', 0, 40, 0.1)]
const overview = (count = 3) => ({
  status: 'ready', clusters: [{ id: 0, x: 0, y: 0, r: 60, count, label: 'topic' }],
  totals: { fact: 1, lesson: 1, episode: 1 }, bounds: [-60, -60, 60, 60],
})

function renderTab(jump = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryJumpContext.Provider value={jump}><MemoryGraphTab store="member-a" /></MemoryJumpContext.Provider></QueryClientProvider>)
  return jump
}
const graph = () => cosmos.instances.at(-1)!
/**
 * Ceiling for a wait that crosses the canvas's lazy boundary: the overview
 * query resolves, the canvas effect commits, `import('@cosmos.gl/graph')`
 * resolves (the mocked module, still a dynamic import), and the graph is built.
 * A loaded coverage worker can take longer than RTL's default second for that.
 */
const LAZY_INIT = { timeout: 5000 }
/** The canvas once the visible nodes are drawn. */
async function drawn(n = NODES.length) {
  await waitFor(() => expect(graph().positions.length).toBe(n * 2), LAZY_INIT)
  return graph()
}
const indexOf = (id: string) => NODES.findIndex(n => n.id === id)
const alphaOf = (g: FakeGraph, id: string) => g.colors[indexOf(id) * 4 + 3]
const pointer = (type: string, target: EventTarget, init: Record<string, unknown>) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.assign(event, { pointerId: 1, pointerType: 'mouse' })
  act(() => { target.dispatchEvent(event) })
}

beforeEach(() => {
  vi.clearAllMocks()
  cosmos.instances.length = 0
  motion.reduced = false
  cosmos.deviceFails = false
  vi.mocked(api.memoryGraphOverview).mockResolvedValue(overview() as never)
  vi.mocked(api.memoryGraphNodes).mockResolvedValue({ status: 'ready', nodes: NODES, cursor: null } as never)
  vi.mocked(api.memoryGraphSearch).mockResolvedValue({ status: 'ready', matches: [], total: 0 } as never)
  vi.mocked(api.memoryGraphSelect).mockResolvedValue({ status: 'ready', count: 0 } as never)
})

describe('the memory graph over every memory', () => {
  it('draws the server positions of the nodes in view, for the named store', async () => {
    renderTab()
    const g = await drawn()
    expect(vi.mocked(api.memoryGraphNodes).mock.calls[0][0]).toBe('member-a')
    expect([...g.positions]).toEqual(NODES.flatMap(n => [n.x, n.y]))
    expect(g.config.enableSimulation).toBe(false)
  })

  it('opens a clicked node in the Memories tab', async () => {
    const jump = renderTab()
    const g = await drawn()
    act(() => g.config.onPointClick!(indexOf('bb')))
    expect(jump).toHaveBeenCalledWith([NODES[1].ref], NODES[1].record)
  })

  it('fades an experience by its recall weight and keeps facts and lessons solid', async () => {
    renderTab()
    const g = await drawn()
    expect(alphaOf(g, 'aa')).toBe(1)
    expect(alphaOf(g, 'bb')).toBe(1)
    expect(alphaOf(g, 'cc')).toBeLessThan(1)
    expect(alphaOf(g, 'cc')).toBeGreaterThan(0.1)
  })

  it('opens a cluster into its nodes from the cluster centre, animated', async () => {
    renderTab()
    const g = await drawn()
    expect(g.renders.at(-1)).toBeGreaterThan(0)
  })

  it('swaps clusters for nodes at once under reduced motion', async () => {
    motion.reduced = true
    renderTab()
    const g = await drawn()
    expect(g.renders.every(d => d === 0)).toBe(true)
  })

  it('highlights what the server found, across every node, and dims the rest', async () => {
    vi.mocked(api.memoryGraphSearch).mockResolvedValue({ status: 'ready', matches: [{ id: 'bb', x: 50, y: 0 }], total: 1 } as never)
    renderTab()
    const g = await drawn()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'needle' } })
    await waitFor(() => expect(api.memoryGraphSearch).toHaveBeenCalledWith('member-a', 'needle', { kinds: undefined }), { timeout: 3000 })
    await waitFor(() => expect(alphaOf(g, 'aa')).toBeLessThan(0.2))
    expect(alphaOf(g, 'bb')).toBe(1)
  })

  it('counts a box selection on the server and hands the box itself to the Memories tab', async () => {
    vi.mocked(api.memoryGraphSelect).mockResolvedValue({ status: 'ready', count: 4321 } as never)
    const jump = renderTab()
    await drawn()
    const canvas = screen.getByTestId('memory-graph-canvas')
    pointer('pointerdown', canvas, { button: 0, clientX: 10, clientY: 10 })
    pointer('pointermove', window, { clientX: 200, clientY: 150 })
    pointer('pointerup', window, { clientX: 200, clientY: 150 })
    await waitFor(() => expect(api.memoryGraphSelect).toHaveBeenCalled())
    const [store, bbox] = vi.mocked(api.memoryGraphSelect).mock.calls[0]
    expect(store).toBe('member-a')
    expect(bbox[0]).toBeLessThan(bbox[2])
    const status = await screen.findByRole('status')
    fireEvent.click(within(status).getByRole('button'))
    expect(jump).toHaveBeenCalledWith([], undefined, { bbox: bbox.join(','), count: 4321, kinds: undefined })
  })

  it('moves keyboard focus between nodes with the arrows and opens one with Enter', async () => {
    const jump = renderTab()
    const g = await drawn()
    const canvas = screen.getByTestId('memory-graph-canvas')
    canvas.focus()
    fireEvent.keyDown(canvas, { key: 'ArrowLeft' })
    await waitFor(() => expect(g.config.focusedPointIndex).toBeDefined())
    const first = g.config.focusedPointIndex as number
    fireEvent.keyDown(canvas, { key: 'ArrowRight' })
    await waitFor(() => expect(g.config.focusedPointIndex).not.toBe(first))
    fireEvent.keyDown(canvas, { key: 'Enter' })
    const focused = NODES[g.config.focusedPointIndex as number]
    expect(jump).toHaveBeenCalledWith([focused.ref], focused.record)
  })

  it('shows clusters, not nodes, when the view holds more than the node budget', async () => {
    vi.mocked(api.memoryGraphOverview).mockResolvedValue(overview(250000) as never)
    renderTab()
    await waitFor(() => expect(cosmos.instances.length).toBe(1), LAZY_INIT)
    await waitFor(() => expect(graph().positions.length).toBe(2), LAZY_INIT)
    expect(api.memoryGraphNodes).not.toHaveBeenCalled()
  })

  it('waits for the first layout build, then draws', async () => {
    vi.mocked(api.memoryGraphOverview).mockResolvedValueOnce({ status: 'building' } as never)
    renderTab()
    await drawn()
    expect(vi.mocked(api.memoryGraphOverview).mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps search and filters when the canvas cannot start', async () => {
    cosmos.failNext = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderTab()
    expect(await screen.findByRole('textbox')).toBeTruthy()
    expect(screen.getAllByRole('radio').length).toBeGreaterThan(0)
    await waitFor(() => expect(warn).toHaveBeenCalled(), LAZY_INIT)
    expect(await screen.findByTestId('memory-graph-canvas-error', {}, LAZY_INIT)).toBeTruthy()
    warn.mockRestore()
  })

  it('shows a failed read with a retry instead of an empty graph', async () => {
    vi.mocked(api.memoryGraphOverview).mockRejectedValue(new Error('down'))
    renderTab()
    expect(await screen.findByTestId('memory-graph-load-error')).toBeTruthy()
    expect(cosmos.instances.length).toBe(0)
  })

  it('reads every page of a tile before drawing it', async () => {
    vi.mocked(api.memoryGraphNodes)
      .mockResolvedValueOnce({ status: 'ready', nodes: NODES.slice(0, 2), cursor: 'next' } as never)
      .mockResolvedValueOnce({ status: 'ready', nodes: NODES.slice(2), cursor: null } as never)
    renderTab()
    const g = await drawn()
    expect(vi.mocked(api.memoryGraphNodes).mock.calls[1][2]).toMatchObject({ cursor: 'next' })
    expect([...g.positions]).toEqual(NODES.flatMap(n => [n.x, n.y]))
  })

  it('reports a failed node read and reads it again on Retry', async () => {
    vi.mocked(api.memoryGraphNodes).mockRejectedValueOnce(new Error('nodes down'))
    renderTab()
    const notice = await screen.findByTestId('memory-graph-read-error', {}, LAZY_INIT)
    fireEvent.click(within(notice).getByRole('button', { name: /Retry/ }))
    await drawn()
    expect(screen.queryByTestId('memory-graph-read-error')).toBeNull()
  })

  it('reports a failed search instead of dimming every memory', async () => {
    vi.mocked(api.memoryGraphSearch).mockRejectedValueOnce(new Error('search down'))
    renderTab()
    const g = await drawn()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'needle' } })
    const notice = await screen.findByTestId('memory-graph-read-error', {}, { timeout: 3000 })
    expect(alphaOf(g, 'aa')).toBe(1)
    fireEvent.click(within(notice).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(api.memoryGraphSearch).toHaveBeenCalledTimes(2))
  })

  it('reports a failed box count and counts it again on Retry', async () => {
    vi.mocked(api.memoryGraphSelect).mockRejectedValueOnce(new Error('select down')).mockResolvedValue({ status: 'ready', count: 7 } as never)
    renderTab()
    await drawn()
    const canvas = screen.getByTestId('memory-graph-canvas')
    pointer('pointerdown', canvas, { button: 0, clientX: 10, clientY: 10 })
    pointer('pointermove', window, { clientX: 200, clientY: 150 })
    pointer('pointerup', window, { clientX: 200, clientY: 150 })
    const notice = await screen.findByTestId('memory-graph-read-error')
    fireEvent.click(within(notice).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(api.memoryGraphSelect).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.memoryGraphSelect).mock.calls[1][1]).toEqual(vi.mocked(api.memoryGraphSelect).mock.calls[0][1])
  })

  it('reads the nodes in view again on Refresh, even when the overview is the same', async () => {
    renderTab()
    await drawn()
    const before = vi.mocked(api.memoryGraphNodes).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() => expect(vi.mocked(api.memoryGraphNodes).mock.calls.length).toBeGreaterThan(before), { timeout: 3000 })
    await drawn()
  })

  it('stores a node reply under the filter it was asked for, not the one picked since', async () => {
    let answer: (v: unknown) => void = () => {}
    vi.mocked(api.memoryGraphNodes)
      .mockReturnValueOnce(new Promise(r => { answer = r }) as never)
      .mockResolvedValue({ status: 'ready', nodes: [NODES[0]], cursor: null } as never)
    renderTab()
    await waitFor(() => expect(api.memoryGraphNodes).toHaveBeenCalledTimes(1), LAZY_INIT)
    fireEvent.click(screen.getByRole('radio', { name: /Facts/ }))
    await act(async () => { answer({ status: 'ready', nodes: NODES, cursor: null }) })
    await waitFor(() => expect(vi.mocked(api.memoryGraphNodes).mock.calls.at(-1)?.[2]).toMatchObject({ kinds: ['fact'] }), LAZY_INIT)
    await drawn(1)
  })

  it('drops a box count that comes back after the filter changed', async () => {
    let answer: (v: unknown) => void = () => {}
    vi.mocked(api.memoryGraphSelect).mockReturnValueOnce(new Promise(r => { answer = r }) as never)
    renderTab()
    await drawn()
    const canvas = screen.getByTestId('memory-graph-canvas')
    pointer('pointerdown', canvas, { button: 0, clientX: 10, clientY: 10 })
    pointer('pointermove', window, { clientX: 200, clientY: 150 })
    pointer('pointerup', window, { clientX: 200, clientY: 150 })
    await waitFor(() => expect(api.memoryGraphSelect).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('radio', { name: /Facts/ }))
    await act(async () => { answer({ status: 'ready', count: 99 }) })
    expect(screen.queryByText(/99/)).toBeNull()
  })

  it('shows a failed box count as a blocking error', async () => {
    vi.mocked(api.memoryGraphSelect).mockRejectedValueOnce(new Error('select down'))
    renderTab()
    await drawn()
    const canvas = screen.getByTestId('memory-graph-canvas')
    pointer('pointerdown', canvas, { button: 0, clientX: 10, clientY: 10 })
    pointer('pointermove', window, { clientX: 200, clientY: 150 })
    pointer('pointerup', window, { clientX: 200, clientY: 150 })
    const notice = await screen.findByTestId('memory-graph-read-error')
    expect(notice.getAttribute('role') ?? notice.querySelector('[role]')?.getAttribute('role')).toBe('alert')
  })

  it('keys each kind pill with the colour its nodes are drawn in', async () => {
    renderTab()
    await drawn()
    for (const [tab, cssVar] of [['fact', '--info'], ['directive', '--accent'], ['episode', '--ok']]) {
      expect(screen.getByTestId(`kind-swatch-${tab}`).style.background).toBe(`var(${cssVar})`)
    }
  })

  it('says so when the WebGL device fails after the canvas starts', async () => {
    cosmos.deviceFails = true
    renderTab()
    expect(await screen.findByTestId('memory-graph-canvas-error', {}, LAZY_INIT)).toBeTruthy()
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('pans and zooms over the clusters a Refresh brought, not the first ones', async () => {
    renderTab()
    await drawn()
    const bigger = { ...overview(250000), clusters: [{ id: 0, x: 10, y: 5, r: 60, count: 250000, label: 'topic' }] }
    vi.mocked(api.memoryGraphOverview).mockResolvedValue(bigger as never)
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() => expect([...graph().positions]).toEqual([10, 5]), LAZY_INIT)
    const canvas = screen.getByTestId('memory-graph-canvas')
    const before = graph().transforms
    act(() => { canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -20, ctrlKey: true, clientX: 50, clientY: 50 })) })
    // The frame that applies the zoom also decides clusters or nodes, from the clusters it knows.
    await waitFor(() => expect(graph().transforms).toBeGreaterThan(before))
    expect([...graph().positions]).toEqual([10, 5])
  })

  it('keeps the drawn graph when a Refresh fails, and Retry brings it back', async () => {
    renderTab()
    const g = await drawn()
    vi.mocked(api.memoryGraphOverview).mockRejectedValueOnce(new Error('overview down'))
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    const notice = await screen.findByTestId('memory-graph-load-error', {}, { timeout: 3000 })
    expect(screen.getByTestId('memory-graph-canvas')).toBeTruthy()
    fireEvent.click(within(notice).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(screen.queryByTestId('memory-graph-load-error')).toBeNull(), { timeout: 3000 })
    // The same renderer still draws, attached to the canvas on the page.
    expect(cosmos.instances.at(-1)).toBe(g)
    expect(screen.getByTestId('memory-graph-canvas').isConnected).toBe(true)
  })
})
