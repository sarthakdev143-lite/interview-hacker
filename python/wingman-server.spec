import sys
from PyInstaller.utils.hooks import collect_all

block_cipher = None

datas = []
binaries = []
hiddenimports = [
    "flask",
    "flask_cors",
    "werkzeug",
    "werkzeug.serving",
    "groq",
    "httpx",
    "httpx._transports",
    "anyio",
    "anyio._backends._asyncio",
    "fitz",
    "pymupdf",
    "sounddevice",
    "numpy",
    "cffi",
    "_cffi_backend",
]

for pkg in ["groq", "httpx", "anyio", "flask", "flask_cors", "certifi"]:
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

if sys.platform == "win32":
    hiddenimports += ["pyaudiowpatch"]

# Nothing under python/ imports any of these. PyInstaller follows deferred
# imports through pymupdf and numpy and pulls in ~21MB of dead weight:
#
#   pymupdf/table.py      -> pandas -> dateutil, tzdata, psycopg
#   pymupdf/__init__.py   -> fontTools.subset -> zopfli
#   numpy/__config__.py   -> yaml
#
# Worse, whether they are bundled at all depends on what happens to be
# installed in the build environment, so installer size was not reproducible.
# Excluding them makes it deterministic. `fitz`/`pymupdf` still work: the
# pandas path is only `Page.to_pandas()` and the fontTools path is only font
# subsetting, neither of which resume_parser touches.
DEAD_WEIGHT = [
    "pandas",
    "psycopg",
    "psycopg_binary",
    "fontTools",
    "zopfli",
    "yaml",
    "dateutil",
    "tzdata",
    "IPython",
    "pytest",
    "setuptools",
]

a = Analysis(
    ["server.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "PIL", "cv2", *DEAD_WEIGHT],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="wingman-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="wingman-server",
)
