# Spesifikasi Sistem & Runtime — X98mini

## 1. Hardware

- **Perangkat:** X98mini (brand `Droidlogic`), board/device `oppen`, hardware `ap201`
- **SoC:** Amlogic-class (`Droidlogic`), 4 core ARMv8, max `1.8 GHz`, min `100 MHz`, governor `schedutil`
- **Arsitektur:** `armv8l`, ABI `armeabi-v7a` (userspace 32-bit meski CPU 64-bit capable)
- **GPU:** ARM Mali-G31, OpenGL ES 3.2 (driver `v1.r25p1-01bet0`)
- **RAM:** `3.840.880 kB` (`3,66 GiB`) total — saat ini `1.905 MB` terpakai, `1.844 MB` tersedia
- **Swap:** `1,88 GB` `zram` (bukan partisi flash)
- **Storage:** `/data` `26 GB` total, `18 GB` terpakai, `7,2 GB` bebas (`72%`)
- **Partisi Sistem (Read-Only):** Penuh wajar — `/` `0,9G/0,9G`, `/vendor` `480M`, `/product` `129M`
- **Layar:** `1920x1080`, density `240` (override `204`)
- **Jaringan:** Hanya ethernet `eth0` — `192.168.1.3/24`, MAC `90:0e:b3:41:ad:9d` (tidak ada WiFi / `wlan0` absen)
- **Baterai:** Tidak ada hardware baterai (murni adaptor AC)
- **Sensor Suhu:** 1 sensor (`soc_thermal`) — `72,0 °C` sekarang (`thermal status 0`)
- **Bootloader:** Terkunci (`flash.locked=1`), `verified boot green`
- **Port:** HDMI OUT (CEC aktif), USB, RJ45

## 2. OS & Kernel

- **OS:** Android 11 (API 30), build `X98mini_20220518-2027`
- **Build Type:** `userdebug`, `ro.debuggable=1`, `test-keys` (bukan release resmi)
- **Fingerprint:** `Droidlogic/oppen/oppen:11/RD2A.211001.002/eng.yxt-rd.20220518.200421:userdebug/test-keys`
- **Kernel:** Linux `5.4.125`, `SMP PREEMPT`, dibangun 18 Mei 2022 dengan Clang `11.0.1`
- **Runtime Shell:** Termux, `PREFIX=/data/data/com.termux/files/usr`, `termux-tools 1.46.0`

## 3. Software Stack

- **Hermes Agent:** `vgit.4b40ffb.dirty` (`2026.9.24`) · `stable`, install method `git` di `~/hermes-agent`
- **Python:** `3.14.8` (Clang 21, 32-bit) — dipakai Hermes dan `gptme`
- **Node.js:** `v26.13.1`, `npm 12.2.2`
- **FFmpeg:** `9.0.2` (build Android, `+pgo/+bolt/+lto`)
- **gptme:** `0.36.0` (agent coding lokal)
- **ADB:** `1.0.41`, loopback `127.0.0.1:5555`, user `shell` (`uid 2000`)
- **Skill Aktif:** `11` (`57` file `SKILL.md` di disk termasuk bawaan/plugin)

## 4. Runtime Sekarang

- **Gateway:** PID `29865`, uptime `11 jam`, mode manual di `tmux` (`hermes`)
- **Model Utama:** `deepseek-v4-flash` (custom → `ai.sumopod.com`)
- **Model Fallback:** `glm-5.3-flash` → `hy4-flash` → `nvidia/nemotron-3-ultra-550b-a55b:free`
- **Aktivitas Berjalan:** YouTube TV memutar `BaLiTa` (`state=3`)

## 5. Batasan & Catatan Analisa

| Batasan | Dampak |
| :--- | :--- |
| **32-bit userspace (`armeabi-v7a`)** | Banyak wheel/binary 64-bit tidak tersedia; Chromium/OpenCode tidak bisa dijalankan. |
| **Android/Termux non-`aarch64`** | Platform tidak didukung resmi oleh Hermes — jangan jalankan `hermes update` sembarangan. |
| **Tanpa baterai** | `dumpsys battery` mengembalikan nilai placeholder (`level=50` palsu). |
| **WiFi tidak ada (`wlan0` absen)** | Hanya koneksi kabel (`eth0`); `dumpsys wifi` tidak berguna. |
| **Bootloader terkunci + `verified boot green`** | Magisk/root permanen berisiko brick; satu-satunya akses root adalah `su 0` per-perintah. |
| **RAM `3,66 GiB` + zram `1,88 GB`** | `kswapd0` mudah aktif jika banyak aplikasi resident berjalan bersamaan. |