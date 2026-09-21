#!/usr/bin/env python3
"""MCP server for reading a local image into the model's view.

Exposes one Claude Code tool:
  - read_image(image_path)

Why this exists
---------------
The model is multimodal, but the Read tool cannot surface a local image file to
it. This tool loads an image from disk and returns it as an MCP ImageContent
block — real pixels, not a text description. For a Claude model the proxy
forwards /api/v1/messages verbatim (native pass-through), so the image block in
the tool result reaches the model exactly like a pasted image. This preserves
full semantic detail (bit fields, arrow directions, small labels) that a
vision-to-text summary would lose.

Kept standalone (not merged into renesas-image) so it can migrate to aura-svcs
as one self-contained unit. Reads files from disk; the container mounts /data
and /home/dungnguyen, so pass the real on-disk path of the figure.
"""

from __future__ import annotations

import os
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.utilities.types import Image


mcp = FastMCP("renesas-vision")

# Anthropic rejects oversized images; keep a generous guard well under the limit.
MAX_IMAGE_BYTES = int(os.environ.get("RENESAS_VISION_MAX_BYTES", str(20 * 1024 * 1024)))

_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}


@mcp.tool()
def read_image(image_path: str) -> Image:
    """Load a local image file so the model can see it (returns real pixels).

    Use this to read a figure/diagram/screenshot when you have its file path
    (e.g. an image extracted from parsed documentation). The image is returned
    as an image block — the model sees the actual picture, just like a pasted
    image, so no visual detail is lost.

    Args:
        image_path: Absolute path to a local image file (PNG/JPEG/WebP/GIF/BMP).
            The file is read from disk inside the container (which mounts /data
            and /home/dungnguyen), so pass the real on-disk path of the figure.

    Returns:
        The image itself, for the model to view directly.
    """
    path = Path(os.path.expanduser(image_path))
    if not path.is_file():
        raise ValueError(f"image file not found: {path}")
    if path.suffix.lower() not in _IMAGE_EXTS:
        raise ValueError(
            f"unsupported image type '{path.suffix}'; expected one of "
            f"{sorted(_IMAGE_EXTS)}"
        )

    size = path.stat().st_size
    if size == 0:
        raise ValueError(f"image file is empty: {path}")
    if size > MAX_IMAGE_BYTES:
        raise ValueError(
            f"image is {size} bytes, over the {MAX_IMAGE_BYTES}-byte limit; "
            "resize or crop it before reading"
        )

    # FastMCP reads the bytes and emits a proper ImageContent (base64 + mimeType).
    return Image(path=path)


if __name__ == "__main__":
    mcp.run()
