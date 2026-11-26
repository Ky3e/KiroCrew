/**
 * Theme colours for the memory graph, read from the design-system CSS variables
 * so the canvas follows light and dark mode. Each kind takes the hue its icon has
 * in the Memories list (`MemoryListParts.KIND_TONE`): the base tone here, since
 * the list's `-text` shades are darkened for type and read as black dots.
 */
import type { GraphKind } from '../../../api/client/memory'

export type Rgb = [number, number, number]
export type GraphColors = { kind: Record<GraphKind, Rgb>; cluster: Rgb; background: string; ring: string; label: string }

/** The CSS variable each kind is drawn in; the kind pills' colour key uses it too. */
export const KIND_VAR: Record<GraphKind, string> = { fact: '--info', lesson: '--accent', episode: '--ok' }
const FALLBACK: Record<GraphKind, Rgb> = { fact: [0.23, 0.51, 0.96], lesson: [0.98, 0.45, 0.09], episode: [0.13, 0.77, 0.37] }

/** A CSS colour as 0-1 RGB, resolved by the browser itself (any syntax the theme uses). */
export function cssRgb(value: string, fallback: Rgb): Rgb {
  if (typeof document === 'undefined' || !value) return fallback
  // Painted onto one pixel and read back, so any colour syntax the theme uses
  // (oklch, color-mix, a nested var) comes out as sRGB.
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!ctx) return fallback
  const probe = document.createElement('span')
  probe.style.color = value
  probe.style.display = 'none'
  document.body.appendChild(probe)
  ctx.fillStyle = getComputedStyle(probe).color
  probe.remove()
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  if (a === 0) return fallback
  return [r / 255, g / 255, b / 255]
}

export function readGraphColors(): GraphColors {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string) => cs.getPropertyValue(name).trim()
  const kind = Object.fromEntries(
    (Object.keys(KIND_VAR) as GraphKind[]).map(k => [k, cssRgb(v(KIND_VAR[k]), FALLBACK[k])]),
  ) as Record<GraphKind, Rgb>
  return { kind, cluster: cssRgb(v('--muted'), [0.6, 0.62, 0.66]), background: v('--bg-elevated') || '#1f2430', ring: v('--accent') || '#f97316', label: v('--text') || '#e5e7eb' }
}
