from __future__ import annotations
from dataclasses import dataclass
from typing import Callable, Optional
import time

@dataclass
class AsrPartial:
    text: str
    is_final: bool
    t0_ms: int
    t1_ms: int
    recv_at_ms: int

Callback = Callable[[AsrPartial], None]

class AsrBridge:
    """Hook this class to your existing ASR stream.
    Call `on_partial(cb)` once, then invoke `cb(AsrPartial(...))` for every ASR partial.
    """
    def __init__(self) -> None:
        self._cb: Optional[Callback] = None

    def on_partial(self, cb: Callback) -> None:
        self._cb = cb

    # Example adapters (pick ONE and implement; below are stubs to replace):
    def push_pcm16(self, pcm: bytes, sr: int) -> None:
        # If you use Google, AWS, Azure, Vosk, etc., feed pcm here and emit partials in their callbacks.
        pass

    def mock_feed(self) -> None:
        # Dev-only: emit fabricated Korean partials every ~500ms
        if not self._cb: return
        now = int(time.time() * 1000)
        self._cb(AsrPartial("오늘 예배에 처음 오신 분들을 위해", False, now-500, now, now))
        self._cb(AsrPartial("간단히 안내드리겠습니다", False, now, now+500, now+500))
        self._cb(AsrPartial("", True, now+500, now+500, now+500))