# Hermes Agent — Port Native Termux ARMv7 (X98 Mini)

**Status:** ✅ SELESAI — Hermes berjalan native dan aktif via Telegram
**Tanggal:** 13–14 November 2026
**Target:** STB X98 Mini, Android TV 11 (SDK 30), Termux arm (armeabi-v7a / Bionic)
**Batasan yang dipatuhi:** tanpa PRoot, tanpa QEMU, tanpa dual boot, tanpa root, tanpa modifikasi firmware/eMMC

---

## 1. Ringkasan Eksekutif

Hermes Agent (open source, Python) berhasil dipasang dan dijalankan **native** di Termux ARM32/Bionic pada STB X98 Mini. Seluruh dependency C/Rust dikompilasi di perangkat (tidak ada wheel manylinux/arm64 yang dipakai). Hasil akhir: `hermes --version` berjalan, gateway Telegram aktif (polling), bot menjawab pesan.

| Metrik | Nilai |
|---|---|
| Python | 3.14.8 (Clang 21, Bionic) |
| ABI wheel | `android_30_armeabi_v7a` / `android_24_armeabi_v7a` |
| Hermes | vgit.4b40ffb (2026.9.24), OpenAI SDK 2.54.0 |
| Metode install | git clone + editable `pip install -e .` |
| Arsitektur build | native on-device (rust-std-armv7-linux-androideabi 1.99.1) |

---

## 2. Baseline Perangkat

| Item | Nilai |
|---|---|
| Android | 11 / SDK 30 |
| ABI aplikasi | armeabi-v7a, armeabi |
| uname | Linux 5.4.125 armv8l |
| CPU | ARM Cortex-A35 (0xD04) |
| dpkg arch | arm |
| Python platform tag | android-24-armeabi_v7a |
| SOABI | cpython-314-arm-linux-androideabi |
| RAM / swap | 3750 MB / 1875 MB |
| Termux | F-Droid 0.118.3 |

**Catatan penting:** CPU mendukung AArch64, tetapi firmware mengekspos ABI 32-bit saja. `uname -m` = `armv8l` — string inilah yang menjadi sumber beberapa bug portabilitas.

---

## 3. Toolchain

```
clang 21.1.8 + ndk-sysroot 30
rust 1.99.1 + rust-std-armv7-linux-androideabi 1.99.1
node v26.13.1
git 2.56.1, binutils 2.47, make, pkg-config, patchelf 0.19.3
```

---

## 4. Spike Kompatibilitas (3 tahap)

| Tahap | Cakupan | Hasil |
|---|---|---|
| A | 33 paket pure-Python (rich, jinja2, requests, httpx, dsb) | ✅ PASS — MarkupSafe 3.0.4 terkompilasi C di Bionic |
| B | pydantic 2.14.1 (+pydantic-core 2.50.1), cryptography 50.0.2, cffi 2.1.1 | ✅ PASS — semua Rust/C build on-device |
| C | fastapi 0.162.7, uvicorn 0.54, websockets 15.0.1, httptools, watchfiles 1.3.0, PyJWT, urllib3, Pillow 13.0.0 | ✅ PASS |

Dependency Hermes tambahan yang juga berhasil dibangun: `jiter 0.19.0`, `rpds-py 2026.9.1`, `firecrawl-anydoc 0.2.4`, `resvg-py 0.5.0`, `psutil` (git pin), `pillow-heif`, `browser-harness 0.1.13` (--no-deps), `python-telegram-bot[webhooks]==22.8`.

---

## 5. Tiga Akar Masalah & Solusinya

### 5.1 maturin menolak `armv8l`

**Gejala**
```
💥 maturin failed
  Caused by: Unsupported Android architecture: armv8l
```

**Sebab:** maturin membaca `uname()` dan hanya mengenali `armv7l`, `aarch64`, `i686`, `x86_64` (lihat `src/target/platform_tag.rs`).

**Solusi:** LD_PRELOAD shim yang mengganti `machine` menjadi `armv7l` **hanya untuk proses maturin** (mengganti global akan membuat `sysconfig` Python KeyError):

```c
#define _GNU_SOURCE
#include <dlfcn.h>
#include <string.h>
#include <unistd.h>
#include <limits.h>
#include <sys/utsname.h>
int uname(struct utsname *u){
  static int (*real)(struct utsname*);
  if(!real) real = dlsym(RTLD_NEXT, "uname");
  int r = real(u);
  char buf[PATH_MAX];
  ssize_t n = readlink("/proc/self/exe", buf, sizeof(buf)-1);
  if(n > 0){ buf[n] = 0; if(strstr(buf, "maturin")) strcpy(u->machine, "armv7l"); }
  return r;
}
```

Pemakaian:
```bash
clang -shared -fPIC -o ~/uname_fix.so ~/uname_fix.c
ANDROID_API_LEVEL=30 LD_PRELOAD=$HOME/uname_fix.so \
  pip install --no-build-isolation <paket>
```

### 5.2 Modul abi3 gagal import (`PyExc_*` tidak ditemukan)

**Gejala**
```
ImportError: dlopen failed: cannot locate symbol "PyExc_ValueError" referenced by _rust.abi3.so
```

**Sebab:** maturin tidak me-link cdylib abi3 ke libpython (pyo3 #1082); linker Android mewajibkan link eksplisit.

**Solusi** (mengikuti `termux-packages/packages/python-cryptography/build.sh`):
```bash
patchelf --add-needed libpython3.14.so <path>/<modul>.abi3.so
# massal:
for f in $(find ~/venv-hermes/lib/python3.14/site-packages -name "*.abi3.so"); do
  patchelf --add-needed libpython3.14.so "$f"
done
```

### 5.3 Patch portabilitas di source Hermes

| File | Masalah | Patch |
|---|---|---|
| `pm/store.py` | `current_target()` hanya kenal arm64/x64 → RuntimeError saat wizard | tambah `armv7l/armv8l/armv7/armhf/arm → arch="arm"` |
| `hermes_platform/host/facts.py` | `_ARCH_NAMES` tanpa entri ARM32 → `normalize_arch()` = "unknown" | tambah `"armv7l"/"armv8l"/"armv7"/"armhf"/"arm" → "arm"` |
| `gateway/platforms/helpers.py` | fallback `os.link()` tidak ada di Python Android | ganti `os.link(temporary, path)` → `os.replace(temporary, path)` |

Konsekuensi yang diterima (jujur): fitur browser otomatis nonaktif karena **tidak ada Chromium ARM32** — Hermes mendeteksi "tidak tersedia" dan lanjut normal.

---

## 6. Urutan Install yang Terbukti

```bash
# 0. venv & toolchain (lihat §3)
python -m venv ~/venv-hermes && source ~/venv-hermes/bin/activate
pkg install binutils make pkg-config patchelf libheif
pip install --upgrade "maturin>=1.10,<2" setuptools wheel pybind11

# 1. dependency dasar (Rust/C) — satu per satu agar granular
ANDROID_API_LEVEL=30 LD_PRELOAD=$HOME/uname_fix.so pip install --no-build-isolation pydantic==2.14.1
ANDROID_API_LEVEL=30 LD_PRELOAD=$HOME/uname_fix.so pip install --no-build-isolation cffi==2.1.1
ANDROID_API_LEVEL=30 LD_PRELOAD=$HOME/uname_fix.so pip install --no-build-isolation cryptography==50.0.2
ANDROID_API_LEVEL=30 LD_PRELOAD=$HOME/uname_fix.so pip install --no-build-isolation jiter==0.19.0
ANDROID_API_LEVEL=30 LD_PRELOAD=$HOME/uname_fix.so pip install --no-build-isolation rpds-py
ANDROID_API_LEVEL=30 LD_PRELOAD=$HOME/uname_fix.so pip install --no-build-isolation firecrawl-anydoc==0.2.4
ANDROID_API_LEVEL=30 LD_PRELOAD=$HOME/uname_fix.so pip install --no-build-isolation resvg-py==0.5.0

# 2. runtime web/gambar
ANDROID_API_LEVEL=30 LD_PRELOAD=$HOME/uname_fix.so pip install --no-build-isolation "httptools==0.8.0"
pip install -q openai==2.54.0 certifi==2026.10.19 fastapi uvicorn websockets PyJWT
ANDROID_API_LEVEL=30 LD_PRELOAD=$HOME/uname_fix.so pip install --no-build-isolation Pillow==13.0.0

# 3. Hermes
git clone --depth 1 https://github.com/NousResearch/hermes-agent
cd hermes-agent && pip install --no-build-isolation --no-deps -e .

# 4. Telegram + opsional
pip install -q "python-telegram-bot[webhooks]==22.8"
ANDROID_API_LEVEL=30 LD_PRELOAD=$HOME/uname_fix.so pip install --no-build-isolation "pillow-heif>=1.4.0,<2"
pip install -q cdp-use==1.4.5 fetch-use==0.4.0 && pip install --no-deps browser-harness==0.1.13

# 5. patchelf massal
for f in $(find ~/venv-hermes/lib/python3.14/site-packages -name "*.abi3.so"); do
  patchelf --add-needed libpython3.14.so "$f"
done

hermes --version
```

---

## 7. Operasional

```bash
hermes setup            # konfigurasi provider (OpenRouter free) + Telegram
hermes gateway          # gateway Telegram (polling)
```

Autostart (`~/.bashrc`):
```bash
termux-wake-lock 2>/dev/null
if ! tmux has-session -t hermes 2>/dev/null; then
  tmux new -d -s hermes 'source ~/venv-hermes/bin/activate && hermes gateway'
fi
```

---

## 8. Catatan Kejujuran / Batasan

- `nemo_relay` tidak di-install (extra opsional) → warning saat runtime, tidak memengaruhi fungsi.
- `browser-harness` terpasang tetapi tidak berguna di STB: butuh Chrome desktop via CDP.
- `pip check` melaporkan "not supported on this platform" untuk wheel buatan sendiri — false positive karena pip tidak mengenal tag `android_*`; semua sudah diverifikasi dengan import-test.
- Pillow ditahan di 13.0.0 (bukan 12.3.0 yang diminta browser-harness) demi stabilitas Hermes.
- Build Rust besar di armv7 memakan 10–30 menit; RAM 3,7 GB + swap sangat mepet — jangan interrupt.
- RE (Ghidra/ghidrust) tidak dipakai untuk porting ini karena source tersedia; perkakas itu disiapkan untuk kebutuhan binary tertutup di masa depan.

---

## 9. Verifikasi Akhir

```
$ hermes --version
Hermes Agent vgit.4b40ffb (2026.9.24) · stable · local 4b40ffb0ad6d
Python: 3.14.8
OpenAI SDK: 2.54.0

$ hermes gateway
[Telegram] Connected to Telegram (polling mode)
# bot menjawab pesan dari HP ✅
```

---

## 10. Rujukan

- Hermes Agent — https://github.com/NousResearch/hermes-agent
- termux-packages (build.sh python-cryptography, PR #31042 hermes-agent) — https://github.com/termux/termux-packages
- maturin `src/target/platform_tag.rs` (daftar arch Android)
- pyo3 issue #1082 (abi3 tidak link libpython)
