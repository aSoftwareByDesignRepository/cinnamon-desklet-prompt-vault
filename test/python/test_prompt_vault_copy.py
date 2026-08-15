"""Unit + integration tests for prompt-vault-copy slot / file logic."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import sys
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
