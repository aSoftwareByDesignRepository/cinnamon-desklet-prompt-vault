#!/usr/bin/env python3
"""Run test_prompt_vault_copy.py without requiring the pytest package.

`python3 -m pytest` is the preferred path (npm run test:python). This runner
exists because this machine has no pytest module and no pip.
"""

from __future__ import annotations

import inspect
import os
import sys
import tempfile
import traceback
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _install_pytest_stub() -> None:
    try:
        import pytest  # noqa: F401

        return
    except ImportError:
        pass

    pytest = types.ModuleType("pytest")

    def _parametrize_impl(argnames, argvalues):
        names = [n.strip() for n in argnames.split(",")] if isinstance(argnames, str) else list(argnames)

        def decorator(func):
            func._pv_param_names = names
            func._pv_param_values = list(argvalues)
            return func

        return decorator

    class _Mark:
        pass

    _Mark.parametrize = staticmethod(_parametrize_impl)

    class _Raises:
        def __init__(self, exc, match=None):
            self.exc = exc
            self.match = match

        def __enter__(self):
            return self

        def __exit__(self, t, v, tb):
            if t is None:
                raise AssertionError(f"did not raise {self.exc}")
            if not issubclass(t, self.exc):
                return False
            if self.match and self.match not in str(v):
                raise AssertionError(f"{v!r} did not match {self.match!r}")
            return True

    pytest.mark = _Mark()
    pytest.raises = _Raises
    sys.modules["pytest"] = pytest


class MonkeyPatch:
    def __init__(self) -> None:
        self._undo: list = []

    def setattr(self, target, name, value):
        original = getattr(target, name)
        self._undo.append(("attr", target, name, original))
        setattr(target, name, value)

    def setenv(self, key, value):
        self._undo.append(("env", key, os.environ.get(key, None), key in os.environ))
        os.environ[key] = value

    def undo(self) -> None:
        while self._undo:
            item = self._undo.pop()
            if item[0] == "attr":
                _, target, name, original = item
                setattr(target, name, original)
            else:
                _, key, old, existed = item
                if existed:
                    os.environ[key] = old
                else:
                    os.environ.pop(key, None)


def _call_test(fn, tmp_path: Path) -> None:
    sig = inspect.signature(fn)
    kwargs = {}
    mp = None
    if "tmp_path" in sig.parameters:
        kwargs["tmp_path"] = tmp_path
    if "monkeypatch" in sig.parameters:
        mp = MonkeyPatch()
        kwargs["monkeypatch"] = mp
    try:
        fn(**kwargs)
    finally:
        if mp is not None:
            mp.undo()


def main() -> int:
    _install_pytest_stub()
    # Import after stub so test_prompt_vault_copy can `import pytest`.
    sys.path.insert(0, str(HERE))
    import test_prompt_vault_copy as tmod  # type: ignore  # noqa: E402

    tests = []
    for name, obj in inspect.getmembers(tmod):
        if not name.startswith("test_") or not callable(obj):
            continue
        values = getattr(obj, "_pv_param_values", None)
        names = getattr(obj, "_pv_param_names", None)
        if values is not None:
            for row in values:
                if not isinstance(row, (list, tuple)):
                    row = (row,)
                def _make(fn=obj, nms=names, row=row):
                    def _bound():
                        kw = dict(zip(nms, row))
                        fn(**kw)
                    _bound.__name__ = f"{fn.__name__}[{row}]"
                    return _bound
                tests.append(_make())
        else:
            tests.append(obj)

    failed = 0
    passed = 0
    for fn in tests:
        label = getattr(fn, "__name__", str(fn))
        with tempfile.TemporaryDirectory(prefix="pv-cli-") as td:
            try:
                _call_test(fn, Path(td))
            except Exception:
                failed += 1
                print(f"FAIL {label}")
                traceback.print_exc()
            else:
                passed += 1
                print(f"ok   {label}")

    print(f"{passed} passed, {failed} failed, {passed + failed} total")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
