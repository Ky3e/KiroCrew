import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Network as NetworkIcon, RefreshCw } from 'lucide-react'
import type { Graph as CosmosGraph } from '@cosmos.gl/graph'
import { api } from '../../api/client'
import type { GraphCluster, GraphKind, GraphNodeRow } from '../../api/client/memory'
import { Card, CardTitle, Btn } from '../../components/ui'
import ErrorNotice from '../../components/ErrorNotice'
import { errMessage } from '../../utils/thunkError'
import { queryReadFailed } from '../../utils/queryReadFailed'
import { i18nT } from '../../i18n/t'
import { fmtNumber } from '../../i18n/format'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { useJumpToMemories } from './memoryPage/memoryJump'
import { KindPills } from './memoryPage/KindPills'
import type { KindTab } from './memoryPage/memoryListView'
import { attachGraphGestures, type Box } from './memoryGraphGestures'
import {
  FETCH_MARGIN, NODE_BUDGET, fitBox, nextInDirection, panBy, placeLabels, screenRectToBox, showsNodes,
  toScreen, visibleBox, zoomAt, type Dir, type LabelCandidate, type PlacedLabel, type Size, type View,
} from './memoryGraph/graphView'
import { NodeCache, tileStep, tilesFor } from './memoryGraph/nodeCache'
import { KIND_VAR, readGraphColors, type GraphColors } from './memoryGraph/graphColors'

// Bundle shape, not runtime: cosmos.gl's d3 modules sit in the `vendor-d3`
// chunk, which stays a lazy chunk of its own only while a page reaches it
// through `import('d3')`, as this tab did before cosmos.gl. Without this edge
// the bundler folds that chunk into the shared ones and re-cuts unrelated
// chunks: the first load grew 52.6 KB and Excalidraw's font chunk merged into
// `prod` (check-bundle-size.mjs on an analyze build, 2026-11-26).
export const loadD3 = () => import('d3')

/** Smallest canvas height; otherwise it fills the window below its toolbar. */
const MIN_CANVAS = 420
/** The dashboard's standard motion: a cluster opening into its nodes, a camera move. */
const MOTION_MS = 250
/** Labels drawn at once, so the view never turns into a wall of text. */
const MAX_LABELS = 14
/** Label text size: the overlay's `text-[12px]`. */
const LABEL_PX = 12
/** Past this many nodes on screen, labels name clusters rather than memories. */
const DENSE_LABELS = 300
/** A faded experience never drops below this opacity, so it stays findable. */
const MIN_ALPHA = 0.28
const DIMMED_ALPHA = 0.08
/** Requests wait this long after the view stops moving. */
const SETTLE_MS = 120
/** cosmos.gl's default `spaceSize`; its transform is centred on half of it. */
const COSMOS_SPACE = 4096

const TAB_KIND: Record<Exclude<KindTab, 'all'>, GraphKind> = { fact: 'fact', directive: 'lesson', episode: 'episode' }
/** Each kind pill's dot: the colour its nodes are drawn in, so the pills are the key. */
const KIND_SWATCHES = Object.fromEntries(Object.entries(TAB_KIND).map(([tab, k]) => [tab, `var(${KIND_VAR[k]})`])) as Partial<Record<KindTab, string>>

type Shown =
  | { mode: 'clusters'; items: GraphCluster[] }
  | { mode: 'nodes'; items: GraphNodeRow[] }

/** The graph of one store: `store` names a bot's memory; empty is Global memory. */
export default function MemoryGraphTab({ store = '' }: { store?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const cosmosRef = useRef<CosmosGraph | null>(null)
  const originRef = useRef<{ ox: number; oy: number } | null>(null)
  const viewRef = useRef<View>({ cx: 0, cy: 0, k: 1 })
  const sizeRef = useRef<Size>({ width: 800, height: MIN_CANVAS })
  const shownRef = useRef<Shown>({ mode: 'clusters', items: [] })
  const cacheRef = useRef(new NodeCache())
  const colorsRef = useRef<GraphColors | null>(null)
  const hoveredRef = useRef<number | null>(null)
  const reduced = useReducedMotion()
  const reducedRef = useRef(reduced)
  reducedRef.current = reduced
  const jump = useJumpToMemories()
  const jumpRef = useRef(jump)
  jumpRef.current = jump

  const [height, setHeight] = useState(MIN_CANVAS)
  const [kind, setKind] = useState<KindTab>('all')
  const kinds = useMemo(() => (kind === 'all' ? undefined : [TAB_KIND[kind]]), [kind])
  const kindsRef = useRef(kinds)
  kindsRef.current = kinds
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [matches, setMatches] = useState<Set<string> | null>(null)
  const matchesRef = useRef(matches)
  matchesRef.current = matches
  const [box, setBox] = useState<Box | null>(null)
  const [picked, setPicked] = useState<{ bbox: string; count: number; kinds?: string[] } | null>(null)
  /** Bumped when a box count in flight no longer matches what is on screen. */
  const selectGen = useRef(0)
  const [labels, setLabels] = useState<PlacedLabel[]>([])
  const [hover, setHover] = useState<{ text: string; x: number; y: number } | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const focusRef = useRef(focusId)
  focusRef.current = focusId
  const [tick, setTick] = useState(0)
  /** A node, search or box read that failed, with the step that tries it again. */
  const [liveError, setLiveError] = useState<{ error: unknown; retry: () => void } | null>(null)
  /** The canvas could not load or start (no WebGL, a failed chunk). */
  const [canvasError, setCanvasError] = useState<unknown>(null)
  /** Bumped by Refresh, so the search runs again too. */
  const [reloads, setReloads] = useState(0)

  const overviewRead = useQuery({
    queryKey: ['memory-graph-overview', store],
    queryFn: () => api.memoryGraphOverview(store),
    // The first open of a store starts its layout build: check again until it is in.
    refetchInterval: q => (q.state.data?.status === 'building' ? 1000 : false),
  })
  const { data: overview, isError, error, isFetching, refetch } = overviewRead
  const clusters = useMemo(() => overview?.clusters ?? [], [overview])
  const totals = overview?.totals ?? {}
  const total = (totals.episode || 0) + (totals.fact || 0) + (totals.lesson || 0)
  const ready = overview?.status === 'ready' && total > 0

  // ---- drawing -------------------------------------------------------------

  /** Push the view to cosmos.gl: its transform puts layout point (cx, cy) mid-screen. */
  const applyView = useCallback(() => {
    const g = cosmosRef.current, o = originRef.current
    if (!g || !o) return
    const { cx, cy, k } = viewRef.current, { width: w, height: h } = sizeRef.current
    g.setViewTransform({ k, x: w / 2 - k * cx + k * o.ox - (k * w) / 2, y: h / 2 + k * cy - k * o.oy - (k * h) / 2 })
  }, [])

  const measureRef = useRef<{ ctx: CanvasRenderingContext2D | null; widths: Map<string, number> } | null>(null)
  const placeOverlay = useCallback(() => {
    const shown = shownRef.current, view = viewRef.current, size = sizeRef.current
    if (!measureRef.current) {
      const ctx = document.createElement('canvas').getContext('2d')
      // Measured in the labels' own font, read from the page like scrollPeek does.
      const cs = canvasRef.current ? getComputedStyle(canvasRef.current) : null
      if (ctx && cs) ctx.font = `${cs.fontWeight} ${LABEL_PX}px ${cs.fontFamily}`
      measureRef.current = { ctx, widths: new Map() }
    }
    const { ctx, widths } = measureRef.current
    const widthOf = (t: string) => {
      let w = widths.get(t)
      if (w === undefined) { w = (ctx ? ctx.measureText(t).width : t.length * 7) + 12; widths.set(t, w) }
      return w
    }
    const onScreen = (c: LabelCandidate) => c.at.x >= 0 && c.at.y >= 0 && c.at.x <= size.width && c.at.y <= size.height
    const topics = () => clusters.filter(c => c.label && c.count > 0).map(c => ({ id: `c${c.id}`, at: toScreen(view, size, c), text: `${c.label} · ${fmtNumber(c.count)}`, rank: c.count }))
    let cands: LabelCandidate[]
    if (shown.mode === 'clusters') cands = topics()
    else {
      const nodes = shown.items.map(n => ({ id: n.id, at: toScreen(view, size, n), text: n.label.slice(0, 48), rank: n.weight + (matchesRef.current?.has(n.id) ? 10 : 0) })).filter(onScreen)
      // A dense view names its topics; single memories get names once few are on screen.
      cands = nodes.length > DENSE_LABELS ? topics() : nodes
    }
    setLabels(placeLabels(cands, size, MAX_LABELS, widthOf))
  }, [clusters])

  /** Colours and sizes of what is shown, for the current search and focus. */
  const paint = useCallback(() => {
    const g = cosmosRef.current, colors = colorsRef.current
    if (!g || !colors) return
    const shown = shownRef.current, m = matchesRef.current, n = shown.items.length
    const rgba = new Float32Array(n * 4), sizes = new Float32Array(n)
    shown.items.forEach((item, i) => {
      let rgb: [number, number, number], alpha: number, size: number
      if (shown.mode === 'clusters') {
        const c = item as GraphCluster
        // A cluster holds every kind, so it takes the neutral colour.
        rgb = colors.cluster; alpha = 0.55
        // A disc as wide on screen as the cluster, never so small it hides.
        size = Math.max(8, Math.min(160, 2 * c.r * viewRef.current.k))
      } else {
        const node = item as GraphNodeRow
        rgb = colors.kind[node.kind]
        // An experience fades with recall's weight for it; facts and lessons do not.
        alpha = node.kind === 'episode' ? Math.max(MIN_ALPHA, Math.min(1, node.weight)) : 1
        if (m && !m.has(node.id)) alpha = DIMMED_ALPHA
        size = 4 + 4 * Math.min(1, node.weight)
      }
      rgba.set([rgb[0], rgb[1], rgb[2], alpha], i * 4)
      sizes[i] = size
    })
    g.setPointColors(rgba)
    g.setPointSizes(sizes)
    const focusIndex = shown.mode === 'nodes' && focusRef.current ? shown.items.findIndex(x => (x as GraphNodeRow).id === focusRef.current) : -1
    g.setConfigPartial({ focusedPointIndex: focusIndex >= 0 ? focusIndex : undefined })
  }, [])

  /**
   * Show clusters or nodes for the current view. Entering the node view opens
   * each cluster: its nodes start at the cluster's centre and move to their own
   * places (instant with reduced motion).
   */
  const refreshShown = useCallback(() => {
    const g = cosmosRef.current
    if (!g) return
    const wantNodes = showsNodes(viewRef.current, sizeRef.current, clusters)
    const before = shownRef.current
    let next: Shown
    if (wantNodes) {
      const want = kindsRef.current
      next = { mode: 'nodes', items: cacheRef.current.all().filter(n => !want || want.includes(n.kind)) }
    } else {
      next = { mode: 'clusters', items: clusters.filter(c => c.count > 0) }
    }
    shownRef.current = next
    const pos = new Float32Array(next.items.length * 2)
    next.items.forEach((it, i) => { pos[i * 2] = it.x; pos[i * 2 + 1] = it.y })
    const opening = before.mode === 'clusters' && next.mode === 'nodes' && next.items.length > 0
    if (opening && !reducedRef.current) {
      const at = new Map(clusters.map(c => [c.id, c]))
      const start = new Float32Array(pos.length)
      ;(next.items as GraphNodeRow[]).forEach((nd, i) => {
        const c = at.get(nd.cluster)
        start[i * 2] = c ? c.x : nd.x; start[i * 2 + 1] = c ? c.y : nd.y
      })
      g.setPointPositions(start, true)
      paint()
      g.render(0, 0)
      g.setPointPositions(pos, true)
      g.render(0, MOTION_MS)
    } else {
      g.setPointPositions(pos, true)
      paint()
      g.render(0, reducedRef.current || before.mode !== next.mode ? 0 : MOTION_MS)
    }
    placeOverlay()
  }, [clusters, paint, placeOverlay])

  // ---- fetching nodes for the view -------------------------------------------

  const fetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchGen = useRef(0)
  const fetchVisible = useCallback(() => {
    if (fetchTimer.current) clearTimeout(fetchTimer.current)
    fetchTimer.current = setTimeout(async () => {
      if (!showsNodes(viewRef.current, sizeRef.current, clusters)) return
      const gen = ++fetchGen.current
      // One filter per pass: a response is stored under the filter it was asked for.
      const askKinds = kindsRef.current, kindKey = askKinds?.join(',') || 'all'
      const want = visibleBox(viewRef.current, sizeRef.current, FETCH_MARGIN)
      // Tiles as large as the fetched box: four to nine requests cover a view.
      const step = tileStep(Math.max(want[2] - want[0], want[3] - want[1]))
      const missing = tilesFor(want, step).filter(t => !cacheRef.current.has(`${kindKey}|${t.key}`))
      for (const tile of missing) {
        const rows: GraphNodeRow[] = []
        let cursor: string | null = null
        try {
          // Every page of the tile, up to the view's node budget: past it the
          // server's order (heaviest first) decides which memories this zoom shows.
          do {
            const page = await api.memoryGraphNodes(store, tile.box, { kinds: askKinds, cursor })
            if (gen !== fetchGen.current) return // a newer view took over
            rows.push(...page.nodes)
            cursor = page.cursor
          } while (cursor && rows.length < NODE_BUDGET)
        } catch (error) {
          if (gen === fetchGen.current) setLiveError({ error, retry: fetchVisible })
          return
        }
        if (gen !== fetchGen.current) return
        cacheRef.current.add(`${kindKey}|${tile.key}`, rows)
      }
      if (missing.length) refreshShown()
    }, SETTLE_MS)
  }, [clusters, refreshShown, store])

  /**
   * Every view change, at most once a frame: move the camera, swap clusters and
   * nodes when the level changes, fetch what came into view. Labels hide while
   * the view moves and come back once it stops, so panning costs one transform.
   */
  const frameRef = useRef<number | null>(null)
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverShownRef = useRef(false)
  const viewChanged = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      applyView()
      const nodesNow = showsNodes(viewRef.current, sizeRef.current, clusters)
      if ((shownRef.current.mode === 'nodes') !== nodesNow) refreshShown()
      else if (shownRef.current.mode === 'clusters') paint()
      if (hoverShownRef.current) { hoverShownRef.current = false; setHover(null) }
      setLabels(old => (old.length ? [] : old))
      if (settleRef.current) clearTimeout(settleRef.current)
      settleRef.current = setTimeout(placeOverlay, SETTLE_MS)
      fetchVisible()
    })
  }, [applyView, clusters, fetchVisible, paint, placeOverlay, refreshShown])

  /** Move the camera to `to`: animated, or at once with reduced motion. */
  const animRef = useRef<number | null>(null)
  const flyTo = useCallback((to: View) => {
    if (animRef.current !== null) cancelAnimationFrame(animRef.current)
    if (reducedRef.current) { viewRef.current = to; viewChanged(); return }
    const from = { ...viewRef.current }, t0 = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / MOTION_MS), e = 1 - (1 - t) ** 3
      viewRef.current = { cx: from.cx + (to.cx - from.cx) * e, cy: from.cy + (to.cy - from.cy) * e, k: from.k * (to.k / from.k) ** e }
      applyView()
      if (t < 1) animRef.current = requestAnimationFrame(step)
      else { animRef.current = null; viewChanged() }
    }
    animRef.current = requestAnimationFrame(step)
  }, [applyView, viewChanged])

  /** This render's callbacks, for the handlers the canvas binds once: a newer
   *  overview (Refresh, a store write) gives them new clusters. */
  const live = useRef({ viewChanged, flyTo, paint })
  live.current = { viewChanged, flyTo, paint }

  // ---- the canvas ---------------------------------------------------------

  useEffect(() => {
    const el = canvasRef.current
    if (!ready || !el) return
    let disposed = false
    let teardown: (() => void) | undefined
    // The counter itself, not its value: cleanup bumps it so a fetch in flight stops.
    const generation = fetchGen
    // cosmos.gl (WebGL) loads with the canvas, as its own chunk.
    void import('@cosmos.gl/graph').then(({ Graph }) => {
    if (disposed) return
    // The real size before the first view: the transform is computed from it.
    const rect = el.getBoundingClientRect()
    if (rect.width > 0) sizeRef.current = { width: rect.width, height: rect.height }
    colorsRef.current = readGraphColors()
    let g: CosmosGraph
    try {
    g = new Graph(el, {
      enableSimulation: false,
      enableZoom: false,
      enableDrag: false,
      rescalePositions: false,
      fitViewOnInit: false,
      scalePointsOnZoom: false,
      renderLinks: false,
      backgroundColor: colorsRef.current.background,
      focusedPointRingColor: colorsRef.current.ring,
      hoveredPointRingColor: colorsRef.current.ring,
      renderHoveredPointRing: true,
      pixelRatio: window.devicePixelRatio || 1,
      transitionDuration: MOTION_MS,
      attribution: '',
      onPointMouseOver: (index) => {
        hoveredRef.current = index
        const item = shownRef.current.items[index]
        if (!item) return
        const at = toScreen(viewRef.current, sizeRef.current, item)
        const text = shownRef.current.mode === 'nodes' ? (item as GraphNodeRow).label : (item as GraphCluster).label ?? fmtNumber((item as GraphCluster).count)
        hoverShownRef.current = true
        setHover({ text, x: at.x, y: at.y })
      },
      onPointMouseOut: () => { hoveredRef.current = null; hoverShownRef.current = false; setHover(null) },
      onPointClick: (index) => {
        const shown = shownRef.current
        const item = shown.items[index]
        if (!item) return
        if (shown.mode === 'clusters') {
          const c = item as GraphCluster
          live.current.flyTo(fitBox([c.x - c.r, c.y - c.r, c.x + c.r, c.y + c.r], sizeRef.current))
          return
        }
        const node = item as GraphNodeRow
        jumpRef.current?.([node.ref], node.record)
      },
    })
    } catch (err) {
      // No WebGL here (an old browser, a locked-down VM): say so; search and filters stay usable.
      // eslint-disable-next-line no-console -- intentional init-failure diagnostic
      console.warn('MemoryGraph: the canvas could not start', err)
      setCanvasError(err)
      return
    }
    cosmosRef.current = g
    // The WebGL device starts after the constructor returns, so a browser without
    // WebGL fails here rather than in the try above.
    g.ready.catch(err => { if (!disposed) setCanvasError(err) })
    // cosmos.gl's world origin: the centre of its `spaceSize` square (default 4096).
    originRef.current = { ox: COSMOS_SPACE / 2, oy: COSMOS_SPACE / 2 }
    if (overview?.bounds) viewRef.current = fitBox(overview.bounds, sizeRef.current)
    refreshShown()
    applyView()
    fetchVisible()

    const detach = attachGraphGestures(el, {
      panBy: d => { viewRef.current = panBy(viewRef.current, d); live.current.viewChanged() },
      zoomAt: (at, f) => { viewRef.current = zoomAt(viewRef.current, sizeRef.current, at, f); live.current.viewChanged() },
    }, {
      overNode: () => hoveredRef.current !== null,
      onBox: setBox,
      onClear: () => { selectGen.current++; setPicked(null); setBox(null) },
      onSelect: area => {
        const b = screenRectToBox(viewRef.current, sizeRef.current, area)
        const bbox = b.join(',')
        const select = () => {
          const gen = ++selectGen.current, askKinds = kindsRef.current
          void api.memoryGraphSelect(store, b, askKinds).then(r => { if (gen === selectGen.current) setPicked(r.count ? { bbox, count: r.count, kinds: askKinds } : null) })
            .catch(error => { if (gen !== selectGen.current) return; setPicked(null); setLiveError({ error, retry: select }) })
        }
        select()
      },
    })
    // Recolour live when the user switches light/dark (`<html data-theme>`).
    const themeObserver = new MutationObserver(() => {
      colorsRef.current = readGraphColors()
      g.setConfigPartial({ backgroundColor: colorsRef.current.background, focusedPointRingColor: colorsRef.current.ring, hoveredPointRingColor: colorsRef.current.ring })
      live.current.paint(); g.render(0, 0)
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    teardown = () => {
      detach(); themeObserver.disconnect()
      g.destroy(); cosmosRef.current = null
    }
    }).catch(err => { if (!disposed) setCanvasError(err) })
    return () => {
      disposed = true
      teardown?.()
      if (animRef.current !== null) cancelAnimationFrame(animRef.current)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      if (settleRef.current) clearTimeout(settleRef.current)
      if (fetchTimer.current) clearTimeout(fetchTimer.current)
      generation.current++ // a fetch still in flight stops at its next page
    }
    // The canvas is built once per store and layout; every other change goes through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, store, overview?.bounds?.join(',')])

  // A new kind filter fetches its own nodes; the cache is kept per kind set.
  useEffect(() => {
    // Answers still in flight were asked for the old filter.
    fetchGen.current++; selectGen.current++
    if (cosmosRef.current) { refreshShown(); fetchVisible() }
  }, [kinds, refreshShown, fetchVisible])

  // The canvas fills the window below it, follows its box, and keeps the view centred.
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let page: HTMLElement | null = el.parentElement
    while (page && !/(auto|scroll)/.test(getComputedStyle(page).overflowY)) page = page.parentElement
    const fit = () => {
      const bottom = page ? page.getBoundingClientRect().bottom : window.innerHeight
      setHeight(Math.max(MIN_CANVAS, Math.floor(bottom - el.getBoundingClientRect().top - 32)))
    }
    fit()
    window.addEventListener('resize', fit)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const r = canvasRef.current?.getBoundingClientRect()
      if (r && r.width > 0) sizeRef.current = { width: r.width, height: r.height }
      setTick(t => t + 1)
    })
    if (canvasRef.current) observer?.observe(canvasRef.current)
    return () => { window.removeEventListener('resize', fit); observer?.disconnect() }
  }, [ready])
  useEffect(() => { if (cosmosRef.current) viewChanged() }, [tick, viewChanged])

  // ---- search over every node, on the server -----------------------------------

  useEffect(() => { const t = setTimeout(() => setSearch(searchInput.trim()), 300); return () => clearTimeout(t) }, [searchInput])
  useEffect(() => {
    if (!ready) return
    if (!search) { setMatches(null); return }
    let live = true
    void api.memoryGraphSearch(store, search, { kinds }).then(r => {
      if (!live) return
      setMatches(new Set(r.matches.map(m => m.id)))
      if (r.matches.length) {
        const xs = r.matches.map(m => m.x), ys = r.matches.map(m => m.y)
        flyTo(fitBox([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], sizeRef.current, 64))
      }
    }).catch(error => { if (live) { setMatches(null); setLiveError({ error, retry: () => setReloads(n => n + 1) }) } })
    return () => { live = false }
  }, [search, kinds, ready, store, flyTo, reloads])
  useEffect(() => { matchesRef.current = matches; if (cosmosRef.current) { paint(); cosmosRef.current.render(0, 0); placeOverlay() } }, [matches, paint, placeOverlay])

  // ---- keyboard: arrows move between the nodes on screen, Enter opens one ----------

  const onKey = (e: React.KeyboardEvent) => {
    const dirs: Record<string, Dir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
    const shown = shownRef.current, view = viewRef.current, size = sizeRef.current
    const items = shown.mode === 'nodes' ? (shown.items as GraphNodeRow[]).map(n => ({ id: n.id, at: toScreen(view, size, n) }))
      : (shown.items as GraphCluster[]).map(c => ({ id: `c${c.id}`, at: toScreen(view, size, c) }))
    const onScreen = items.filter(p => p.at.x >= 0 && p.at.y >= 0 && p.at.x <= size.width && p.at.y <= size.height)
    if (e.key in dirs) {
      e.preventDefault()
      const from = onScreen.find(p => p.id === focusId)?.at ?? { x: size.width / 2, y: size.height / 2 }
      const next = focusId && onScreen.some(p => p.id === focusId) ? nextInDirection(onScreen, from, dirs[e.key]) : onScreen.sort((a, b) => Math.hypot(a.at.x - from.x, a.at.y - from.y) - Math.hypot(b.at.x - from.x, b.at.y - from.y))[0]?.id ?? null
      if (next) setFocusId(next)
    } else if (e.key === 'Enter' && focusId) {
      e.preventDefault()
      if (shown.mode === 'clusters') {
        const c = (shown.items as GraphCluster[]).find(x => `c${x.id}` === focusId)
        if (c) { setFocusId(null); flyTo(fitBox([c.x - c.r, c.y - c.r, c.x + c.r, c.y + c.r], size)) }
      } else {
        const node = (shown.items as GraphNodeRow[]).find(x => x.id === focusId)
        if (node) jumpRef.current?.([node.ref], node.record)
      }
    } else if (e.key === 'Escape') { setFocusId(null); setPicked(null) }
  }
  useEffect(() => { focusRef.current = focusId; if (cosmosRef.current) { paint(); cosmosRef.current.render(0, 0) } }, [focusId, paint])
  const focusedText = useMemo(() => {
    if (!focusId) return ''
    const shown = shownRef.current
    if (shown.mode === 'nodes') return (shown.items as GraphNodeRow[]).find(n => n.id === focusId)?.label ?? ''
    const c = (shown.items as GraphCluster[]).find(x => `c${x.id}` === focusId)
    return c ? `${c.label ?? ''} ${fmtNumber(c.count)}`.trim() : ''
    // `tick` re-reads after the shown set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, tick, labels])

  // ---- render ------------------------------------------------------------------

  /** Read everything again: the overview, the nodes in view and the search. */
  const reload = () => {
    setLiveError(null)
    fetchGen.current++; selectGen.current++; setPicked(null)
    cacheRef.current.clear()
    if (cosmosRef.current) { refreshShown(); fetchVisible() }
    setReloads(n => n + 1)
    void refetch()
  }
  const failed = queryReadFailed(overviewRead)
  const title = <CardTitle><NetworkIcon className="lucide-inline" /> {i18nT('pages.overview.memoryGraphTab.memory_graph')}
    <Btn onClick={reload} className="ml-2"><RefreshCw className="lucide-inline" /> {i18nT('pages.overview.memoryGraphTab.refresh')}</Btn>
  </CardTitle>
  // A failed Refresh over a graph already drawn keeps the canvas (and its renderer) and says so above it.
  if (failed && !ready) return <Card>{title}<div className="mb-3 flex flex-col items-start gap-2">
    {isError ? <ErrorNotice askAgent testId="memory-graph-load-error" title={i18nT('pages.overview.memoryGraphTab.load_failed')} message={errMessage(error) || i18nT('pages.overview.memoryGraphTab.load_failed_unknown')} messagePlacement="below" className="w-full" />
      : <p role="status" className="text-muted text-sm">{i18nT('pages.overview.memoryGraphTab.loading_graph_data')}</p>}
    <Btn className="aria-disabled:opacity-30 aria-disabled:cursor-default" aria-disabled={isFetching || undefined} onClick={() => { if (!isFetching) void refetch() }}><RefreshCw className="lucide-inline" /> {i18nT('pages.overview.memoryGraphTab.retry')}</Btn>
  </div></Card>
  if (!overview || overview.status === 'building') return <Card>{title}<p role="status" className="text-muted text-sm">{i18nT('pages.overview.memoryGraphTab.loading_graph_data')}</p></Card>
  if (!ready) return <Card>{title}<p className="text-muted text-sm">{i18nT('pages.overview.memoryGraphTab.no_memory_data_to_visualize_add_preferences_proj')}</p></Card>

  const counts = { fact: totals.fact || 0, directive: totals.lesson || 0, episode: totals.episode || 0 }
  return <Card className="mb-0 max-w-none">
    {title}
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <input aria-label={i18nT('pages.overview.memoryGraphTab.search_memory_nodes')}
        className="bg-bg-elevated border border-border rounded-md px-3 py-1.5 text-text text-sm font-body outline-hidden transition-colors focus-ring min-w-[200px] flex-1"
        placeholder={i18nT('pages.overview.memoryGraphTab.search_nodes')} value={searchInput} onChange={e => setSearchInput(e.target.value)} />
      <KindPills wrap kind={kind} counts={counts} swatches={KIND_SWATCHES} onChange={k => { setKind(k); setPicked(null) }} />
    </div>
    {failed && isError && <ErrorNotice askAgent testId="memory-graph-load-error" className="mb-3 w-full" messagePlacement="below"
      title={i18nT('pages.overview.memoryGraphTab.load_failed')} message={errMessage(error) || i18nT('pages.overview.memoryGraphTab.load_failed_unknown')}
      actions={<button type="button" disabled={isFetching} onClick={() => { void refetch() }}><RefreshCw className="lucide-inline" /> {i18nT('pages.overview.memoryGraphTab.retry')}</button>} />}
    {liveError && <ErrorNotice askAgent testId="memory-graph-read-error" className="mb-3 w-full" messagePlacement="below"
      title={i18nT('pages.overview.memoryGraphTab.load_failed')} message={errMessage(liveError.error) || i18nT('pages.overview.memoryGraphTab.load_failed_unknown')}
      actions={<button type="button" onClick={() => { const { retry } = liveError; setLiveError(null); retry() }}><RefreshCw className="lucide-inline" /> {i18nT('pages.overview.memoryGraphTab.retry')}</button>} />}
    <div ref={wrapRef} className="relative">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- role="application" is the graph's own keyboard surface (arrows move between memories, Enter opens one), like CanvasEditor's */}
      <div ref={canvasRef} tabIndex={0} role="application" aria-roledescription={i18nT('pages.overview.memoryGraphTab.memory_graph')}
        aria-label={i18nT('pages.overview.memoryGraphTab.memory_graph')} aria-describedby="memory-graph-keys"
        onKeyDown={onKey} onBlur={() => setFocusId(null)} data-testid="memory-graph-canvas"
        className="w-full overflow-hidden rounded-md border border-border bg-bg-elevated focus-ring" style={{ height }} />
      {canvasError != null && <div className="absolute inset-x-3 top-3">
        <ErrorNotice askAgent testId="memory-graph-canvas-error" messagePlacement="below"
          title={i18nT('pages.overview.memoryGraphTab.canvas_unavailable')} message={errMessage(canvasError) || i18nT('pages.overview.memoryGraphTab.load_failed_unknown')} />
      </div>}
      <p id="memory-graph-keys" className="sr-only">{i18nT('pages.overview.memoryGraphTab.keyboard_hint')}</p>
      <p className="sr-only" aria-live="polite">{focusedText}</p>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        {canvasError == null && labels.map(l => <span key={l.id} className="absolute truncate rounded bg-[color-mix(in_srgb,var(--bg-elevated)_82%,transparent)] px-1.5 text-[12px] leading-[18px] text-text" style={{ left: l.box.x, top: l.box.y, width: l.box.width }}>{l.text}</span>)}
        {hover && <span className="absolute max-w-[320px] -translate-x-1/2 -translate-y-[calc(100%+10px)] truncate rounded-md border border-border bg-card px-2 py-1 text-[12px] text-text shadow-sm" style={{ left: hover.x, top: hover.y }}>{hover.text}</span>}
        {box && <div data-testid="memory-graph-box" className="absolute rounded-sm border border-accent bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />}
      </div>
      {picked && <div role="status" className="absolute left-3 top-3 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] text-text shadow-sm">
        <span className="tabular-nums">{i18nT('memoryPage.graph_selected', { count: picked.count, formatted: fmtNumber(picked.count) })}</span>
        {jump && <Btn primary className="min-h-8 whitespace-nowrap" onClick={() => jump([], undefined, { bbox: picked.bbox, count: picked.count, kinds: picked.kinds })}>{i18nT('memoryPage.show_in_memories')}</Btn>}
      </div>}
    </div>
  </Card>
}
