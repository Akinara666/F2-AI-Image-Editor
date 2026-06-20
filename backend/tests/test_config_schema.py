import pytest

from core.config_schema import ALLOWLIST, SETTINGS_SCHEMA, coerce_value, is_secret


def test_allowlist_matches_schema():
    assert ALLOWLIST == {entry["key"] for entry in SETTINGS_SCHEMA}


def test_bool_coercion():
    assert coerce_value("NSFW_FILTER_ENABLED", "true") == "true"
    assert coerce_value("NSFW_FILTER_ENABLED", False) == "false"
    assert coerce_value("NSFW_FILTER_ENABLED", "on") == "true"


def test_int_clamp_to_range():
    assert coerce_value("CLIP_SKIP", "99") == "12"
    assert coerce_value("CLIP_SKIP", 0) == "1"


def test_float_parsed():
    assert coerce_value("LLM_TEMPERATURE", "0.5") == "0.5"
    with pytest.raises(ValueError):
        coerce_value("LLM_TEMPERATURE", "abc")


def test_select_validation():
    assert coerce_value("PROMPT_TRANSFORM_PROVIDER", "qwen_gguf") == "qwen_gguf"
    with pytest.raises(ValueError):
        coerce_value("PROMPT_TRANSFORM_PROVIDER", "bad")


def test_unknown_key_rejected():
    with pytest.raises(ValueError):
        coerce_value("NOT_A_SETTING", "x")


def test_is_secret():
    assert is_secret("HF_TOKEN")
    assert is_secret("CIVITAI_API_TOKEN")
    assert not is_secret("CLIP_SKIP")
