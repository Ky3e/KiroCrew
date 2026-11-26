/**
 * How strong a V1 experience is in recall, and how that fades: a chip on its row,
 * a curve in its detail panel and, in the filter rail, the store's fade rates.
 *
 * Strength is recall's score for the row at an exact match
 * (`memory_decay.record_decay`); the server sends it, and the curve only extends
 * the same formula, `start × e^(−rate × days)`, to the days around it. Under the
 * fade line a new memory that just passes the match bar ranks above the row, even
 * on an exact match. Still pictures: a frame carries the whole meaning, so nothing
 * here moves (living-ui, "freeze one frame").
 */
import { useTranslation } from 'react-i18next'
import { Btn } from '../../../components/ui'
import { fmtDate, fmtNumber } from '../../../i18n/format'
import type { MemoryRecordDecay, MemoryStoreDecay, MemoryStrengthState } from '../../../types/memoryEditing'
import { fmtScore } from './memoryListView'

// A row with no recorded importance starts at 0.7 + 0.3 × 0.5 (`episodic_search.row_importance`).
export const TYPICAL_START = 0.85
const TONE: Record<MemoryStrengthState, string> = { strong: 'text-muted', fading: 'text-warn-text', faded: 'text-danger-text' }
const BAR: Record<MemoryStrengthState, string> = { strong: 'bg-accent', fading: 'bg-warn', faded: 'bg-danger' }

export const strengthAt = (start: number, rate: number, day: number) => start * Math.exp(-rate * Math.max(0, day))
/** The first whole day a row of this start is under the line; null when it never is. */
export function dayUnderLine(start: number, rate: number, line: number): number | null {
  if (start < line) return 0
  if (rate <= 0) return null
  return Math.floor(Math.log(start / line) / rate) + 1
}
// A store accepts any rate from 0 up, so a tiny one puts the crossing past any
// date JavaScript can hold. Past a century it reads as never.
const FAR_DAYS = 36_500
/** Days until the line, or null when it is never, or more than a century, away. */
export const withinReach = (days: number | null) => days === null || days > FAR_DAYS ? null : days
/** A per-day rate as a percent: 0.03 reads "3%". */
const fmtRate = (rate: number) => fmtNumber(rate, { style: 'percent', maximumFractionDigits: 1 })

/** The row chip: a short bar and the number, toned by its band. */
export function StrengthChip({ decay }: { decay: MemoryRecordDecay }) {
  const { t } = useTranslation()
  return <span className={`inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full bg-bg-hover px-2 text-[12px] leading-none ${TONE[decay.state]}`} data-testid="strength-chip">
    <span aria-hidden="true" className="h-1 w-4 overflow-hidden rounded-full bg-border"><span className={`block h-full ${BAR[decay.state]}`} style={{ width: `${Math.round(Math.min(1, decay.strength) * 100)}%` }} /></span>
    <span className="tabular-nums">{t('memoryPage.strength_value', { value: fmtScore(decay.strength) })}</span>
  </span>
}

const W = 320
const H = 88
const PAD = 4

/** One fade curve, from the day it was written: solid to today, dashed after. */
function Curve({ start, rate, span, today, line, lit = true }: { start: number; rate: number; span: number; today?: number; line: number; lit?: boolean }) {
  const x = (day: number) => PAD + (day / span) * (W - 2 * PAD)
  const y = (value: number) => H - PAD - Math.min(1, value) * (H - 2 * PAD)
  const points = (from: number, to: number) => Array.from({ length: 33 }, (_, i) => from + ((to - from) * i) / 32).map(day => `${x(day).toFixed(1)},${y(strengthAt(start, rate, day)).toFixed(1)}`).join(' ')
  const stroke = lit ? 'var(--accent)' : 'var(--muted)'
  return <>
    <line x1={PAD} x2={W - PAD} y1={y(line)} y2={y(line)} stroke="var(--border-strong)" strokeDasharray="3 3" />
    {today === undefined ? <polyline points={points(0, span)} fill="none" stroke={stroke} strokeWidth={lit ? 2 : 1.25} strokeOpacity={lit ? 1 : 0.6} />
      : <>
        <polyline points={points(0, today)} fill="none" stroke={stroke} strokeWidth={2} />
        <polyline points={points(today, span)} fill="none" stroke={stroke} strokeWidth={2} strokeDasharray="4 3" strokeOpacity={0.55} />
        <circle cx={x(today)} cy={y(strengthAt(start, rate, today))} r={4} fill="var(--accent)" stroke="var(--card)" strokeWidth={2} />
      </>}
  </>
}

/** The detail panel's Strength section for one experience. */
export function StrengthDetail({ decay, fadeLine, onSaveAsLesson }: { decay: MemoryRecordDecay; fadeLine: number
  /** Copy the text into a new lesson, which never fades; only where lessons can be written. */
  onSaveAsLesson?: () => void }) {
  const { t } = useTranslation()
  const until = withinReach(decay.days_to_line)
  const crossing = until === null ? null : decay.days_old + until
  // Enough days to show today and, when it comes, the day it crosses the line.
  const span = Math.max(decay.days_old + 7, crossing !== null ? Math.ceil(crossing * 1.2) : decay.days_old + 30, 14)
  const rate = decay.rate > 0
    ? t(decay.rate_tag ? 'memoryPage.strength_rate_tag' : 'memoryPage.strength_rate', { rate: fmtRate(decay.rate), tag: decay.rate_tag })
    : t(decay.rate_tag ? 'memoryPage.strength_never_tag' : 'memoryPage.strength_never', { tag: decay.rate_tag })
  const below = until === 0 ? t('memoryPage.strength_tip_faded')
    : until !== null ? t('memoryPage.strength_below_on', { date: fmtDate(new Date(Date.now() + until * 86_400_000).toISOString()) }) : null
  return <section aria-label={t('memoryPage.strength')} className="space-y-2" data-testid="strength-detail">
    <div className="flex items-baseline justify-between gap-2">
      <h4 className="m-0 text-[13px] font-medium text-muted">{t('memoryPage.strength')}</h4>
      <span className={`text-[15px] font-semibold tabular-nums ${decay.state === 'strong' ? 'text-text' : TONE[decay.state]}`}>{fmtScore(decay.strength)}</span>
    </div>
    <svg role="img" viewBox={`0 0 ${W} ${H}`} className="block h-[88px] w-full" preserveAspectRatio="none"
      aria-label={t('memoryPage.strength_curve_label', { now: fmtScore(decay.strength), start: fmtScore(decay.start) })}>
      <Curve start={decay.start} rate={decay.rate} span={span} today={decay.days_old} line={fadeLine} />
    </svg>
    <p className="m-0 text-[13px] leading-5 text-text">{rate}</p>
    {below && <p className={`m-0 text-[13px] leading-5 ${decay.days_to_line === 0 ? 'text-danger-text' : 'text-muted'}`}>{below}</p>}
    {onSaveAsLesson && decay.rate > 0 && <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="m-0 flex-1 text-[12px] leading-5 text-muted">{t('memoryPage.strength_keep')}</p>
      <Btn className="min-h-11 sm:min-h-8" onClick={onSaveAsLesson}>{t('memoryPage.save_as_lesson')}</Btn>
    </div>}
  </section>
}

/** The rail's picture of the store: each fade rate's curve at importance 0.5,
 *  the line, and the day each crosses it. */
export function StoreFadeChart({ decay }: { decay: MemoryStoreDecay }) {
  const { t } = useTranslation()
  const days = decay.rates.map(rate => withinReach(dayUnderLine(TYPICAL_START, rate.rate, decay.fade_line)))
  const span = Math.max(30, ...days.map(day => (day ?? 0) * 1.2))
  const caption = t('memoryPage.strength_chart_caption', { importance: fmtNumber(0.5) })
  return <div className="space-y-1.5 pb-1" data-testid="store-fade-chart">
    <svg role="img" viewBox={`0 0 ${W} ${H}`} className="block h-16 w-full" preserveAspectRatio="none" aria-label={caption}>
      {/* The default rate is the lit curve; tag rates step down. */}
      {decay.rates.map((rate, index) => <Curve key={rate.tag ?? ''} start={TYPICAL_START} rate={rate.rate} span={span} line={decay.fade_line} lit={index === 0} />).reverse()}
    </svg>
    <p className="m-0 text-[11px] leading-4 text-muted">{caption}</p>
    <dl className="m-0 grid gap-x-2 gap-y-0.5 text-[12px] leading-5" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
      {decay.rates.map((rate, index) => [
        <dt key={`${rate.tag}:k`} className={`truncate ${index === 0 ? 'text-text' : 'text-muted'}`}>{rate.tag === null ? t('memoryPage.strength_default_rate') : `#${rate.tag}`}</dt>,
        <dd key={`${rate.tag}:v`} className="m-0 text-right tabular-nums text-muted">{days[index] === null ? t('memoryPage.strength_never_short') : t('memoryPage.strength_day', { day: fmtNumber(days[index]!) })}</dd>,
      ])}
    </dl>
  </div>
}
