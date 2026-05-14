"""Tests for the example skill."""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import run


def test_run_returns_input():
    assert run("hello") == "hello"


def test_run_verbose(capsys):
    run("hello", verbose=True)
    captured = capsys.readouterr()
    assert "hello" in captured.out
