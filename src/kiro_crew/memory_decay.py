"""How strong each V1 experience is in recall today, and when it falls behind.

V1 recall scores an experience as ``cosine * (0.7 + 0.3 * importance) *
exp(-rate * days_old)`` (:func:`episodic_search.recall_score`). Its *strength* is
that score at a perfect match (:func:`episodic_search.recall_weight`): the part
the query does not decide. The memory page and the memory graph both read it from
there, so the two views and recall agree.

The *fade line* is the score of a memory written today, at the lowest importance,
that just clears the relevance gate: ``_EPISODIC_RELEVANCE_THRESHOLD * 0.7``.
Below it, even an exact match ranks under any such new memory. Nothing else about
the row changes there: it is still stored and still admitted on a close match.

Only importance, the tag rate (``memory.decay_rates``) and the row's age move the
strength. A recall stamps ``last_accessed_at`` and an edit changes the text, and
neither enters the score. V2 stores do not decay (``memory_v2.rank_score``), so
they get no strength at all.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any

from kiro_crew.vector_memory_runtime import episodic_search

#: A memory under this strength ranks below every new memory that clears the
#: relevance gate, even on an exact match.
FADE_LINE = round(episodic_search._EPISODIC_RELEVANCE_THRESHOLD * 0.7, 4)
#: "Fading soon" means the row crosses the fade line within this many days. A
#: week: at the default rate an importance-0.5 row crosses on day 27, so a month
#: would call nearly every new row fading.
SOON_DAYS = 7
STRONG, FADING, FADED = "strong", "fading", "faded"
STATES = (STRONG, FADING, FADED)


def applies(store: Any) -> bool:
    """Whether the store's recall fades experiences with age (V1 only)."""
    return getattr(store, "algorithm_version", "v1") != "v2"


def days_to_line(start: float, rate: float, days_old: int) -> int | None:
    """Days from now until a row of strength *start* on its first day, fading at
    *rate*, is first below :data:`FADE_LINE`; 0 when it already is, ``None`` when
    it never will be.

    Ages are whole days, as recall counts them, so the answer is the first whole
    age whose strength is under the line.
    """
    if start < FADE_LINE:
        return 0
    if rate <= 0:
        return None
    crossing = math.floor(math.log(start / FADE_LINE) / rate) + 1
    return max(0, crossing - days_old)


def state(until: int | None) -> str:
    """The strength band for a row that crosses the fade line in *until* days."""
    if until == 0:
        return FADED
    if until is not None and until <= SOON_DAYS:
        return FADING
    return STRONG


def record_decay(store: Any, row: Any, now: datetime) -> dict[str, Any]:
    """One experience's strength today and what sets it, for the detail panel."""
    rate, tag = episodic_search.decay_rule_for(store, row["tags"])
    importance = episodic_search.row_importance(row)
    days_old = episodic_search.row_age_days(row, now)
    start = episodic_search.recall_score(1.0, importance, rate, 0)
    until = days_to_line(start, rate, days_old)
    return {
        "strength": round(episodic_search.recall_weight(store, row, now), 4),
        "start": round(start, 4),
        "rate": rate,
        "rate_tag": tag,
        "days_old": days_old,
        "days_to_line": until,
        "state": state(until),
    }


def summary_strength(store: Any, row: Any, now: datetime) -> tuple[float, str]:
    """The strength and band a record list summary sorts and filters on."""
    decay = record_decay(store, row, now)
    return decay["strength"], decay["state"]


def store_decay(store: Any) -> dict[str, Any]:
    """The store's fade rates for the page's chart: the default, then each tag's."""
    rates = [{"tag": None, "rate": store._decay_default}]
    rates += [{"tag": tag, "rate": rate} for tag, rate in sorted(store._decay_by_tag.items())]
    return {"fade_line": FADE_LINE, "soon_days": SOON_DAYS, "rates": rates}
