"""Unit + integration tests for prompt-vault-copy slot / file logic."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import sys
import threading
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "bin" / "prompt-vault-copy"


def _load_copy_module():
    loader = importlib.machinery.SourceFileLoader("prompt_vault_copy", str(SCRIPT))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["prompt_vault_copy"] = mod
    spec.loader.exec_module(mod)
    return mod


pvc = _load_copy_module()


@pytest.mark.parametrize(
    "raw,expected",
    [
        (1, 1),
        ("9", 9),
        (0, 0),
        (10, 0),
        ("x", 0),
        (None, 0),
        (3.0, 3),
    ],
)
def test_normalize_slot(raw, expected):
    assert pvc._normalize_slot(raw) == expected


def test_find_by_slot_first_match():
    prompts = [
        {"hotkeySlot": 2, "title": "a"},
        {"hotkeySlot": "2", "title": "b"},
        {"hotkeySlot": 5, "title": "c"},
    ]
    found = pvc._find_by_slot(prompts, 2)
    assert found["title"] == "a"
    assert pvc._find_by_slot(prompts, 9) is None


def test_parse_prompts_wrapped_and_raw():
    assert pvc._parse_prompts({"prompts": [{"id": "1"}]}) == [{"id": "1"}]
    assert pvc._parse_prompts([{"id": "2"}]) == [{"id": "2"}]
    with pytest.raises(ValueError):
        pvc._parse_prompts({"nope": True})


def test_load_save_roundtrip_locked(tmp_path, monkeypatch):
    data_dir = tmp_path / "pv"
    monkeypatch.setenv("PROMPT_VAULT_DATA_DIR", str(data_dir))
    path = pvc._prompts_path()
    payload = {
        "version": 1,
        "prompts": [
            {
                "id": "p1",
                "title": "Hello",
                "content": "world",
                "hotkeySlot": 4,
                "useCount": 0,
            }
        ],
    }
    pvc._save_json_locked(path, payload)
    assert path.exists()
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    loaded = pvc._load_json_locked(path)
    assert loaded["prompts"][0]["title"] == "Hello"
    assert pvc._find_by_slot(loaded["prompts"], 4)["id"] == "p1"


def test_data_dir_tilde_expansion(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("PROMPT_VAULT_DATA_DIR", "~/vault-data")
    assert pvc._data_dir() == tmp_path / "vault-data"


def test_paste_clipboard_prefers_xdotool(monkeypatch):
    calls = []

    def which(cmd):
        return "/usr/bin/xdotool" if cmd == "xdotool" else None

    monkeypatch.setattr(pvc, "shutil_which", which)
    monkeypatch.setattr(pvc.time, "sleep", lambda _s: None)
    monkeypatch.setattr(
        pvc.subprocess,
        "run",
        lambda argv, **kwargs: calls.append(argv) or type("R", (), {"returncode": 0})(),
    )
    pvc._paste_clipboard({"DISPLAY": ":0"})
    assert any(c and c[0] == "xdotool" and "ctrl+v" in c for c in calls)


def test_paste_clipboard_falls_back_to_xlib(monkeypatch):
    used = []
    monkeypatch.setattr(pvc, "shutil_which", lambda cmd: None)
    monkeypatch.setattr(pvc, "_paste_via_xlib", lambda env: used.append(env))
    monkeypatch.setattr(pvc, "_release_hotkey_modifiers", lambda env: None)
    monkeypatch.setattr(pvc.time, "sleep", lambda _s: None)
    pvc._paste_clipboard({"DISPLAY": ":0"})
    assert used and used[0]["DISPLAY"] == ":0"


def test_paste_clipboard_wayland_needs_tool(monkeypatch):
    monkeypatch.setattr(pvc, "shutil_which", lambda cmd: None)
    monkeypatch.setattr(pvc, "_release_hotkey_modifiers", lambda env: None)
    monkeypatch.setattr(pvc.time, "sleep", lambda _s: None)
    with pytest.raises(RuntimeError, match="wtype or ydotool"):
        pvc._paste_clipboard({"WAYLAND_DISPLAY": "wayland-0"})


def test_cmd_copy_slot_keeps_prompt_added_during_clipboard(tmp_path, monkeypatch):
    """Desklet can write a new prompt while GTK copy runs; CLI must not drop it."""
    path = tmp_path / "prompts.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "prompts": [
                    {
                        "id": "a",
                        "title": "Alpha",
                        "content": "hello",
                        "hotkeySlot": 1,
                        "useCount": 0,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(pvc, "_notify", lambda *a, **k: None)

    def fake_copy(text):
        assert text == "hello"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["prompts"].append(
            {"id": "b", "title": "New", "content": "n", "hotkeySlot": 0}
        )
        path.write_text(json.dumps(data), encoding="utf-8")

    monkeypatch.setattr(pvc, "_copy_to_clipboard", fake_copy)
    rc = pvc.cmd_copy_slot(path, 1, quiet=True, paste=False)
    assert rc == 0
    saved = json.loads(path.read_text(encoding="utf-8"))
    ids = {p["id"] for p in saved["prompts"]}
    assert ids == {"a", "b"}, f"lost concurrent add: {ids}"
    alpha = next(p for p in saved["prompts"] if p["id"] == "a")
    assert alpha["useCount"] == 1
    assert alpha["content"] == "hello"


def test_apply_copy_usage_increments_only_copied_id():
    prompts = [
        {"id": "a", "useCount": 2, "content": "x"},
        {"id": "b", "useCount": 0, "content": "y"},
    ]
    out = pvc._apply_copy_usage(prompts, "a", "2026-08-30T10:00:00+02:00")
    assert out[0]["useCount"] == 3
    assert out[0]["lastUsedAt"] == "2026-08-30T10:00:00+02:00"
    assert out[1]["useCount"] == 0
    assert "lastUsedAt" not in out[1]


def test_dir_lock_serializes_two_usage_increments(tmp_path):
    path = tmp_path / "prompts.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "prompts": [{"id": "a", "hotkeySlot": 1, "useCount": 0, "content": "x"}],
            }
        ),
        encoding="utf-8",
    )
    errors = []

    def worker():
        try:
            with pvc._file_lock(path, True):
                data = pvc._load_json_locked(path)
                prompts = pvc._apply_copy_usage(pvc._parse_prompts(data), "a", "t")
                data["prompts"] = prompts
                pvc._save_json_locked(path, data)
        except Exception as exc:  # pragma: no cover - failure is the assertion
            errors.append(exc)

    t1 = threading.Thread(target=worker)
    t2 = threading.Thread(target=worker)
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    assert errors == []
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["prompts"][0]["useCount"] == 2
