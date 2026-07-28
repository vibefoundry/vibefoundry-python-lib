"""
Faithful rendering of Office documents, via LibreOffice.

Spreadsheets and presentations are the two formats a parser cannot fake. Reading
an .xlsx with openpyxl or SheetJS gets you the values and some cell styling, but
never the charts — they live in xl/charts/*.xml as chart definitions that only a
rendering engine can draw. So this shells out to LibreOffice, which is the only
free thing that actually renders these formats.

Two output shapes, chosen by what the format is:

  spreadsheets -> HTML   Continuous scroll, charts embedded as images. NOT pdf:
                         LibreOffice paginates spreadsheets by print area, so a
                         50k-row sheet becomes hundreds of pages and wide sheets
                         get sliced mid-table.
  presentations -> PDF   Here pages ARE slides, which is exactly the "scroll it
                         like a pdf" behaviour we want. Impress can emit HTML but
                         it produces a text outline with no slide images, so it
                         is useless for previewing.

LibreOffice is optional. Everything degrades to `available() is False` and the
caller falls back to its existing viewer rather than erroring.
"""

import base64
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional

# Formats we render, and what we render them to.
SPREADSHEET_EXTS = {".xlsx", ".xls", ".xlsm", ".ods"}
DOCUMENT_EXTS = {".pptx", ".ppt", ".odp", ".docx", ".doc", ".odt"}

# Rendering a genuinely enormous workbook can take minutes and produce an
# unusable wall of HTML; past this the caller keeps its existing data view.
MAX_RENDER_BYTES = 80 * 1024 * 1024


def _candidates() -> list[str]:
    """Where LibreOffice lives, per platform. Ordered most likely first."""
    if sys.platform == "darwin":
        return [
            "/Applications/LibreOffice.app/Contents/MacOS/soffice",
            str(Path.home() / "Applications/LibreOffice.app/Contents/MacOS/soffice"),
        ]
    if sys.platform == "win32":
        return [
            r"C:\Program Files\LibreOffice\program\soffice.exe",
            r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
            str(Path(os.environ.get("LOCALAPPDATA", "")) / r"Programs\LibreOffice\program\soffice.exe"),
        ]
    return ["/usr/bin/soffice", "/usr/bin/libreoffice", "/snap/bin/libreoffice"]


def find_soffice() -> Optional[str]:
    """The LibreOffice binary, or None. Checks PATH last — on Windows and macOS
    it is normally not on PATH at all, which is why the fixed locations come
    first rather than relying on the shell."""
    for c in _candidates():
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    for name in ("soffice", "libreoffice"):
        found = shutil.which(name)
        if found:
            return found
    return None


def available() -> bool:
    return find_soffice() is not None


def can_render(path: Path) -> bool:
    ext = path.suffix.lower()
    if ext not in SPREADSHEET_EXTS and ext not in DOCUMENT_EXTS:
        return False
    try:
        if path.stat().st_size > MAX_RENDER_BYTES:
            return False
    except OSError:
        return False
    return available()


def target_format(path: Path) -> str:
    return "html" if path.suffix.lower() in SPREADSHEET_EXTS else "pdf"


def _cache_dir() -> Path:
    d = Path.home() / ".vibefoundry" / "office-cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cache_key(path: Path, fmt: str) -> str:
    """Identity of a render: the file's path, size and mtime. Editing the source
    changes mtime, so a stale render can never be served."""
    st = path.stat()
    raw = f"{path.resolve()}|{st.st_size}|{int(st.st_mtime)}|{fmt}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _inline_images(html_path: Path) -> str:
    """Fold LibreOffice's sidecar images into the HTML as data: URIs.

    LibreOffice writes charts as separate .png files next to the .html. Inlining
    them makes the result a single self-contained string, which matters for two
    reasons: it can be handed straight to an iframe with no server route for the
    assets, and it renders inside a sandboxed pane, where a request for a
    sibling image file would never resolve.
    """
    html = html_path.read_text(encoding="utf-8", errors="replace")
    base = html_path.parent

    def repl(match: "re.Match") -> str:
        src = match.group(2)
        if src.startswith(("data:", "http:", "https:")):
            return match.group(0)
        asset = base / src
        try:
            blob = asset.read_bytes()
        except OSError:
            return match.group(0)  # missing asset: leave the tag as-is
        ext = asset.suffix.lower().lstrip(".") or "png"
        mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
        b64 = base64.b64encode(blob).decode("ascii")
        return f'{match.group(1)}data:{mime};base64,{b64}"'

    # src=" ... " on any tag, quote style preserved by rebuilding the prefix.
    return re.sub(r'(\ssrc=")([^"]+)"', repl, html, flags=re.IGNORECASE)


def render(path: Path) -> Optional[tuple[str, bytes]]:
    """Render `path`, returning (fmt, payload) or None if it can't be rendered.

    fmt is "html" (payload is UTF-8 encoded, self-contained) or "pdf" (raw
    bytes). Results are cached against the source's mtime, so reopening a file
    is instant; only the first view pays the ~2s LibreOffice startup.
    """
    soffice = find_soffice()
    if not soffice or not path.is_file():
        return None

    fmt = target_format(path)
    cached = _cache_dir() / f"{_cache_key(path, fmt)}.{fmt}"
    if cached.is_file():
        return fmt, cached.read_bytes()

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        # A private profile per run: concurrent headless invocations otherwise
        # contend for the default profile's lock and one of them fails.
        profile = tmpdir / "profile"
        cmd = [
            soffice,
            "--headless",
            "--norestore",
            f"-env:UserInstallation=file://{profile}",
            "--convert-to",
            fmt,
            "--outdir",
            str(tmpdir),
            str(path),
        ]
        try:
            subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=180,
                check=False,
            )
        except (subprocess.TimeoutExpired, OSError):
            return None

        produced = tmpdir / f"{path.stem}.{fmt}"
        if not produced.is_file():
            # LibreOffice reports conversion failures on stdout and still exits
            # 0, so the output file's existence is the only reliable signal.
            return None

        payload = (
            _inline_images(produced).encode("utf-8")
            if fmt == "html"
            else produced.read_bytes()
        )

    try:
        cached.write_bytes(payload)
    except OSError:
        pass  # cache is an optimisation, never a requirement
    return fmt, payload


def install_hint() -> str:
    """What to tell a user who has a renderable file but no LibreOffice."""
    if sys.platform == "darwin":
        return "Install LibreOffice from https://www.libreoffice.org/download/ to preview this file as it looks in Excel."
    if sys.platform == "win32":
        return "Install LibreOffice (winget install TheDocumentFoundation.LibreOffice) to preview this file as it looks in Excel."
    return "Install LibreOffice (e.g. apt install libreoffice) to preview this file as it looks in Excel."
