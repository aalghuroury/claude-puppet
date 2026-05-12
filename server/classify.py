"""Pure-Python row classifier for slave terminal output."""

from __future__ import annotations

import re
from enum import Enum


class RowClass(str, Enum):
    CHAT = "chat"
    CHROME = "chrome"
    STATUS = "status"
    PROMPT = "prompt"
    MENU = "menu"


_STATUS_PATTERNS = [
    # Claude's "thinking" progress line: bullet-prefix + a gerund + ellipsis.
    # Allows arbitrary content between the gerund and the ellipsis ("● Booting
    # node…"), and arbitrary trailing content after ("✶ Razzmatazzing… (5s)").
    re.compile(r"^\s*[✶✺✦●◆○]\s*\w+(?:i|y)ng\b[^\n]*[…\.]"),
    re.compile(r"\(\s*\d+(?:m\s*\d+)?\s*s\s*[·•⋅]\s*[↓↑]\s*[\d.]+k?\s*tokens?[^)]*\)"),
    re.compile(r"⏵⏵\s*bypass permissions"),
    re.compile(r"plan mode on \(shift\+tab"),
    re.compile(r"^\s*ctrl\+[oc]\s+to\s+(?:expand|cycle|interrupt)\s*$"),
    re.compile(r"esc to interrupt"),
]

_CHROME_HORIZONTAL = re.compile(r"^[\s─╌━═]+$")
_CHROME_BOX = re.compile(r"^[\s╭╮╯╰│┌┐└┘├┤┬┴┼─╌━═]+$")
# Banner row like "│ Welcome back │ Tips … │": starts AND ends with a
# box-drawing char (allowing trailing whitespace), with arbitrary content
# in between. Catches Claude Code's welcome banner rows that don't fit
# _CHROME_BOX (which requires the WHOLE line to be box chars).
_CHROME_BOX_WITH_TEXT = re.compile(
    r"^[│╭╮╯╰┌┐└┘├┤┬┴┼─╌━═][\s\S]*[│╭╮╯╰┌┐└┘├┤┬┴┼─╌━═]\s*$"
)

_PROMPT_EMPTY = re.compile(r"^\s*❯\s*$")

_MENU_HIGHLIGHTED = re.compile(r"^\s*❯\s*\d+\.\s+\S")
_MENU_UNHIGHLIGHTED = re.compile(r"^\s*\d+\.\s+\S")
_MENU_HINT_ENTER = re.compile(r"^\s*Enter to (?:select|confirm)")
_MENU_HINT_TAB = re.compile(r"^\s*Tab/Arrow keys to navigate")


def classify_row(text: str) -> RowClass:
    """Classify a single row of terminal text."""
    for rx in _STATUS_PATTERNS:
        if rx.search(text):
            return RowClass.STATUS
    stripped = text.strip()
    if stripped:
        if _CHROME_HORIZONTAL.match(text):
            return RowClass.CHROME
        if _CHROME_BOX.match(text):
            return RowClass.CHROME
        if _CHROME_BOX_WITH_TEXT.match(text):
            return RowClass.CHROME
    if _PROMPT_EMPTY.match(text):
        return RowClass.PROMPT
    if _MENU_HIGHLIGHTED.match(text):
        return RowClass.MENU
    if _MENU_UNHIGHLIGHTED.match(text):
        return RowClass.MENU
    if _MENU_HINT_ENTER.match(text):
        return RowClass.MENU
    if _MENU_HINT_TAB.match(text):
        return RowClass.MENU
    return RowClass.CHAT


def classify_screen(text: str) -> list[tuple[int, RowClass, str]]:
    """Classify every line of a screen buffer; returns [(row, class, text), ...]."""
    lines = text.split("\n") if text else [""]
    return [(i, classify_row(line), line) for i, line in enumerate(lines)]
