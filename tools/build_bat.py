"""Rebuild start-webui.bat from its UTF-8 source, encoded as GBK + CRLF.

Why this exists: cmd.exe parses a .bat file byte-by-byte against the active code
page. A UTF-8 file containing Chinese gets sliced mid-character and the script
falls apart in ways that look like random syntax errors ("'到可用的' is not
recognized as an internal or external command"). Even `chcp 65001` on the first
line does not save it. GBK (the default code page on Chinese Windows) does.

So: edit `start-webui.bat.utf8`, then run this. Never edit the .bat directly -
your editor will re-save it as UTF-8 and break it again.
"""

import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "start-webui.bat.utf8"
DST = ROOT / "start-webui.bat"

if not SRC.exists():
    raise SystemExit(f"missing source: {SRC}")

text = SRC.read_text(encoding="utf-8")
data = text.encode("gbk").replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
DST.write_bytes(data)
print(f"{DST.name}: {len(data)} bytes (GBK, CRLF)")
