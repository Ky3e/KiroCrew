/** The memory kind pills, shared by the Memories list and the Graph tab. */
import { useTranslation } from 'react-i18next'
import InfoTip from '../../../components/InfoTip'
import { fmtNumber } from '../../../i18n/format'
import { kindTip } from './memoryTypeTips'
import type { KindTab } from './memoryListView'

const KINDS: [KindTab, string][] = [['all', 'memoryV2.filter_all'], ['fact', 'memoryV2.facts_label'], ['directive', 'memoryV2.rules_label'], ['episode', 'memoryV2.experiences_label']]
// The picked kind pill: filled with the text colour on both themes (mock S2).
export const PILL_ON = 'border-text bg-text font-medium text-bg'

/** The kind pills, one row with live counts; a phone scrolls the row sideways. */
export function KindPills({ kind, counts, onChange, disabled, wrap = false, bot, swatches }: { kind: KindTab; counts?: Record<string, number>; onChange: (kind: KindTab) => void; disabled?: boolean; wrap?: boolean; bot?: string
  /** A colour dot per kind, the key to a view that colours by kind (the graph). */
  swatches?: Partial<Record<KindTab, string>> }) {
  const { t } = useTranslation()
  const total = counts ? (counts.fact || 0) + (counts.directive || 0) + (counts.episode || 0) : undefined
  return <div role="radiogroup" aria-label={t('memoryV2.group_kind')} title={t('memoryV2.memory_kinds_explanation')} className={`-mx-1 flex min-w-0 gap-2 px-1 ${wrap ? 'flex-wrap' : 'overflow-x-auto [scrollbar-width:none]'}`}>
    {KINDS.map(([key, label]) => {
      const on = key === kind
      const count = key === 'all' ? total : counts ? counts[key] || 0 : undefined
      const hint = key === 'all' ? undefined : kindTip(key, bot)
      // The (?) sits beside the pill, not in it, so opening the tip never picks the kind.
      return <span key={key} className="flex shrink-0 items-center gap-0.5">
        <button type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => onChange(key)} className="flex min-h-11 shrink-0 items-center disabled:opacity-40 sm:min-h-8">
          <span className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] ${on ? PILL_ON : 'border-border text-text'}`}>{swatches?.[key] && <span aria-hidden="true" data-testid={`kind-swatch-${key}`} className="h-2 w-2 shrink-0 rounded-full" style={{ background: swatches[key] }} />}{t(label)}{count !== undefined && <span className={`tabular-nums ${on ? 'opacity-70' : 'text-muted'}`}>{fmtNumber(count)}</span>}</span>
        </button>
        {hint && <InfoTip text={hint} />}
      </span>
    })}
  </div>
}
