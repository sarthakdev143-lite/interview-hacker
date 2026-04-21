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

a = Analysis(
    ["server.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "PIL", "cv2"],
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
    console=True,
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
