"""Fail-closed identity agreement between pinned Python and native RC artifacts."""
from __future__ import annotations


def verify_pair(wheel: dict[str, str], native: dict[str, str]) -> None:
    """Check matching immutable source and wheel identities, not just equal core refs."""
    for name in ("wheel_sha256", "python_commit", "core_commit"):
        if wheel.get(name) != native.get(name) or not wheel.get(name):
            raise ValueError(
                f"Python/native parser provenance mismatch: {name}: "
                f"Python={wheel.get(name)!r} native={native.get(name)!r}"
            )


def main() -> None:
    from verify_candidate_wheel import WHEEL_SHA256, PYTHON_COMMIT, CORE_COMMIT
    from verify_candidate_native import (
        COMPONENT_WHEEL_SHA256, COMPONENT_PYTHON_COMMIT, COMPONENT_CORE_COMMIT,
    )
    wheel = dict(wheel_sha256=WHEEL_SHA256, python_commit=PYTHON_COMMIT, core_commit=CORE_COMMIT)
    native = dict(wheel_sha256=COMPONENT_WHEEL_SHA256,
                  python_commit=COMPONENT_PYTHON_COMMIT, core_commit=COMPONENT_CORE_COMMIT)
    verify_pair(wheel, native)
    print("Python/native parser candidate identities match")


if __name__ == "__main__":
    main()
