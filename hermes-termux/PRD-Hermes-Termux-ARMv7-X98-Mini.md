# PRD — Hermes Agent Native Termux ARMv7 untuk X98 Mini

**Versi:** 1.0  
**Tanggal:** 12 November 2026  
**Status:** Draft untuk discovery dan feasibility spike  
**Target implementasi:** Fork/patch kompatibilitas dari `NousResearch/hermes-agent`  
**Tool investigasi:** REA — Reverse Engineer Anything (`morluto/rea`) melalui OpenCode MCP

---

## 1. Ringkasan

Membangun jalur instalasi eksperimental **Hermes Agent yang berjalan langsung di Termux Android 11 ARM32 (armeabi-v7a / Bionic)** pada STB X98 Mini, tanpa `proot-distro`, tanpa QEMU, tanpa dual boot, tanpa root, dan tanpa mengubah firmware atau partisi eMMC Android TV.

REA digunakan dari komputer development melalui OpenCode untuk membantu investigasi source code Hermes, inspeksi ELF/shared library, dan pengumpulan bukti runtime Android melalui ADB. REA bukan runtime Hermes, bukan emulator, dan tidak mengubah binary ARM64 menjadi ARM32.

Pendekatan yang diutamakan adalah **port minimal dan terukur**, bukan menyalin atau menulis ulang Hermes. Gunakan source upstream Hermes sebagai basis, pertahankan perubahan sekecil mungkin, lalu tambahkan target Termux ARMv7/Bionic serta dependency/build profile yang sesuai.

## 2. Latar belakang dan masalah

X98 Mini saat ini menjalankan Android TV 11. Perangkat memiliki CPU ARMv8 yang secara hardware mendukung AArch64, tetapi firmware Android yang sedang dipakai mengekspos ABI aplikasi 32-bit saja. Karena itu Termux berjalan sebagai `arm`, bukan `aarch64`.

Paket Hermes Termux upstream yang ditemukan saat penyusunan PRD ditujukan untuk Android `aarch64` dan wheel `android_24_arm64_v8a`. Dokumentasi upstream menyebut non-AArch64 Android/Termux sebagai platform unsupported. Panduan Termux upstream juga memberi peringatan bahwa paket Termux sedang mengalami masalah dan fix sedang dikerjakan. Oleh sebab itu, jangan menganggap paket AArch64 resmi dapat dipasang pada STB ini.

Eksperimen terdahulu melalui Debian ARMHF, Debian ARM64 + PRoot, dan QEMU menunjukkan bahwa jalur emulasi menambah kompleksitas, konsumsi resource, dan masalah proses turunan. Target produk ini adalah menghindari semua komponen tersebut pada STB.

## 3. Sasaran produk

1. Menjalankan Hermes Agent native di Termux ARM32/Bionic.
2. Memakai kemampuan CPU ARMv7/AArch32 yang tersedia pada Android userspace saat ini; jangan menjalankan ELF AArch64.
3. Menggunakan Python native Termux/Android yang tervalidasi, dengan target runtime Python 3.14 jika kompatibilitas aktual perangkat terbukti.
4. Menjalankan percakapan dengan LLM melalui API cloud; bukan menjalankan LLM besar secara lokal.
5. Menyediakan subset fitur inti yang stabil: CLI/TUI yang layak, provider setup, chat, konfigurasi, memory/session dasar, file tools dan terminal tools yang berjalan langsung di lingkungan Termux.
6. Menyimpan seluruh aplikasi dan data di direktori milik Termux (`$PREFIX` dan `$HOME`), tanpa memodifikasi Android TV.
7. Menggunakan REA dari OpenCode sebagai sarana investigasi dan evidence capture.

## 4. Bukan sasaran (Non-goals)

- Tidak mengubah firmware Android, bootloader, DTB, kernel, atau partisi eMMC.
- Tidak melakukan root.
- Tidak memasang atau menjalankan `proot-distro`, `proot`, `qemu-aarch64`, QEMU system emulation, Debian rootfs, atau Ubuntu rootfs pada target final.
- Tidak menjalankan binary `aarch64`, Linux glibc, atau wheel `manylinux` secara langsung pada Termux ARM32.
- Tidak menjanjikan seluruh fitur desktop/server Hermes tersedia pada ARM32.
- Tidak menjalankan model AI besar secara lokal.
- Tidak memasukkan browser automation, Docker, computer-use desktop, voice/wake-word, atau integrasi native lain ke MVP kecuali hasil feasibility test membuktikan dependensinya kompatibel.
- Tidak mengubah repository `morluto/rea`; REA hanya digunakan sebagai tool investigasi.

## 5. Profil perangkat target (fakta awal)

Data berikut berasal dari pemeriksaan perangkat yang sudah dilakukan. Prompt OpenCode wajib memverifikasi ulang sebelum build karena firmware/package dapat berubah.

| Parameter | Nilai teramati | Implikasi |
|---|---|---|
| Model | `X98mini` | Nama produk perangkat |
| Android | 11 / SDK 30 | Target Android API 30 |
| Board platform | `s4` | Platform Amlogic Meson S4 |
| Hardware property | `ap201` | Identitas board AP201 |
| Device-tree compatible | `amlogic,s4` | Jangan mengasumsikan DTB/SoC lain |
| CPU | ARMv8, CPU part `0xD04` (Cortex-A35) | CPU hardware mampu AArch64; bukan bukti userspace 64-bit |
| Android ABI | `armeabi-v7a,armeabi` | Android app ABI yang diekspos adalah 32-bit |
| Termux dpkg architecture | `arm` | Target package Termux, bukan Debian `armhf` |
| Kernel string | `armv8l`, Linux 5.4.125 | Konsisten dengan jalur 32-bit yang sedang digunakan; validasi ELF/runtime wajib |
| RAM | sekitar 3.84 GB terdeteksi | Batas resource perlu diukur pada workload |
| Ethernet | `eth0`, 100 Mbps, internet aktif | Transport LLM API tersedia melalui LAN |
| Wi-Fi | tidak muncul di `ip link` saat pemeriksaan | Tidak menjadi syarat MVP |
| Termux | F-Droid 0.118.3 | Standard prefix `$PREFIX` |
| Python Termux | package 3.14.8 tercatat terpasang pada inventaris terakhir | Verifikasi `sys.platform`, ABI dan pointer width sebelum dipakai |
| Storage | 9 GB tersedia pada pemeriksaan sebelumnya | Periksa ulang sebelum build native wheels |

**Penting:** `arm`, `armhf`, `armeabi-v7a`, dan `aarch64` bukan label yang dapat dipertukarkan. Termux menggunakan Android Bionic dan package architecture `arm`. Debian `armhf` umumnya mengacu pada ABI Linux/glibc. Jangan menggunakan binary/deb/wheel Debian sebagai pengganti package Termux.

## 6. Pengguna dan skenario utama

**Pengguna utama:** pemilik X98 Mini yang ingin menjadikan STB Android TV sebagai terminal/agent AI berbasis cloud tanpa mengganti OS.

**Skenario MVP:**
1. Pengguna membuka Termux.
2. Pengguna menjalankan `hermes` atau `hermes --tui`.
3. Pengguna menyelesaikan konfigurasi provider/LLM API.
4. Pengguna mengirim prompt dan menerima jawaban.
5. Pengguna dapat menjalankan tool dasar yang memang lolos verifikasi ARM32: membaca/menulis file dalam area kerja Termux, menjalankan perintah yang diizinkan, dan mempertahankan session/memory.
6. Pengguna dapat menghentikan dan menjalankan Hermes kembali tanpa kehilangan konfigurasi atau data.

## 7. Arsitektur target

```text
X98 Mini — Android 11 (tetap menjadi OS utama)
└── Termux (ARM32 / Bionic / dpkg arch=arm)
    ├── Python runtime native ARM32 (target 3.14; harus diverifikasi)
    ├── Hermes Agent source/runtime yang dipatch minimal
    ├── dependency set yang dibangun/diuji untuk Android armeabi-v7a
    ├── launcher: $PREFIX/bin/hermes
    ├── config/data: $HOME/.hermes atau HERMES_HOME
    └── Ethernet → LLM provider API

Komputer development
└── OpenCode
    ├── Hermes upstream checkout/fork
    ├── REA MCP server (local di komputer development)
    ├── REA Android/ADB tools → X98 Mini (jika ADB tersedia)
    ├── REA ELF/artifact inspection → binary & extension hasil build
    └── CI/build tools → artefak ARM32 Bionic yang diverifikasi
```

REA tidak perlu dipasang pada STB untuk workflow utama. OpenCode dan REA berjalan di komputer development; ADB digunakan sebagai jalur observasi perangkat bila tersedia. Jika ADB tidak tersedia, gunakan perintah Termux yang dicatat sebagai evidence.

## 8. Prinsip desain teknis

### 8.1 Deteksi platform berbasis bukti

Buat preflight yang mengumpulkan sekurang-kurangnya:

- `getprop ro.product.cpu.abi` dan `ro.product.cpu.abilist`
- `getprop ro.build.version.sdk`, `ro.board.platform`, `ro.hardware`
- `uname -a`, `getconf LONG_BIT`
- `dpkg --print-architecture`
- `python -VV`, `sys.platform`, `platform.machine()`, `platform.architecture()`, pointer width, `sysconfig.get_platform()`, `SOABI`, `MULTIARCH`
- `python -m pip debug --verbose` untuk compatibility tags
- `file`/`readelf -h` interpreter, Node binary, dan setiap extension `.so`
- `ldd` atau pemeriksaan setara yang aman untuk mengetahui shared library; jangan menganggap glibc `ldd` tersedia
- versi/availability `node`, `npm`, `clang`, `rustc`, `pkg-config`, dan library Termux

Jangan menyimpulkan target 64-bit hanya dari CPU part atau flag ARMv8. Target final ditentukan oleh binary/runtime yang benar-benar dapat dijalankan dan ABI yang diekspos Android.

### 8.2 Runtime Python

- Mulai dengan mengevaluasi Python 3.14 native dari repository Termux yang terpasang.
- Jangan menggunakan Python 3.13 venv Debian ARMHF dari eksperimen lama.
- Jangan menggunakan `pip install -e .` sebagai metode instalasi final tanpa menyelesaikan dependency marker dan lock/PM contract Hermes.
- Tentukan apakah interpreter Termux melaporkan `sys.platform == "android"` atau `"linux"`; jangan memalsukan `sys.platform`.
- Jika Python Termux tidak sesuai dengan dependency metadata resmi, buat dependency profile khusus untuk Termux ARM32 yang eksplisit, terkunci, dan diuji. Pisahkan dari profile Linux ARM64.

### 8.3 ABI dan native dependencies

Buat dependency compatibility matrix untuk setiap dependency core dan optional:

- pure Python / wheel universal;
- wheel Android yang benar-benar cocok dengan `armeabi_v7a` dan API level;
- tersedia sebagai package Termux native;
- harus dibangun dari source menggunakan toolchain Android/Termux;
- perlu patch upstream;
- harus dinonaktifkan sebagai optional feature;
- tidak layak / blocker.

Jangan memasang wheel `manylinux_armv7l` ke Bionic hanya karena sama-sama ARM 32-bit. Untuk extension native, validasi format ELF32 ARM, dynamic linker, `DT_NEEDED`, symbol resolution, dan library Bionic/Termux yang disediakan.

Android wheel tag PEP 738 menggunakan `android_<api>_<abi>`; ABI yang dinormalisasi mencakup `armeabi_v7a`. Jangan mengarang tag: bandingkan dengan tag runtime dari `pip debug --verbose` dan uji install pada STB.

### 8.4 Target packaging

Gunakan pipeline Termux Hermes upstream sebagai referensi, tetapi buat target baru yang terpisah dari AArch64. Source upstream saat ini memiliki target `linux-arm64-bionic`, indeks package `binary-aarch64`, dan library pins AArch64. Jangan mengubah target AArch64 yang sudah ada.

Target baru (nama final dipilih setelah audit build scripts) harus memisahkan:

- arsitektur package Termux `arm`;
- Android NDK triple/ABI `arm-linux-androideabi` / `armeabi-v7a`;
- Android API minimum;
- interpreter CPython;
- Node.js dan tooling yang diperlukan;
- wheelhouse dan native library closure;
- package version, hash, signature, dan update channel.

### 8.5 Fitur dan graceful degradation

Core MVP hanya mengaktifkan dependency yang berhasil lolos uji ARM32.

| Fitur | Kebijakan MVP |
|---|---|
| Core agent + cloud LLM API | Wajib |
| CLI/TUI | Wajib diuji; bila TUI native dependency gagal, sediakan CLI fallback yang terdokumentasi |
| Provider setup/config | Wajib |
| Session/history/memory dasar | Wajib jika SQLite/runtime native kompatibel |
| File tools di Termux home | Wajib |
| Terminal tools native Termux | Wajib dengan batasan keamanan dan path yang jelas |
| Gateway background | Opsional; Android dapat menghentikan background process |
| Browser/Playwright | Disabled by default sampai Chromium + driver lulus uji ARM32 |
| Voice/STT/TTS/wake-word | Out of scope MVP; graceful unavailable |
| Docker/local container terminal | Unsupported pada target tanpa daemon/container runtime |
| Local inference/GPU | Out of scope; LLM melalui API cloud |
| Nemo Relay exporter | Optional/disabled bila tidak tersedia Android ARM32 build |

## 9. Functional requirements

| ID | Requirement | Prioritas |
|---|---|---|
| FR-01 | `hermes-termux doctor` mengidentifikasi ABI, Python, Node, storage, dependencies, dan feature support | P0 |
| FR-02 | Installer menolak ABI tidak dikenal dan memberi diagnostic yang actionable | P0 |
| FR-03 | Installer bekerja tanpa root, PRoot-Distro, PRoot, QEMU, Debian/Ubuntu rootfs | P0 |
| FR-04 | Hermes CLI dapat dijalankan melalui `$PREFIX/bin/hermes` | P0 |
| FR-05 | Core dependency set terpasang dan `pip check`/import smoke test lulus | P0 |
| FR-06 | Provider setup dan satu chat end-to-end dengan LLM API berhasil | P0 |
| FR-07 | Session/config tersimpan dan tetap ada setelah Termux ditutup/dibuka lagi | P0 |
| FR-08 | File tools dibatasi ke workspace/home yang dikonfigurasi | P1 |
| FR-09 | Terminal tools menampilkan environment Termux dan tidak mengasumsikan FHS/glibc | P1 |
| FR-10 | Feature registry melaporkan kemampuan yang tidak tersedia secara eksplisit | P1 |
| FR-11 | Installer/uninstaller tidak menyentuh Android TV app, firmware, eMMC, bootloader | P0 |
| FR-12 | Log dan diagnostic dapat diekspor untuk debugging | P1 |
| FR-13 | Update/rollback menggunakan manifest, SHA256, dan signature atau mekanisme integrity yang setara | P1 |

## 10. Non-functional requirements

- **Native execution:** seluruh executable/extension runtime yang berjalan di STB harus ELF32 ARM yang cocok dengan Android/Bionic/Termux. Tidak boleh ada QEMU atau proot runtime dependency.
- **Safety:** no root, no firmware writes, no bootloader changes, no eMMC partition changes.
- **Storage:** build dan install tidak boleh menghabiskan storage tanpa pemeriksaan ruang; log/cache memiliki batas dan cleanup command.
- **Memory:** ukur idle RSS, peak RSS, startup, dan first-response memory pada perangkat fisik. Target awal (bukan jaminan): idle process < 500 MiB dan peak chat sederhana < 1 GiB; sesuaikan berdasarkan hasil nyata.
- **Startup:** target awal CLI siap menerima input dalam 30 detik cold start; ukur pada Ethernet dan kondisi STB nyata.
- **Network:** mendukung HTTP(S) API melalui Ethernet; timeout/retry dan pesan error harus jelas.
- **Reliability:** data config/session tidak boleh rusak ketika Android menghentikan proses. Gateway background tidak boleh diklaim selalu 24/7 karena Android dapat membatasi process.
- **Security:** API keys tidak ditulis ke shell history/log; permission file config dibatasi; tool execution menampilkan cwd dan environment target.
- **Maintainability:** upstream merge/rebase harus terukur; semua patch diberi alasan, tests, dan link ke upstream commit.

## 11. REA workflow dan penggunaan OpenCode

1. Pasang REA di komputer development melalui OpenCode MCP, bukan di STB sebagai prasyarat runtime Hermes.
2. Gunakan `REA` untuk:
   - menginventarisasi Android device, package, process, feature, service, window, dan log melalui ADB;
   - mengambil APK/artifact hanya jika memang dibutuhkan;
   - memeriksa header ELF, ABI, sections, notes, hardening, imports, shared-library evidence dan binary digests;
   - menganalisis binary extension yang gagal load dengan Hopper/Ghidra/IDA/Kuna bila engine tersedia.
3. Gunakan OpenCode untuk membaca source Hermes, dependency graph, markers, Termux packaging scripts, PM locks, dan tests.
4. Semua kesimpulan harus menyertakan evidence file/line, tool output, binary hash, atau output command. Labeli fakta, inferensi, dan unknown terpisah.
5. REA tidak boleh dianggap menjalankan device UI atau memasang ADB service sendiri; ADB adalah tool eksternal yang harus disiapkan pada komputer development.

## 12. Acceptance criteria

MVP dianggap berhasil hanya jika semua poin P0 lulus pada STB fisik:

1. Preflight menunjukkan Android ABI `armeabi-v7a`, Termux architecture `arm`, pointer width 32-bit, dan Python/runtime yang tervalidasi.
2. `hermes --help`, `hermes --version`, dan command diagnostic berjalan native.
3. Semua ELF native yang dipakai adalah 32-bit ARM dan tidak mempunyai dependency AArch64/glibc yang tidak tersedia.
4. Dependency lock core berhasil dipasang dari source/wheel yang benar-benar kompatibel; `pip check` dan import smoke tests lulus.
5. `hermes setup` berhasil menyimpan provider config.
6. Minimal satu percakapan LLM API berhasil, termasuk streaming bila dependency mendukungnya.
7. Minimal satu tool file dan satu tool terminal berhasil di Termux home.
8. Session/config tetap tersedia setelah proses dihentikan dan Termux dibuka kembali.
9. `ps` tidak menunjukkan `qemu-*` atau `proot` sebagai bagian runtime Hermes; Hermes tidak memanggil `proot-distro`.
10. Tidak ada perubahan pada firmware, eMMC, bootloader, atau instalasi Android TV.
11. Feature doctor secara jujur menandai fitur yang disabled/unsupported.
12. Startup, RSS, dan stabilitas telah dicatat dari STB fisik; hasil bukan hanya test emulator/x86_64 atau CI.

## 13. Risiko dan mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| 32-bit Android/Termux bukan target resmi Hermes | Port tidak dijamin upstream | Anggap fork eksperimental; discovery dan spike sebelum implementasi besar |
| Tidak ada wheel Android ARMv7 untuk dependency native | Build gagal atau memerlukan patch | Audit wheel closure; build subset native; disable optional deps |
| `sys.platform`/platform tags Termux berbeda dengan PEP 738 Android | Marker memilih dependency salah | Probe interpreter sebenarnya; profile Termux terpisah; jangan spoof platform |
| `uv`/PM tidak mengenali Android ARMv7 wheel tag | Resolver/update gagal | Spike `pip` dan `uv` terpisah; gunakan installer/build flow yang diuji; jangan bypass integrity |
| Node.js atau UI TUI tidak punya ARMv7 Android binary/addon | TUI/fitur tertentu gagal | Pisahkan Node/TUI dari core MVP; CLI fallback; uji Node Termux native |
| Native dependency berat pada RAM/CPU 4 GB | Build lambat, OOM, thermal throttling | Build wheels di CI/cross-build; runtime minim; optional feature gating |
| Android menghentikan proses background | Gateway berhenti | Dokumentasikan wakelock/battery settings; jangan klaim 24/7 guarantee |
| Perubahan upstream cepat | Patch drift | Pin commit, patch kecil, rebase tests, changelog kompatibilitas |
| ADB tidak tersedia | REA tidak dapat mengobservasi device langsung | Jalur manual Termux preflight dan `adb` optional |

## 14. Deliverables

1. `docs/PRD-Hermes-Termux-ARMv7-X98-Mini.md` — dokumen ini.
2. `docs/DEVICE-BASELINE.md` — bukti preflight STB dan environment.
3. `docs/DEPENDENCY-COMPATIBILITY.md` — matriks semua core/optional dependencies.
4. `docs/ARCHITECTURE.md` — runtime, build, packaging, update, feature gating.
5. `scripts/termux-armv7/` — preflight, build, install, verify, uninstall (nama akhir mengikuti audit upstream).
6. `requirements/` atau lock profile khusus Termux ARMv7 dengan hash dan provenance.
7. Automated unit/integration tests dan physical-device test report.
8. `docs/INSTALL-TERMUX-ARMV7.md` — instalasi, update, uninstall, troubleshooting.
9. Fork branch/PR yang tidak mengubah jalur upstream AArch64 secara tidak sengaja.

## 15. Referensi teknis awal

- Hermes Termux guide: https://hermes-agent.nousresearch.com/docs/getting-started/termux
- Hermes Platform Support: https://hermes-agent.nousresearch.com/docs/getting-started/platform-support
- Hermes upstream source: https://github.com/NousResearch/hermes-agent
- Hermes Termux packaging source: https://github.com/NousResearch/hermes-agent/tree/main/scripts/termux
- REA: https://github.com/morluto/rea
- REA installation / supported clients: https://github.com/morluto/rea/blob/main/docs/getting-started/installation.md
- REA Android ADB analysis: https://github.com/morluto/rea/blob/main/docs/guides/android/adb-device-analysis.md
- PEP 738 / Android wheel tags: https://peps.python.org/pep-0738/
- Python packaging platform tags: https://packaging.python.org/en/latest/specifications/platform-compatibility-tags/

---

## 16. Keputusan awal

Jangan mulai dengan mengubah Hermes CLI atau menambal semua dependency sekaligus. Milestone pertama adalah **feasibility spike**: buktikan bahwa Termux Python 3.14 pada STB benar-benar dapat memuat dependency core paling penting secara native ARM32/Bionic. Bila satu atau lebih dependency core tidak dapat dibangun secara wajar, hasil spike harus menyebut blocker dan menawarkan scope MVP yang lebih kecil—bukan menyembunyikan kegagalan dengan QEMU/PRoot.
