"""Bounded identity-only projection for root and public plugin manifests."""
from __future__ import annotations

import json
import math

MAX_MANIFEST_BYTES = 512 * 1024


def manifest_projection(raw: bytes) -> dict[str, object]:
    if len(raw) > MAX_MANIFEST_BYTES:
        return {"state": "over_limit"}
    try:
        value = json.loads(raw.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"state": "invalid_json"}
    if not isinstance(value, dict):
        return {"state": "not_json_object"}
    projection: dict[str, object] = {"state": "valid_json_object"}
    for source, target in (("name", "declaredName"), ("version", "declaredVersion"),
                           ("main", "declaredMain"), ("preload", "declaredPreload")):
        item = value.get(source)
        if isinstance(item, str):
            try:
                valid_string = (len(item.encode("utf-8", errors="strict")) <= 4096
                                and not any(ord(c) < 0x20 for c in item))
            except UnicodeEncodeError:
                valid_string = False
            projection[target] = item if valid_string else {"state": "unsupported_or_over_limit"}
        elif (isinstance(item, int) and not isinstance(item, bool)
              and source == "version" and item.bit_length() <= 256):
            projection[target] = item
        elif (isinstance(item, float) and source == "version" and math.isfinite(item)):
            projection[target] = item
        elif item is not None:
            projection[target] = {"state": "unsupported_or_over_limit"}
    return projection
