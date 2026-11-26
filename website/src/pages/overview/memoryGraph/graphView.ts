/**
 * The memory graph's view, in the layout's own units (the server's x and y).
 *
 * The camera is a centre and a scale: `k` screen pixels per layout unit. Every
 * conversion, the level of detail and the label placement are pure functions of
 * it, so the canvas (cosmos.gl) only draws what these decide.
 */
import type { GraphBbox, GraphCluster } from '../../../api/client/memory'

export type Point = { x: number; y: number }
export type View = { cx: number; cy: number; k: number }
export type Size = { width: number; height: number }

export const MIN_K = 1e-4
export const MAX_K = 400
/** Most nodes the canvas asks for in one view; past it the view shows clusters. */
export const NODE_BUDGET = 20000
/** Extra margin fetched around the view, as a share of its size, so a short pan needs no request. */
export const FETCH_MARGIN = 0.5

const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k))

/** Screen position (y down) of a layout point. */
export const toScreen = (view: View, size: Size, p: Point): Point => ({
  x: size.width / 2 + (p.x - view.cx) * view.k,
  y: size.height / 2 - (p.y - view.cy) * view.k,
})

/** Layout point under a screen position. */
export const toLayout = (view: View, size: Size, s: Point): Point => ({
  x: view.cx + (s.x - size.width / 2) / view.k,
  y: view.cy - (s.y - size.height / 2) / view.k,
})

/** The layout box the screen shows, grown by `margin` of its size on each side. */
export function visibleBox(view: View, size: Size, margin = 0): GraphBbox {
  const w = size.width / view.k, h = size.height / view.k
  return [view.cx - w * (0.5 + margin), view.cy - h * (0.5 + margin), view.cx + w * (0.5 + margin), view.cy + h * (0.5 + margin)]
}

/** The layout box of a screen rectangle (a box selection). */
export function screenRectToBox(view: View, size: Size, r: { x: number; y: number; width: number; height: number }): GraphBbox {
  const a = toLayout(view, size, { x: r.x, y: r.y }), b = toLayout(view, size, { x: r.x + r.width, y: r.y + r.height })
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)]
}

/** The view that shows `box` with `pad` screen pixels to spare. */
export function fitBox(box: GraphBbox, size: Size, pad = 32): View {
  const w = Math.max(box[2] - box[0], 1e-6), h = Math.max(box[3] - box[1], 1e-6)
  const k = clampK(Math.min((size.width - 2 * pad) / w, (size.height - 2 * pad) / h))
  return { cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2, k }
}

/** Slide the view by a screen delta. */
export const panBy = (view: View, d: Point): View => ({ ...view, cx: view.cx + d.x / view.k, cy: view.cy - d.y / view.k })

/** Zoom by `factor` (above 1 zooms out) keeping the layout point under `at` still. */
export function zoomAt(view: View, size: Size, at: Point, factor: number): View {
  const k = clampK(view.k / factor)
  const fixed = toLayout(view, size, at)
  return { k, cx: fixed.x - (at.x - size.width / 2) / k, cy: fixed.y + (at.y - size.height / 2) / k }
}

/** The share of cluster `c`'s square (centre, half-width `r`) that lies inside `a`. */
function shareInside(a: GraphBbox, c: GraphCluster): number {
  const w = Math.min(a[2], c.x + c.r) - Math.max(a[0], c.x - c.r)
  const h = Math.min(a[3], c.y + c.r) - Math.max(a[1], c.y - c.r)
  if (w < 0 || h < 0) return 0
  return c.r > 0 ? Math.min(1, (w * h) / (4 * c.r * c.r)) : 1
}

/**
 * Whether the view shows nodes or clusters: nodes once the view holds about
 * `NODE_BUDGET` rows or fewer, counting each cluster by the share of it in view.
 * A small store shows every node at once; a large one, or one large cluster,
 * opens into nodes as you zoom in.
 */
export function showsNodes(view: View, size: Size, clusters: GraphCluster[]): boolean {
  const box = visibleBox(view, size)
  let rows = 0
  for (const c of clusters) { rows += c.count * shareInside(box, c); if (rows > NODE_BUDGET) return false }
  return true
}

/** True when `inner` lies wholly inside `outer`. */
export const contains = (outer: GraphBbox, inner: GraphBbox) => inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]

export type LabelCandidate = { id: string; at: Point; text: string; rank: number }
export type PlacedLabel = LabelCandidate & { box: { x: number; y: number; width: number; height: number } }

/**
 * Up to `max` labels, highest `rank` first, none overlapping another and none
 * off screen. `widthOf` measures a label in pixels; the height is one line.
 */
export function placeLabels(cands: LabelCandidate[], size: Size, max: number, widthOf: (text: string) => number, lineHeight = 18): PlacedLabel[] {
  const out: PlacedLabel[] = []
  const sorted = [...cands].sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : 1))
  for (const c of sorted) {
    if (out.length >= max) break
    const width = widthOf(c.text)
    const box = { x: c.at.x - width / 2, y: c.at.y - lineHeight - 6, width, height: lineHeight }
    if (box.x < 0 || box.y < 0 || box.x + width > size.width || box.y + lineHeight > size.height) continue
    if (out.some(o => box.x < o.box.x + o.box.width && o.box.x < box.x + width && box.y < o.box.y + o.box.height && o.box.y < box.y + lineHeight)) continue
    out.push({ ...c, box })
  }
  return out
}

export type Dir = 'left' | 'right' | 'up' | 'down'

/**
 * The point to move keyboard focus to from `from` in direction `dir`: the
 * nearest one in that half-plane, favouring points straight ahead. Null when
 * nothing lies that way.
 */
export function nextInDirection(points: { id: string; at: Point }[], from: Point, dir: Dir): string | null {
  let best: string | null = null, bestScore = Infinity
  for (const p of points) {
    const dx = p.at.x - from.x, dy = p.at.y - from.y
    const ahead = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy
    const side = dir === 'right' || dir === 'left' ? Math.abs(dy) : Math.abs(dx)
    if (ahead <= 0.5) continue
    const score = ahead + 2 * side
    if (score < bestScore) { bestScore = score; best = p.id }
  }
  return best
}
