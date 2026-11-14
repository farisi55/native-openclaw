# OpenCode Prompt Pack — Hermes Agent Native Termux ARMv7 / X98 Mini

Paket prompt ini dibuat untuk dikerjakan bertahap di OpenCode. Jalankan satu prompt, review hasilnya, lalu lanjut ke prompt berikutnya. Jangan menggabungkan semua tahap menjadi satu permintaan implementasi besar.

## 0. Setup REA di OpenCode (dijalankan di PC development)

REA adalah MCP reverse-engineering toolkit yang berjalan pada komputer development dan terhubung ke OpenCode. Tidak perlu memasang REA di STB sebagai syarat Hermes runtime.

Pastikan Node.js memenuhi requirement REA (Node 22.23.4+, 24.22.1+, atau 26.12.1+). Jalankan di komputer development:

```bash
node --version
npm --version
npx -y rea-agents@latest setup --client opencode
```

Review perubahan konfigurasi yang ditawarkan REA, setujui hanya perubahan yang memang diinginkan, lalu restart/reconnect OpenCode. Di OpenCode, pastikan MCP server REA muncul dan tool catalog tersedia. Bila REA tidak terhubung, jangan pura-pura memakai REA: perbaiki koneksi atau lanjutkan hanya dengan source/command evidence yang tersedia.

Docs: https://github.com/morluto/rea/blob/main/docs/getting-started/installation.md

## 1. MASTER PROMPT — aturan kerja proyek

```text
Anda adalah senior Python/Android-Bionic/Termux systems engineer dan maintainer portabilitas software. Tugas proyek adalah membuat Hermes Agent dapat berjalan native pada X98 Mini saya melalui Termux ARM32 (armeabi-v7a/Bionic), tanpa proot-distro, proot, QEMU, Debian/Ubuntu rootfs, dual boot, root, atau modifikasi firmware/eMMC.

Target facts awal:
- Device: X98 Mini, Android 11 / SDK 30
- board platform: s4; hardware: ap201; compatible: amlogic,s4
- Android ABI: armeabi-v7a,armeabi
- Termux dpkg architecture: arm
- uname: armv8l; CPU part: 0xD04 (ARM Cortex-A35)
- RAM terdeteksi sekitar 3.84 GB
- Ethernet tersedia, 100 Mbps
- Termux F-Droid 0.118.3
- inventory package terakhir mencatat Python Termux 3.14.8 arm; verifikasi ulang runtime aktual

Repo utama: https://github.com/NousResearch/hermes-agent
Reverse-engineering toolkit: https://github.com/morluto/rea
PRD: docs/PRD-Hermes-Termux-ARMv7-X98-Mini.md

ATURAN WAJIB:
1. Baca PRD sampai selesai sebelum mengubah kode.
2. Gunakan REA MCP tool yang benar-benar tersedia untuk inspeksi ADB, Android runtime, APK/ELF/binary. Periksa tool catalog dan schema aktual; jangan mengarang nama tool atau hasil.
3. REA adalah alat evidence/reverse-engineering, bukan compiler, emulator, atau runtime Hermes. Jalankan REA/MCP dari komputer development/OpenCode. Jangan menginstal REA ke STB sebagai ketergantungan Hermes.
4. Bedakan tiga arsitektur: CPU capability, Android app ABI, dan Termux package architecture. Jangan menyimpulkan AArch64 runtime dari CPU Cortex-A35.
5. Jangan menyamakan Termux `arm`/Android `armeabi-v7a` dengan Debian `armhf`/glibc. Target adalah Android Bionic.
6. Hermes upstream saat ini mendokumentasikan Termux AArch64 saja dan menyebut non-AArch64 unsupported. Jadikan ARMv7 ini sebagai experimental fork/port, bukan klaim support resmi.
7. Jangan menggunakan `install.sh` desktop/server atau APT package AArch64 upstream untuk target ARM32.
8. Jangan memakai PRoot/QEMU bahkan sebagai fallback runtime pada perangkat. Build tools di workstation/CI boleh memakai toolchain lintas-platform, tetapi hasil akhir yang diuji di STB harus native ARM32/Bionic.
9. Jangan menghapus atau mereset Android TV, jangan mengubah bootloader/eMMC, jangan meminta root.
10. Jangan mengubah upstream source sebelum discovery dan feasibility spike disetujui. Pertahankan ARM64 build path existing.
11. Setiap klaim harus diklasifikasikan sebagai FACT, INFERENCE, atau UNKNOWN dan disertai path/line, command output, hash, atau sumber URL.
12. Jangan menginstal semua optional dependency. Buat dependency matrix, mulai dari minimum core. Optional yang tidak kompatibel harus di-disable dengan error yang jelas.
13. Jangan menyembunyikan error dengan menonaktifkan TLS, checksum, signature validation, atau package verification.
14. Semua command target-device harus ditinjau sebelum dijalankan. Jangan menjalankan destructive command.
15. Setelah setiap fase, tulis laporan Markdown, hasil test, unresolved questions, dan rekomendasi lanjut/stop.

Mulai dengan membaca PRD dan melakukan repository reconnaissance saja. Jangan mengedit file atau menginstal package pada STB pada tahap ini.
```

## 2. PROMPT — Hubungkan REA dan verifikasi kemampuan investigasi

```text
Baca PRD dan MASTER PROMPT. Sekarang verifikasi setup REA pada OpenCode.

Langkah:
1. Periksa MCP server/tool list REA yang benar-benar tersedia dalam sesi ini.
2. Identifikasi tool REA yang relevan untuk:
   - ADB device discovery dan device properties;
   - installed packages, process list, logcat, service/features;
   - APK metadata/signature/decompiled source bila diperlukan;
   - ELF header, sections, notes, DT_NEEDED/imports/hardening dan binary inspection.
3. Periksa apakah OpenCode tersambung ke REA server lokal, bukan hanya memiliki skill text.
4. Tulis `docs/REA-INVESTIGATION-PLAN.md` berisi tool yang tersedia, prerequisites, tool yang memerlukan JADX/JDK atau Hopper/Ghidra/IDA/Kuna, dan fallback manual.
5. Jika ADB belum siap, berikan instruksi minimum menyiapkan `adb` di komputer development dan mengaktifkan debugging pada Android TV. Jangan mengasumsikan serial/IP/port. Jangan melakukan perubahan ke STB.

Batasan REA: REA tidak memasang ADB device service atau emulator; gunakan caller-supplied adb. Static APK analysis tidak membuktikan runtime behavior. Native pseudocode analysis memerlukan provider engine. Jangan menyatakan investigasi berhasil bila tool/provider tidak tersedia.

Output: laporan dan checklist, tanpa perubahan ke Hermes source.
```

## 3. PROMPT — Device baseline & runtime fingerprint

```text
Lakukan fase device baseline. Jangan install package baru atau mengubah konfigurasi perangkat.

A. Jika ADB REA tersedia, gunakan tool yang sesuai untuk membaca device properties, OS/API, package inventory, process list, logcat yang relevan, storage, dan network interfaces. Sertakan bukti mentah/summary REA serta batasannya.

B. Minta/siapkan command read-only untuk dijalankan di Termux jika data belum tersedia:

```bash
getprop ro.build.version.release
getprop ro.build.version.sdk
getprop ro.product.model
getprop ro.product.cpu.abi
getprop ro.product.cpu.abilist
getprop ro.board.platform
getprop ro.hardware
uname -a
getconf LONG_BIT
dpkg --print-architecture
python -VV
python - <<'PY'
import ctypes, platform, sys, sysconfig
print('sys.version=', sys.version)
print('sys.platform=', sys.platform)
print('platform.machine=', platform.machine())
print('platform.architecture=', platform.architecture())
print('pointer_bits=', ctypes.sizeof(ctypes.c_void_p) * 8)
print('sysconfig_platform=', sysconfig.get_platform())
print('SOABI=', sysconfig.get_config_var('SOABI'))
print('MULTIARCH=', sysconfig.get_config_var('MULTIARCH'))
PY
python -m pip debug --verbose
command -v node && node --version && node -p 'JSON.stringify({platform:process.platform,arch:process.arch,version:process.version})'
command -v clang; command -v rustc; command -v pkg-config
```

C. Catat ukuran storage/RAM saat baseline dan semua binary path yang akan dipakai. Gunakan `file`/`readelf` bila tersedia, atau minta outputnya.

D. Jangan menafsirkan `uname -m=armv8l` sebagai 64-bit. Verifikasi `ELF class`, pointer width, Python SOABI, Android ABI dan Termux architecture secara terpisah.

Simpan hasil sebagai `docs/DEVICE-BASELINE.md` dengan FACT/INFERENCE/UNKNOWN. Jangan coding.
```

## 4. PROMPT — Audit Hermes upstream khusus Termux/ARM32

```text
Lakukan audit source code Hermes upstream. Gunakan branch/commit yang dicatat dalam laporan, jangan hanya mengandalkan README.

Telusuri minimal:
- pyproject.toml: requires-python, dependency markers, optional extras, platform markers;
- uv.lock/PM lock, pm/*, dependency bootstrap dan package manager;
- scripts/termux/*, scripts/termux/build_config.sh, build_cpython.py, build_node.sh, build_wheels.py, build_deb.sh, payload_facts.py, python_linkage.py, runtime libs;
- Termux docs, Android platform detection, psutil_android.py, terminal/process handling, home/prefix paths;
- Python modules yang memakai native extensions atau libc/glibc assumptions;
- `hermes --help`, `hermes setup`, CLI/TUI entrypoints, gateway, memory/session/SQLite, file tools, terminal tools;
- tests/compat, tests/termux, release/CI workflow Termux.

Cari semua hard-coded AArch64 assumptions: `aarch64`, `arm64`, `arm64-v8a`, `linux-arm64-bionic`, `binary-aarch64`, `_aarch64.deb`, `android_24_arm64_v8a`, CPU markers, wheel tags, native wheel names, linker paths, runtime library lists.

Buat `docs/UPSTREAM-TERMUX-AUDIT.md` berisi:
1. jalur install resmi hari ini dan statusnya;
2. apa yang dibundel di AArch64 package;
3. build graph dan artefact target;
4. file/line yang mengunci AArch64;
5. kode yang sudah punya Android/Termux path dan yang belum;
6. dependency yang mungkin tidak dapat di-build ARMv7;
7. patch surface minimal untuk target ARM32;
8. compatibility risk dan test yang harus ditambah.

Gunakan REA untuk inspeksi ELF/native artifacts yang tersedia dan ADB untuk device facts jika memungkinkan. Jangan mengubah kode pada fase audit.
```

## 5. PROMPT — Dependency compatibility matrix & feasibility spike

```text
Fase ini menentukan apakah port ARM32 layak. Jangan implementasikan installer penuh.

Buat `docs/DEPENDENCY-COMPATIBILITY.md` dengan satu baris untuk setiap direct dependency core dan optional dependency Hermes. Kolom wajib:
- package/version;
- core atau optional extra;
- pure Python atau native extension;
- native libraries/system headers;
- apakah ada wheel yang cocok dengan tag yang dilaporkan Python Termux;
- apakah source build pada Android/Bionic ARMv7 realistis;
- toolchain/paket Termux yang dibutuhkan;
- status: PASS / BUILD_REQUIRED / PATCH_REQUIRED / OPTIONAL_DISABLE / BLOCKER;
- bukti (pip debug, wheel tags, ELF facts, source link, command log).

Uji terpisah, dengan Python/ABI target nyata:
1. dependency pure Python;
2. native core yang paling kritis (misalnya pydantic-core, cryptography, httptools/watchfiles, Pillow jika core memerlukannya, SQLite/native DB jika ada);
3. Node/npm/TUI dependencies bila memang dipanggil pada startup atau CLI;
4. `uv` versus `pip` pada Android ARM32 wheel tags; jangan menganggap resolver keduanya identik.

Gunakan PEP 738 wheel naming hanya jika Python runtime memang mengeluarkan Android tags yang cocok. Validasi dengan `python -m pip debug --verbose`. Jangan memaksa `manylinux_armv7l` pada Bionic dan jangan retag wheel tanpa verifikasi ABI/linkage.

Lakukan vertical spike minimum di STB:
- import Python stdlib + dependency pure Python;
- import/test dependency native satu per satu;
- verifikasi ELF32 ARM dan DT_NEEDED untuk setiap `.so`;
- tes HTTPS/TLS ke endpoint test;
- tes SQLite/session storage;
- tes CLI import Hermes dengan dependency set minimum.

Jangan memasang semua optional extras. Jangan menjalankan QEMU/PRoot. Jangan menghapus package sistem.

Output wajib:
- `docs/DEPENDENCY-COMPATIBILITY.md`;
- `docs/FEASIBILITY-REPORT.md`;
- rekomendasi GO / CONDITIONAL GO / NO-GO;
- daftar blocker paling kecil yang perlu ditangani untuk MVP.

Jika ada dependency core yang tidak dapat disediakan native dan tidak ada substitusi yang aman, STOP dan laporkan blocker; jangan pura-pura menyatakan port berhasil.
```

## 6. PROMPT — Finalize architecture dan implementation plan (tanpa coding)

```text
Berdasarkan DEVICE-BASELINE, UPSTREAM-TERMUX-AUDIT, dan FEASIBILITY-REPORT, susun desain implementasi final.

Persyaratan desain:
- target native Termux ARM32/Bionic saja;
- jalur AArch64 upstream tidak berubah;
- jangan menggunakan proot/QEMU di perangkat;
- gunakan Termux Python native jika lulus; jika tidak, jelaskan rencana build CPython ARMv7 Bionic;
- buat dependency profile/lock khusus yang reproducible;
- definisikan feature gates untuk browser, voice, wake-word, Docker, Nemo Relay, dan semua fitur native yang gagal;
- definisikan installer/update/uninstall yang hanya menulis di `$PREFIX` dan `$HOME`;
- konfigurasi provider dan data tidak ditimpa saat update;
- tidak memakai `sudo`, root, FHS `/usr`, systemd, atau glibc assumptions;
- tidak mengubah APT source resmi Hermes AArch64 untuk menipu architecture.

Buat:
- `docs/ARCHITECTURE.md`;
- `docs/IMPLEMENTATION-PLAN.md`;
- daftar file yang diubah;
- build graph;
- release/rollback design;
- test plan (unit, integration, physical device);
- acceptance criteria per milestone.

Tunjukkan tepatnya bagian upstream yang dapat direuse dan bagian yang memerlukan patch. Jangan mulai coding sebelum plan ini selesai dan direview.
```

## 7. PROMPT — Implementasi bertahap (aktifkan hanya setelah feasibility GO)

```text
Mulai implementasi hanya berdasarkan `docs/IMPLEMENTATION-PLAN.md` yang sudah disepakati.

Aturan:
1. Buat branch fork terpisah, misalnya `feature/termux-armv7-bionic`. Jangan commit ke upstream remote.
2. Lakukan perubahan terkecil dan pisahkan commit per tahap.
3. Tambahkan target ARMv7/Bionic terpisah; jangan mengubah artifact/target AArch64 yang sudah ada.
4. Tambahkan preflight/doctor yang memverifikasi Android ABI, Termux `dpkg arch`, Python platform/ABI, pointer width, API level, prefix dan storage.
5. Tambahkan dependency profile khusus berdasarkan hasil spike, exact pins dan hashes. Tidak boleh ada dependency yang “hilang diam-diam” karena marker Python.
6. Bangun atau siapkan native wheels sebagai ELF32 ARM/Bionic; periksa `DT_NEEDED`, symbols, Android API level, shared libraries. Jangan gunakan wheel glibc.
7. Pertahankan Hermes application code upstream sejauh mungkin. Isolasi perubahan platform dalam module/adapter yang kecil.
8. Implementasikan fallback graceful untuk fitur yang unsupported; tool list/doctor harus memberi alasan yang jelas.
9. Tambahkan installer, launcher, update, rollback, uninstaller yang hanya menyentuh `$PREFIX`/`$HOME`.
10. Jangan memasukkan QEMU/PRoot/containers atau binary AArch64 ke package ARM32.
11. Tulis tests terlebih dahulu untuk tiap bug/compatibility branch.
12. Setelah setiap patch: jalankan unit tests terkait, lint/type check, dependency check, build ARM32, lalu physical smoke test jika menyentuh runtime.

Jangan menghapus upstream code/feature kecuali feature gate yang direncanakan. Jangan mengubah Android TV. Jika build membutuhkan patch C/Rust, sertakan rationale, target triple, compiler flags, link flags, ABI proof, dan reproducible build steps.
```

## 8. PROMPT — Installer, lifecycle dan security validation

```text
Audit dan sempurnakan installer/lifecycle Termux ARM32.

Verifikasi:
- target `dpkg --print-architecture` harus `arm`, Android ABI harus `armeabi-v7a`;
- prefix harus Termux standard `$PREFIX`; tolak package rename/custom prefix yang belum diuji;
- tidak membutuhkan root;
- tidak menulis ke `/system`, `/vendor`, bootloader, eMMC, atau partisi Android TV;
- tidak menjalankan proot, proot-distro, qemu, docker, atau glibc runtime;
- semua downloaded artefacts diverifikasi hash/signature;
- config/API keys dipertahankan dan tidak masuk log/history;
- install/uninstall idempotent dan tidak menghapus user data kecuali pengguna secara eksplisit memilih purge;
- update bisa rollback ke versi sebelumnya;
- cache/log memiliki batas storage;
- Android background process limit dijelaskan, tanpa klaim 24/7 guarantee.

Tambahkan tests untuk install, upgrade, interrupted install, permission failure, low storage, architecture mismatch, missing native library, uninstall keep-data, uninstall purge, dan rollback.

Buat `docs/INSTALL-TERMUX-ARMV7.md` dengan langkah nyata yang cocok dengan hasil test. Jangan menulis instruksi yang belum berhasil diverifikasi di STB.
```

## 9. PROMPT — Physical device acceptance test (X98 Mini)

```text
Lakukan final acceptance test hanya pada X98 Mini fisik, bukan hanya CI/x86_64 emulator.

Sebelum test, catat exact Hermes commit, package version/hash, Termux version, Android build, ABI, Python/Node version, available RAM/storage dan network mode.

Test cases:
1. Preflight mengidentifikasi ARM32/Bionic dengan benar.
2. Tidak ada dependency `proot-distro`, `proot`, `qemu-user-aarch64`, Debian rootfs, atau Ubuntu rootfs.
3. `file`/`readelf` memastikan semua ELF native yang digunakan adalah ARM32 dan linked terhadap Bionic/Termux libs yang benar.
4. `hermes --version`, `hermes --help`, `hermes doctor`.
5. Setup provider, API connectivity, TLS, streaming response, timeout/retry.
6. Chat sederhana dan minimal satu tool file, satu tool terminal yang diizinkan.
7. Session/memory persistence setelah Hermes dihentikan dan dimulai ulang.
8. TUI keyboard/terminal rendering pada Android TV; jika tidak lulus, verifikasi CLI fallback.
9. Error behavior saat internet putus atau LLM API gagal.
10. Storage/RSS/startup/cold start dan temperatur/CPU saat chat.
11. Android TV launcher/streaming masih normal setelah install, update, dan uninstall.
12. Pastikan uninstall biasa tidak menghapus `~/.hermes` user data kecuali opsi purge eksplisit.

Gunakan REA ADB tools bila device tersambung. Sertakan raw evidence, logcat yang relevan, binary hash dan tool schema. Jangan mengubah sistem Android untuk membuat test lulus.

Output: `docs/PHYSICAL-DEVICE-TEST-REPORT.md` dengan PASS/FAIL/BLOCKED untuk setiap test, bukti, dan rekomendasi release.
```

## 10. PROMPT — Dokumentasi release dan upstream contribution

```text
Siapkan dokumentasi release setelah acceptance test fisik lulus.

Buat:
- README target Termux ARMv7;
- install/update/uninstall/recovery steps;
- supported feature matrix;
- known limitations dan troubleshooting;
- dependency build provenance dan hashes;
- tested device matrix (jangan mengklaim perangkat selain X98 Mini AP201 yang benar-benar diuji);
- instructions untuk memilih AArch64 upstream official vs experimental ARMv7 fork;
- daftar commit/patch yang dapat diajukan upstream dan bagian yang memang fork-specific.

Jangan mengklaim official Hermes support. Tulis bahwa ini experimental community port sampai maintainer Hermes menerima perubahan. Jangan merilis binary yang belum diuji pada target fisik.
```

---

## Urutan eksekusi

| Urutan | Prompt | Output / keputusan |
|---|---|---|
| 0 | Setup REA di OpenCode | REA MCP tersedia dan tersambung |
| 1 | Master prompt | Aturan proyek tersimpan |
| 2 | REA readiness | `docs/REA-INVESTIGATION-PLAN.md` |
| 3 | Device baseline | `docs/DEVICE-BASELINE.md` |
| 4 | Hermes source audit | `docs/UPSTREAM-TERMUX-AUDIT.md` |
| 5 | Feasibility spike | `docs/DEPENDENCY-COMPATIBILITY.md` + GO/NO-GO |
| 6 | Architecture plan | `docs/ARCHITECTURE.md` + `docs/IMPLEMENTATION-PLAN.md` |
| 7 | Implementasi | patch dan tests bertahap |
| 8 | Installer/security | installer/update/uninstall yang aman |
| 9 | Physical acceptance | `docs/PHYSICAL-DEVICE-TEST-REPORT.md` |
| 10 | Release docs | dokumentasi eksperimen dan upstream contribution |

**STOP condition:** Jika dependency core penting tidak dapat dibangun/di-load native ARM32 Bionic, hentikan implementasi penuh dan laporkan blocker. Jangan mengganti target secara diam-diam ke ARM64, PRoot, QEMU, atau Debian ARMHF.
