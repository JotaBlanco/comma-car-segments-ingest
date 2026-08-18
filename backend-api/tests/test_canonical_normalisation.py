"""N6 for ``system_states``, which is what closed the last convergence gap.

Found while making the round-1 convergence check pass: the ReqIF path ordered
``system_states`` by the frozen ``ENUM-VALUE`` ``KEY`` ordinal, and the JSON path
preserved authoring order, so five of the 37 real requirements hashed differently
depending on which way they were uploaded. Both paths now run one ordering rule.
"""

import canonical

ORDINAL = list(canonical.SYSTEM_STATE_ORDER)


def test_the_frozen_order_is_the_state_machine_order():
    assert ORDINAL == [
        "Off",
        "Standby",
        "Active-Cruise",
        "Active-Follow",
        "Active-Hold",
        "Driver-Override",
        "Degraded-Fault",
    ]


def test_authoring_order_is_not_a_degree_of_freedom():
    assert canonical.order_system_states(["Active-Hold", "Active-Follow"]) == [
        "Active-Follow",
        "Active-Hold",
    ]
    assert canonical.order_system_states(["Degraded-Fault", "Standby"]) == [
        "Standby",
        "Degraded-Fault",
    ]


def test_ordering_is_not_alphabetical():
    """The trap this replaced: sorted() would put Active-Cruise before Standby."""
    assert canonical.order_system_states(["Standby", "Active-Cruise"]) == [
        "Standby",
        "Active-Cruise",
    ]


def test_an_unknown_state_survives_normalisation_so_the_validator_can_name_it():
    ordered = canonical.order_system_states(["Nonsense", "Off"])
    assert ordered == ["Off", "Nonsense"]


def test_the_rule_is_idempotent():
    once = canonical.order_system_states(["Degraded-Fault", "Off", "Active-Hold"])
    assert canonical.order_system_states(once) == once


def test_normalise_requirement_applies_it():
    document = {
        "id": "ACC-SYS-SAF-024",
        "text": "t",
        "rationale": "r",
        "system_states": ["Degraded-Fault", "Standby", "Active-Cruise"],
    }
    normalised = canonical.normalise_requirement(document)
    assert normalised["system_states"] == ["Standby", "Active-Cruise", "Degraded-Fault"]
    assert canonical.normalise_requirement(normalised) == normalised


def test_normalise_text_keeps_hard_newlines_and_blank_lines():
    """Amended N1 emits ``\\n`` and ``\\n\\n``; N3 must not collapse them away."""
    assert canonical.normalise_text("a  \n  b") == "a\nb"
    assert canonical.normalise_text("one.\n\ntwo.") == "one.\n\ntwo."
    assert canonical.normalise_text("  spaced   out  ") == "spaced out"
    assert canonical.normalise_text("3,5 m/s^2") == "3,5 m/s^2"
