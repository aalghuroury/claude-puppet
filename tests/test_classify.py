"""Unit tests for the row classifier."""

from __future__ import annotations

from server.classify import RowClass, classify_row, classify_screen


def test_classify_status_thinking_line() -> None:
    assert classify_row("✶ Razzmatazzing… (5s)") is RowClass.STATUS
    assert classify_row("● Forging…") is RowClass.STATUS


def test_classify_status_timer_token_line() -> None:
    line = "  (12s · ↓ 3.4k tokens · esc to interrupt)"
    assert classify_row(line) is RowClass.STATUS
    assert classify_row("(1m 5s · ↑ 12.0k tokens)") is RowClass.STATUS


def test_classify_chrome_horizontal_separator() -> None:
    assert classify_row("──────────────") is RowClass.CHROME
    assert classify_row("════════") is RowClass.CHROME


def test_classify_chrome_box_drawing() -> None:
    assert classify_row("╭──╮") is RowClass.CHROME
    assert classify_row("│   │") is RowClass.CHROME
    assert classify_row("╰──╯") is RowClass.CHROME


def test_classify_prompt_empty_input() -> None:
    assert classify_row("❯ ") is RowClass.PROMPT
    assert classify_row("  ❯  ") is RowClass.PROMPT


def test_classify_menu_highlighted_option() -> None:
    assert classify_row("❯ 1. Yes, I trust this folder") is RowClass.MENU


def test_classify_menu_unhighlighted_option() -> None:
    assert classify_row("  2. No, exit") is RowClass.MENU
    assert classify_row("Enter to select") is RowClass.MENU
    assert classify_row("Tab/Arrow keys to navigate") is RowClass.MENU


def test_classify_default_is_chat() -> None:
    assert classify_row("hello world") is RowClass.CHAT
    assert classify_row("● This is a normal bullet message") is RowClass.CHAT
    assert classify_row("⎿  result here") is RowClass.CHAT


def test_classify_screen_returns_indexed_tuples() -> None:
    text = "hello\n──────\n❯ "
    out = classify_screen(text)
    assert out == [
        (0, RowClass.CHAT, "hello"),
        (1, RowClass.CHROME, "──────"),
        (2, RowClass.PROMPT, "❯ "),
    ]


def test_classify_unicode_chars_dont_break() -> None:
    # Non-ASCII content that isn't a status/chrome/menu/prompt → CHAT.
    assert classify_row("日本語のテキスト") is RowClass.CHAT
    assert classify_row("emoji line 🎉🚀") is RowClass.CHAT
    # Mixed structure shouldn't crash. (Note: a row that starts AND ends
    # with a box-drawing char is now CHROME — the Claude Code welcome banner
    # used to fall through to CHAT and waste master context.)
    assert classify_row("│ some text │") is RowClass.CHROME


def test_welcome_banner_with_text_is_chrome() -> None:
    """Banner rows with text sandwiched between pipes used to fall through to
    CHAT, wasting ~10 rows per fresh slave session."""
    assert classify_row("│ Welcome back Ahmed! │ Tips for getting started │") is RowClass.CHROME
    assert classify_row("│   Welcome back Ahmed!   │ Tips for getting started     │") is RowClass.CHROME


def test_loading_with_trailing_prose_is_chat() -> None:
    """A slave that says '● Loading config and continuing other work' must be
    classified CHAT, not STATUS — the gerund-ellipsis must be at line end."""
    assert classify_row("● Loading config from disk and parsing it") is RowClass.CHAT


def test_loading_at_line_end_is_status() -> None:
    """Anchored gerund+ellipsis still detected as STATUS."""
    assert classify_row("● Loading…") is RowClass.STATUS
    assert classify_row("● Booting node…") is RowClass.STATUS


def test_searched_with_trailing_hint_is_chat() -> None:
    """Real chat row '  Searched for 3 patterns (ctrl+o to expand)' must NOT be
    eaten as STATUS — the hint is a trailing parenthetical, not the whole line."""
    assert classify_row("  Searched for 3 patterns (ctrl+o to expand)") is RowClass.CHAT


def test_pure_hint_line_is_status() -> None:
    """A line that's ONLY the hint is correctly STATUS."""
    assert classify_row("  ctrl+o to expand") is RowClass.STATUS
    assert classify_row("ctrl+c to interrupt") is RowClass.STATUS
