"""The requirement status gate: who may write which status.

`dev-planning/requirement-status-gates/spec.md` §4.1 is the table. `Implemented`
and `Tested` are absent from both maps by construction: they are read off
`verification_state`, which `queries_requirements._project` computes from run
coverage on every read, and they are never stored.
"""

from api.errors import ApiError

DERIVED_STATUSES = frozenset({"Implemented", "Tested"})

# Band A — any person, through PATCH /requirements/{req_id}. `Obsolete` is
# reached by POST /requirements/{req_id}/retire and is not a PATCH target.
AUTHOR_TARGETS: dict[str, frozenset[str]] = {
    "NEW": frozenset({"Draft", "Ready for Review", "Rejected"}),
    "Draft": frozenset({"Ready for Review", "Rejected"}),
    "Ready for Review": frozenset({"Draft", "Rejected"}),
    "In Review": frozenset({"Draft", "Rejected"}),
    "Reviewed": frozenset({"Draft", "Ready for Review", "Rejected"}),
    "Rejected": frozenset({"Draft", "Ready for Review"}),
    "Obsolete": frozenset(),
}

# Band B — the review flow only (dev-planning/review-page/spec.md §5.3), whose
# routes are not built. This map is the contract they are written against.
REVIEW_TARGETS: dict[str, frozenset[str]] = {
    "Ready for Review": frozenset({"In Review"}),
    "In Review": frozenset({"Reviewed", "Rejected", "Draft"}),
}

# A current status neither map names — including the empty string the planning
# mirror stores when a push omits the field (`planning_sync.py`) — still
# reaches band A, or such a row could never move again.
_UNKNOWN = frozenset({"Draft", "Ready for Review", "Rejected"})

_REVIEW_ONLY = {
    "In Review": (
        "In Review is set when a reviewer claims the requirement on the Review page, "
        "not here. Send it for review and let a reviewer pick it up."
    ),
    "Reviewed": (
        "Reviewed is earned by passing a review, not set here. Send the requirement "
        "for review and let a second person accept it."
    ),
}


def check_transition(current: str | None, target: str, table: dict[str, frozenset[str]]) -> None:
    """Raise `illegal_transition` (409) unless `table` allows current -> target.

    The refusal names the band that owns the target, because that is what tells
    a person where the value comes from instead of only that it was refused.
    """
    if target in table.get(current or "", _UNKNOWN):
        return
    if target in DERIVED_STATUSES:
        raise ApiError(
            409,
            f"{target} is computed from test-run coverage and is never set by hand. "
            "It is shown in the Verification column.",
            "illegal_transition",
        )
    if target in _REVIEW_ONLY:
        raise ApiError(409, _REVIEW_ONLY[target], "illegal_transition")
    raise ApiError(
        409,
        f"A requirement cannot move from {current or 'no status'} to {target}.",
        "illegal_transition",
    )
