"""Regression tests: routes.py module-level ``_log`` identity.

``routes._log`` must be ``logging.getLogger("slopsmith.plugin.multiplayer")``.
If it were reverted to ``logging.getLogger(__name__)`` the name would become
``"routes"``, which would bypass the app-wide structlog pipeline.  These tests
ensure both regressions (wrong name, bare ``print()``) are caught immediately.
"""

import ast
import logging
from pathlib import Path


_ROUTES_PATH = Path(__file__).resolve().parents[1] / "routes.py"


def test_module_logger_uses_canonical_name(routes_module):
    """_log must be bound to the shared pipeline name, not __name__."""
    assert routes_module._log.name == "slopsmith.plugin.multiplayer", (
        f"Expected logger name 'slopsmith.plugin.multiplayer', "
        f"got '{routes_module._log.name}'. "
        "Do not revert to logging.getLogger(__name__) or 'routes'."
    )


def test_module_logger_is_standard_logger(routes_module):
    """_log must be a stdlib Logger instance so structlog can wrap it."""
    assert isinstance(routes_module._log, logging.Logger)


def test_module_logger_emits_records_with_canonical_name(routes_module, caplog):
    """Records emitted via _log carry the canonical logger name."""
    with caplog.at_level(logging.DEBUG, logger="slopsmith.plugin.multiplayer"):
        routes_module._log.info("_regression_probe_")

    assert any(
        r.name == "slopsmith.plugin.multiplayer" and "_regression_probe_" in r.message
        for r in caplog.records
    ), "Log record did not arrive under 'slopsmith.plugin.multiplayer'."


def test_routes_has_no_bare_print_calls():
    """routes.py must not contain bare print() calls.

    Uses the AST to detect ``print(...)`` call expressions (not comments or
    string literals), so a future reintroduction of bare print() in routes.py
    will fail the suite immediately regardless of what it prints.
    """
    source = _ROUTES_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(_ROUTES_PATH))

    violations = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name)
            and node.value.func.id == "print"
        ):
            violations.append(node.lineno)

    assert not violations, (
        f"Found bare print() calls in routes.py at line(s): "
        f"{violations}. Use _log.<level>() instead."
    )
