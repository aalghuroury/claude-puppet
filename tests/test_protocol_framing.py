"""Round-trip tests for the length-prefixed JSON codec."""

from __future__ import annotations

import json
import struct

from server.protocol import FrameDecoder, encode


def test_encode_decode_roundtrip_simple_dict() -> None:
    obj = {"id": 1, "op": "ping", "args": {}}
    dec = FrameDecoder()
    frames = dec.push(encode(obj))
    assert frames == [obj]


def test_encode_decode_roundtrip_unicode_payload() -> None:
    obj = {"id": 2, "text": "héllo 🌍 — naïve\nresumé"}
    dec = FrameDecoder()
    frames = dec.push(encode(obj))
    assert frames == [obj]


def test_decoder_handles_split_chunks() -> None:
    # Push first 2 bytes of header, then the rest.
    obj = {"id": 3, "k": "v"}
    blob = encode(obj)
    dec = FrameDecoder()
    assert dec.push(blob[:2]) == []
    assert dec.push(blob[2:]) == [obj]


def test_decoder_handles_concatenated_frames() -> None:
    a = {"id": 4, "n": 1}
    b = {"id": 5, "n": 2}
    dec = FrameDecoder()
    frames = dec.push(encode(a) + encode(b))
    assert frames == [a, b]


def test_decoder_skips_malformed_json() -> None:
    # Hand-craft a frame whose payload is invalid UTF-8, then a valid frame after.
    bad_payload = b"\xff\xfe\xfd"
    bad_frame = struct.pack("<I", len(bad_payload)) + bad_payload
    good = {"id": 6, "ok": True}
    dec = FrameDecoder()
    frames = dec.push(bad_frame + encode(good))
    assert frames == [good]


def test_encoded_frames_match_struct_layout() -> None:
    obj = {"x": 1}
    blob = encode(obj)
    (length,) = struct.unpack("<I", blob[:4])
    assert length == len(blob) - 4
    assert blob[4:].decode("utf-8") == json.dumps(obj, separators=(",", ":"))
