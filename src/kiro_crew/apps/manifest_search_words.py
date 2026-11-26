"""Validation of a manifest page's ``searchWords`` (``ui.pages[].searchWords``).

The words are English phrases a newcomer might use for the page. The find_ui
index generator reads them at build time for the apps that ship in the package;
install refuses a malformed list here.
"""

from __future__ import annotations

#: Same bounds as a location's curated search terms in the find_ui index.
MAX_SEARCH_WORDS = 16
MAX_SEARCH_WORD_CHARS = 60


def search_words_errors(route: str, words: list[str], type_invalid: bool) -> list[str]:
    """Why a page's ``searchWords`` would be refused, one line per problem."""
    where = f"ui page {route or '?'} searchWords"
    if type_invalid:
        return [f"{where} must be a list of strings"]
    errors: list[str] = []
    if len(words) > MAX_SEARCH_WORDS:
        errors.append(f"{where}: at most {MAX_SEARCH_WORDS} (declared {len(words)})")
    for word in words:
        if not word.strip():
            errors.append(f"{where}: a phrase is blank")
        elif len(word.strip()) > MAX_SEARCH_WORD_CHARS:
            errors.append(
                f"{where}: {word[:20]!r}... is longer than {MAX_SEARCH_WORD_CHARS} characters"
            )
    return errors
