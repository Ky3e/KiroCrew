/**
 * The nodes the canvas has fetched, by tile. The view is cut into a grid of
 * square tiles at its zoom step; each tile is fetched once (one box page,
 * heaviest first) and kept until the cache passes its cap, oldest first.
 */
import type { GraphBbox, GraphNodeRow } from '../../../api/client/memory'

/** Most nodes kept on the client before the oldest tiles are dropped. */
export const CACHE_CAP = 50000

/** The grid step for a view `span` layout units wide: a power of two near it. */
export const tileStep = (span: number) => 2 ** Math.ceil(Math.log2(Math.max(span, 1e-6)))

/** Keys and boxes of the tiles that cover `box` at grid step `step`. */
export function tilesFor(box: GraphBbox, step: number): { key: string; box: GraphBbox }[] {
  const out: { key: string; box: GraphBbox }[] = []
  const x0 = Math.floor(box[0] / step), y0 = Math.floor(box[1] / step)
  const x1 = Math.floor(box[2] / step), y1 = Math.floor(box[3] / step)
  for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) {
    out.push({ key: `${step}:${i}:${j}`, box: [i * step, j * step, (i + 1) * step, (j + 1) * step] })
  }
  return out
}

export class NodeCache {
  private tiles = new Map<string, string[]>()
  private nodes = new Map<string, GraphNodeRow>()
  private refs = new Map<string, number>()
  /** Bumped on every change, so a render can tell a new node set from the last. */
  version = 0

  has(key: string) { return this.tiles.has(key) }

  add(key: string, rows: GraphNodeRow[]) {
    if (this.tiles.has(key)) return
    this.tiles.set(key, rows.map(r => r.id))
    for (const r of rows) {
      this.nodes.set(r.id, r)
      this.refs.set(r.id, (this.refs.get(r.id) || 0) + 1)
    }
    while (this.nodes.size > CACHE_CAP && this.tiles.size > 1) {
      const [oldest, ids] = this.tiles.entries().next().value as [string, string[]]
      this.tiles.delete(oldest)
      for (const id of ids) {
        const left = (this.refs.get(id) || 1) - 1
        if (left <= 0) { this.refs.delete(id); this.nodes.delete(id) } else this.refs.set(id, left)
      }
    }
    this.version++
  }

  all(): GraphNodeRow[] { return [...this.nodes.values()] }
  get(id: string) { return this.nodes.get(id) }
  get size() { return this.nodes.size }
  clear() { this.tiles.clear(); this.nodes.clear(); this.refs.clear(); this.version++ }
}
