#!/usr/bin/env python3
"""Build build/icon-mac.png + build/icon.icns from build/icon-app.png.

macOS Dock squircle artwork sits at ~83.5% of the 1024 canvas (≈84px margin).
icon-app.png is full-bleed; without this pad the Dock tile looks a ring larger
than Safari/Terminal/Chrome.
"""
from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "build" / "icon-app.png"
MAC_PNG = ROOT / "build" / "icon-mac.png"
ICNS = ROOT / "build" / "icon.icns"
CANVAS = 1024
INNER = 856  # 84px margin each side

def main() -> int:
    try:
        from PIL import Image
    except ImportError:
        print("Pillow required: python3 -m pip install pillow", file=sys.stderr)
        return 1
    if not SRC.exists():
        print(f"missing {SRC}", file=sys.stderr)
        return 1
    src = Image.open(SRC).convert("RGBA")
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    scaled = src.resize((INNER, INNER), Image.Resampling.LANCZOS)
    off = (CANVAS - INNER) // 2
    canvas.paste(scaled, (off, off), scaled)
    canvas.save(MAC_PNG, "PNG")
    iconset = Path("/tmp/dsh-mac.iconset")
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    for name, px in {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }.items():
        im = canvas if px == CANVAS else canvas.resize((px, px), Image.Resampling.LANCZOS)
        im.save(iconset / name, "PNG")
    r = subprocess.run(["iconutil", "-c", "icns", "-o", str(ICNS), str(iconset)], capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr, file=sys.stderr)
        return r.returncode
    print(f"wrote {MAC_PNG} ({MAC_PNG.stat().st_size} bytes)")
    print(f"wrote {ICNS} ({ICNS.stat().st_size} bytes)")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
