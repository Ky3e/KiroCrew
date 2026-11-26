import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from './helpers'
import { dayUnderLine, strengthAt } from '../pages/overview/memoryPage/MemoryStrength'

/**
 * A V1 store's experiences carry their strength in recall: a chip on the row, a
 * curve and its rate in the detail panel, a Strength filter and sort, and the
 * store's fade rates in the rail. A store that does not fade shows none of it.
 */
const { api } = vi.hoisted(() => ({ api: {
  memoryRecords: vi.fn(),
  memoryStores: vi.fn(),
  memoryRecordHistory: vi.fn(),
} }))
vi.mock('../api/client', () => ({ api }))
const { default: MemoryList } = await import('../pages/overview/memoryPage/MemoryList')

const FADE_LINE = 0.385
const STORE_DECAY = { fade_line: FADE_LINE, soon_days: 7, rates: [{ tag: null, rate: 0.03 }, { tag: 'keep', rate: 0 }] }
const FADED = {
  kind: 'episode', id: 'ep-old', text: 'Reran shard 8 after a worktree timeout', tags: '[]', importance: 0.5, source: 'consolidation',
  updated_at: '2026-10-01T10:00:00Z', created_at: '2026-10-01T10:00:00Z', revision: 'c'.repeat(64),
  decay: { strength: 0.256, start: 0.85, rate: 0.03, rate_tag: null, days_old: 40, days_to_line: 0, state: 'faded' },
}
const KEPT = {
  ...FADED, id: 'ep-kept', text: 'The release train leaves on Thursdays', tags: '["keep"]', revision: 'd'.repeat(64),
  decay: { strength: 0.85, start: 0.85, rate: 0, rate_tag: 'keep', days_old: 400, days_to_line: null, state: 'strong' },
}
const FACETS = { kind: { episode: 2 }, tag: { keep: 1 }, source: { consolidation: 2 }, strength: { strong: 1, faded: 1 } }

function List(props: Partial<Parameters<typeof MemoryList>[0]>) {
  return <MemoryList store="default" storeName="Global memory" privateMemory={false} selecting={false} onSelectingChange={() => {}} recallOpen={false} onRecallOpenChange={() => {}} {...props} />
}
const lastView = () => api.memoryRecords.mock.calls.filter(call => call[3] === 50).at(-1)!

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  api.memoryRecords.mockResolvedValue({ entries: [FADED, KEPT], total: 2, has_more: false, facets: FACETS, decay: STORE_DECAY })
  api.memoryStores.mockResolvedValue({ stores: [], active: 'default' })
  api.memoryRecordHistory.mockResolvedValue({ entries: [], has_more: false, current_revision: 1 })
})

describe('the fade curve', () => {
  it('extends the server formula and crosses the line on the day recall would', () => {
    expect(strengthAt(0.85, 0.03, 40)).toBeCloseTo(FADED.decay.strength, 4)
    // memory_decay.days_to_line: an importance-0.5 row at 0.03 a day is under on day 27.
    expect(dayUnderLine(0.85, 0.03, FADE_LINE)).toBe(27)
    expect(dayUnderLine(0.85, 0, FADE_LINE)).toBeNull()
  })
})

describe('strength on the memory list', () => {
  it('shows each row’s strength, the rail’s bands and the store’s rates', async () => {
    renderWithProviders(<List />)
    const rows = await screen.findByRole('list', { name: 'Memories' })
    expect(within(rows).getByText('Strength 0.26')).toBeVisible()
    expect(within(rows).getByText('Strength 0.85')).toBeVisible()
    const rail = await screen.findByRole('complementary', { name: 'Filters' })
    const group = within(rail).getByRole('region', { name: 'Strength · experiences' })
    expect(within(group).getAllByRole('checkbox').map(box => box.getAttribute('aria-label'))).toEqual(['Strong', 'Faded'])
    const chart = within(group).getByTestId('store-fade-chart')
    expect(within(chart).getByText('Day 27')).toBeVisible()
    expect(within(chart).getByText('#keep')).toBeVisible()
    expect(within(chart).getByText('Never')).toBeVisible()
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Faded' }))
    await waitFor(() => expect(lastView()[1]).toEqual({ q: '', kind: 'all', filters: { strength: ['faded'] } }))
  })

  it('opens a faded row on its curve and offers to keep it as a lesson', async () => {
    const save = vi.fn()
    renderWithProviders(<List onSaveAsLesson={save} />)
    const rows = await screen.findByRole('list', { name: 'Memories' })
    fireEvent.click(within(rows).getAllByRole('button', { name: 'View details' })[0])
    const detail = await screen.findByTestId('strength-detail')
    expect(within(detail).getByRole('img')).toHaveAccessibleName('Strength 0.26 today, 0.85 when saved.')
    // In the detail slide, which jsdom cannot lay out, so presence and not visibility.
    expect(within(detail).getByText('Fades 3% a day')).toBeInTheDocument()
    expect(within(detail).getByText('New memories rank above it, even on an exact match.')).toBeInTheDocument()
    fireEvent.click(within(detail).getByRole('button', { name: 'Save as lesson' }))
    expect(save).toHaveBeenCalledWith(FADED.text)
  })

  it('says a rate-0 tag keeps a row and offers no lesson for it', async () => {
    renderWithProviders(<List onSaveAsLesson={() => {}} />)
    const rows = await screen.findByRole('list', { name: 'Memories' })
    fireEvent.click(within(rows).getAllByRole('button', { name: 'View details' })[1])
    const detail = await screen.findByTestId('strength-detail')
    expect(within(detail).getByText('0.85')).toBeInTheDocument()
    expect(within(detail).getByText("Doesn't fade, set by #keep")).toBeInTheDocument()
    expect(within(detail).queryByRole('button', { name: 'Save as lesson' })).toBeNull()
  })

  it('offers the Strength sort only on a store that fades', async () => {
    renderWithProviders(<List />)
    await screen.findByText(FADED.text)
    // The sort list waits for the counts read, which says the store fades.
    await waitFor(() => expect(api.memoryRecords.mock.calls.some(call => call[4]?.facets)).toBe(true))
    fireEvent.pointerDown(screen.getByRole('button', { name: /^Sort: Updated/ }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Strength/ }))
    await waitFor(() => expect(lastView()[4]).toEqual({ sort: 'strength', order: 'desc' }))
  })

  it('shows no strength on a store that does not fade', async () => {
    api.memoryRecords.mockResolvedValue({ entries: [{ ...FADED, decay: undefined }], total: 1, has_more: false, facets: { kind: { episode: 1 }, strength: {} } })
    renderWithProviders(<List />)
    const rows = await screen.findByRole('list', { name: 'Memories' })
    expect(within(rows).queryByTestId('strength-chip')).toBeNull()
    expect(screen.queryByTestId('store-fade-chart')).toBeNull()
  })
})
