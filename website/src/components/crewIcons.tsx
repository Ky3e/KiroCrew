/**
 * Crew icons: one glyph per remote crew, so the switcher's chips and rows can be
 * told apart without reading the name. The name is the only other identifier, and
 * a phone chip draws no name, so there the icon is the whole chip. Local keeps
 * the house.
 *
 * A crew gets an icon the first time this dashboard lists it, picked at random
 * from the icons the listed crews use least, so a handful of crews never share
 * one. The pick is stored, so it survives reloads, and Settings -> Remote Crew
 * changes it (`CrewIconPicker`).
 *
 * Storage is the same shape as the switcher's pin set: a module-level store over
 * one localStorage key, because several bars in this realm are mounted at once
 * and must change together. A remote pane is a separate cross-origin realm, so it
 * never reads this store; the parent relays each tab's icon in `mc-host-model`.
 */
import { useSyncExternalStore } from 'react'
import {
  Anchor,
  Bird,
  Cat,
  Coffee,
  Compass,
  Crown,
  Dog,
  Feather,
  Fish,
  Flame,
  Gem,
  Leaf,
  Loader2,
  Moon,
  Mountain,
  Music,
  Rabbit,
  Snowflake,
  Star,
  Sun,
  Turtle,
  type LucideIcon,
} from 'lucide-react'
import { safeGetItem, safeSetItem } from '../utils/safeStorage'
import { savePrefExplicitly } from '../lib/uiPrefs'
import { i18nT } from '../i18n/t'
import { stateDotCls, stateTextCls } from './crewStateMark'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from './ui/dropdown-menu'
import { IconButton } from './ui'

/** localStorage key: a JSON object mapping instance id to an icon key. */
export const CREW_ICONS_PREF_KEY = 'mc-crew-switcher-icons'

/**
 * The icons a crew can wear, keyed by the word that is stored. None of them is a
 * glyph the switcher already uses for something else (house, lock, pin, cloud).
 */
export const CREW_ICONS = {
  star: Star,
  moon: Moon,
  sun: Sun,
  leaf: Leaf,
  flame: Flame,
  mountain: Mountain,
  anchor: Anchor,
  compass: Compass,
  feather: Feather,
  fish: Fish,
  bird: Bird,
  cat: Cat,
  dog: Dog,
  rabbit: Rabbit,
  turtle: Turtle,
  coffee: Coffee,
  gem: Gem,
  crown: Crown,
  snowflake: Snowflake,
  music: Music,
} satisfies Record<string, LucideIcon>

export type CrewIconKey = keyof typeof CREW_ICONS

export const CREW_ICON_KEYS = Object.keys(CREW_ICONS) as CrewIconKey[]

export function isCrewIconKey(value: unknown): value is CrewIconKey {
  return typeof value === 'string' && Object.hasOwn(CREW_ICONS, value)
}

export type CrewIconMap = Readonly<Record<string, CrewIconKey>>

/**
 * One crew's icon. Always read the map through this: a crew id is a slug of its
 * name, so `constructor` is a valid id, and a plain index would return the
 * inherited `Object` function for it.
 */
export function crewIconOf(map: CrewIconMap, id: string): CrewIconKey | undefined {
  return Object.hasOwn(map, id) ? map[id] : undefined
}

/** Parse the stored map. A corrupted value, or an entry naming no known icon, is dropped. */
export function parseCrewIcons(raw: string | null): CrewIconMap {
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, CrewIconKey> = {}
    for (const [id, key] of Object.entries(parsed)) if (isCrewIconKey(key)) out[id] = key
    return out
  } catch {
    return {}
  }
}

/**
 * The map with an icon for every id in `ids` that has none. Each new crew takes a
 * random icon among the ones the crews in `ids` use least, so duplicates appear
 * only once every icon is taken. Crews not in `ids` do not count: a removed
 * crew's icon is free again. Returns `current` itself when nothing was added.
 *
 * ponytail: entries for removed crews are never pruned. Each is a few bytes; prune
 * them here if a user ever carries hundreds of crews through one profile.
 */
export function assignCrewIcons(
  current: CrewIconMap,
  ids: readonly string[],
  random: () => number = Math.random,
): CrewIconMap {
  const uses = new Map<CrewIconKey, number>(CREW_ICON_KEYS.map(k => [k, 0]))
  for (const id of new Set(ids)) {
    const key = crewIconOf(current, id)
    if (key) uses.set(key, (uses.get(key) ?? 0) + 1)
  }
  let next: Record<string, CrewIconKey> | null = null
  for (const id of new Set(ids)) {
    if (crewIconOf(current, id)) continue
    const least = Math.min(...uses.values())
    const free = CREW_ICON_KEYS.filter(k => uses.get(k) === least)
    const key = free[Math.min(free.length - 1, Math.floor(random() * free.length))]
    next ??= { ...current }
    next[id] = key
    uses.set(key, least + 1)
  }
  return next ?? current
}

let iconsState: CrewIconMap = parseCrewIcons(safeGetItem(CREW_ICONS_PREF_KEY))
const listeners = new Set<() => void>()

/**
 * Another tab of this origin wrote the map: adopt it, so this tab draws that
 * tab's assignments and its next write starts from them instead of putting its
 * own older copy back over a pick made there. `storage` never fires in the tab
 * that wrote, so adopting cannot loop.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.storageArea && e.storageArea !== localStorage) return
    if (e.key !== CREW_ICONS_PREF_KEY || e.newValue === null) return
    iconsState = parseCrewIcons(e.newValue)
    listeners.forEach(l => l())
  })
}

function publish(next: CrewIconMap, explicit: boolean) {
  iconsState = next
  const raw = JSON.stringify(next)
  // An assignment is a default this dashboard picked; a pick in Settings is the
  // user's own choice, which the host backup must not put a stale value over.
  if (explicit) savePrefExplicitly(CREW_ICONS_PREF_KEY, raw)
  else safeSetItem(CREW_ICONS_PREF_KEY, raw)
  listeners.forEach(l => l())
}

/** Give every listed crew an icon it does not have yet. A no-op when all have one. */
export function ensureCrewIcons(ids: readonly string[], random?: () => number) {
  const next = assignCrewIcons(iconsState, ids, random)
  if (next !== iconsState) publish(next, false)
}

/** The user's pick for one crew. */
export function setCrewIcon(id: string, key: CrewIconKey) {
  if (crewIconOf(iconsState, id) === key) return
  publish({ ...iconsState, [id]: key }, true)
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Re-read the stored map, as a page load does. Tests only: the store reads at import. */
export function __reloadCrewIconsForTests() {
  iconsState = parseCrewIcons(safeGetItem(CREW_ICONS_PREF_KEY))
  listeners.forEach(l => l())
}

/** Reactive read of every crew's icon. */
export function useCrewIcons(): CrewIconMap {
  return useSyncExternalStore(subscribe, () => iconsState, () => iconsState)
}

/** The crew's icon alone, sized to sit in the phone chip's badge disc. */
export function CrewIconInBadge({ icon }: { icon: CrewIconKey }) {
  const Icon = CREW_ICONS[icon]
  return <Icon className="w-2.5 h-2.5" aria-hidden data-crew-icon={icon} />
}

/**
 * The mark's shape for a tunnel state, so the state never rests on colour alone
 * in the switcher's rows and desktop chips: a filled dot while live, a diamond for
 * an error, and a hollow ring when stopped or disconnected. The same rule as the
 * badge's outline styles (`crewStateMark.tsx`), which a phone chip uses instead,
 * in shapes that still read at 6px.
 */
export function markShape(state?: string): 'dot' | 'diamond' | 'ring' {
  return state === 'connected' ? 'dot' : state === 'error' ? 'diamond' : 'ring'
}

const MARK_SHAPE_CLS: Record<ReturnType<typeof markShape>, (state?: string) => string> = {
  dot: state => `rounded-full ${stateDotCls(state)}`,
  diamond: state => `rotate-45 rounded-[1px] ${stateDotCls(state)}`,
  ring: state => `rounded-full border-[1.5px] border-current bg-[var(--bg)] ${stateTextCls(state)}`,
}

/**
 * A remote crew's glyph with its connection state as a mark on the corner. With
 * no icon (a Relay Crew tab, or a pane whose host relays none) the mark is the
 * whole glyph, centred. While the tunnel connects the spinner stands in for the
 * glyph, as it does for the letter badge. Every form is 1em square, so a chip's
 * width does not depend on which one it shows.
 */
export function CrewGlyph({
  icon,
  state,
  connecting = false,
}: {
  icon?: CrewIconKey
  state?: string
  connecting?: boolean
}) {
  if (connecting) return <Loader2 className="lucide-inline shrink-0 animate-spin" aria-hidden />
  const Icon = icon ? CREW_ICONS[icon] : null
  const shape = markShape(state)
  return (
    <span className="lucide-inline relative" aria-hidden data-crew-icon={icon}>
      {Icon ? <Icon className="block w-full h-full" /> : null}
      <span
        data-testid="crew-state-mark"
        data-state={state ?? ''}
        data-shape={shape}
        className={
          'absolute w-1.5 h-1.5 ' +
          (Icon ? '-right-0.5 -bottom-0.5 ring-[1.5px] ring-[var(--bg)] ' : 'inset-0 m-auto ') +
          MARK_SHAPE_CLS[shape](state)
        }
      />
    </span>
  )
}

/** Each icon's catalog key, spelled out so the catalog tooling can see it. */
const ICON_NAME_KEYS = {
  star: 'components.crewIcons.name_star',
  moon: 'components.crewIcons.name_moon',
  sun: 'components.crewIcons.name_sun',
  leaf: 'components.crewIcons.name_leaf',
  flame: 'components.crewIcons.name_flame',
  mountain: 'components.crewIcons.name_mountain',
  anchor: 'components.crewIcons.name_anchor',
  compass: 'components.crewIcons.name_compass',
  feather: 'components.crewIcons.name_feather',
  fish: 'components.crewIcons.name_fish',
  bird: 'components.crewIcons.name_bird',
  cat: 'components.crewIcons.name_cat',
  dog: 'components.crewIcons.name_dog',
  rabbit: 'components.crewIcons.name_rabbit',
  turtle: 'components.crewIcons.name_turtle',
  coffee: 'components.crewIcons.name_coffee',
  gem: 'components.crewIcons.name_gem',
  crown: 'components.crewIcons.name_crown',
  snowflake: 'components.crewIcons.name_snowflake',
  music: 'components.crewIcons.name_music',
} as const satisfies Record<CrewIconKey, string>

/** The localized name of an icon, for the picker's options. */
function iconName(key: CrewIconKey): string {
  return i18nT(ICON_NAME_KEYS[key])
}

/** Settings -> Remote Crew: change one crew's icon. Applies at once, like the crew's on/off switch. */
export function CrewIconPicker({ id, name, disabled }: { id: string; name: string; disabled?: boolean }) {
  const current = crewIconOf(useCrewIcons(), id)
  const Icon = current ? CREW_ICONS[current] : null
  const label = i18nT('components.crewIcons.change_icon', { name })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          aria-label={current ? i18nT('components.crewIcons.change_icon_current', { name, icon: iconName(current) }) : label}
          disabled={disabled}
          data-testid={`crew-icon-picker-${id}`}
          className="inline-flex items-center justify-center min-w-[28px] min-h-[28px] border border-solid border-border"
        >
          {Icon ? <Icon size={16} aria-hidden /> : <CrewGlyph />}
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label={label} className="p-1">
        <DropdownMenuRadioGroup
          value={current ?? ''}
          onValueChange={v => {
            if (isCrewIconKey(v)) setCrewIcon(id, v)
          }}
          className="grid grid-cols-5 gap-0.5"
        >
          {CREW_ICON_KEYS.map(key => {
            const Option = CREW_ICONS[key]
            const optionName = iconName(key)
            return (
              <DropdownMenuRadioItem
                key={key}
                value={key}
                aria-label={optionName}
                title={optionName}
                className="justify-center w-10 h-10 px-0 py-0 data-[state=checked]:bg-accent-subtle data-[state=checked]:text-accent"
              >
                <Option size={18} aria-hidden />
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
