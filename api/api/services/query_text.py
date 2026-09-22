"""Text-query helpers shared by both lanes.

Both lanes import these. Lane A uses them for its list filters and the search
box. Lane B adopted them on 19 Aug 2026 (R-07): `queries_signals.list_files`
and the `/signals` route matched one substring until then, so a two-word query
found nothing.
"""

import re


def escaped_contains(value: str) -> dict:
    """A case-insensitive substring match that treats the needle as text.

    A lone `(` is a literal here, never a broken regex — guard test 7.
    """
    return {"$regex": re.escape(value.strip()), "$options": "i"}


def every_word_matches(query: str, fields: tuple[str, ...]) -> dict:
    """A word-AND clause: each word must appear in at least one field.

    The words may arrive in any order, and each one is escaped text (guard
    test 7). The caller skips a blank query first — an empty word list would
    build an empty `$and`, which Mongo rejects.
    """
    return {
        "$and": [
            {"$or": [{field: escaped_contains(word)} for field in fields]}
            for word in query.split()
        ]
    }


def relevance_band(query: str, identifier: str) -> int:
    """Score how well one hit's identifier answers the query. Lower wins.

    FR-DM-015 asks for results "ranked by relevance", and UC-003 step 2 asks
    for "ranked results". Neither text names a formula, so this is the
    simplest honest rule: the exact identifier beats a prefix, a prefix beats
    a match anywhere, and a row that matched some other field comes last.
    """
    needle = query.strip().casefold()
    if not needle:
        return 3
    name = (identifier or "").casefold()
    if name == needle:
        return 0
    if name.startswith(needle):
        return 1
    if needle in name:
        return 2
    return 3


def rank_by_relevance(query: str, items: list[dict]) -> list[dict]:
    """Order the hits by relevance, and keep every one of them.

    The sort is stable, so two hits in one band keep the order the database
    gave them. The same query therefore answers the same order twice.
    """
    return sorted(items, key=lambda item: relevance_band(query, item.get("id", "")))
