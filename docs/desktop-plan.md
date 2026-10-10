# Rencana DevDock Desktop

Status: **disetujui pengguna pada 2026-10-09** beserta usulan untuk ketiga pertanyaan terbuka. Pekerjaan dilakukan bertahap sesuai tabel tahapan; Fase 8 di `AGENT.md` melacak kemajuannya.

## Keputusan pengguna (2026-10-09)

1. Cakupan: hanya **bentuk** aplikasi (desktop yang mudah dipakai). Fitur ala Lumine seperti Docker/Podman, database siap pakai, preset stack, HTTPS, dan editor hosts **tidak** termasuk.
2. Teknologi: rekomendasi, yaitu **Tauri v2 + mesin DevDock (Node/TypeScript) sebagai sidecar**.
3. OS: **Windows dulu**, macOS dan Linux menyusul bertahap.
4. Distribusi: **installer tanpa tanda tangan** di GitHub Release.

## Tujuan pengalaman pengguna

Pengguna mengunduh satu installer, klik dua kali, lalu membuka "DevDock" dari Start Menu. Tidak ada terminal, browser, alamat localhost, kode pairing, atau path yang diketik.

| Sekarang (0.1.0) | DevDock Desktop |
|---|---|
| `npm install` tarball di terminal, muncul peringatan merah | Installer `.exe` per-user, tanpa hak admin |
| Jalankan `devdock.cmd`, jendela terminal harus tetap terbuka | Buka dari Start Menu; ikon di system tray |
| Salin URL ke browser, ketik kode pairing | Jendela aplikasi langsung siap; pairing otomatis dan tidak terlihat |
| Ketik path folder proyek | Tombol **Tambah proyek** membuka dialog pilih folder |
| Formulir service berisi port, readiness, env, restart | Script otomatis tampil sebagai kartu; pengaturan teknis di bagian **Lanjutan** |
| "Open App" berupa tautan di halaman | Tombol **Buka** membuka browser default |
| Tutup terminal = DevDock mati | Tutup jendela = tetap berjalan di tray; **Keluar** dari tray menghentikan semua service dengan rapi |

## Sketsa layar

### 1. Pertama kali dibuka

```text
┌──────────────────────────────────────────────────────────────┐
│  DevDock                                              ─ □ ×  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                  Selamat datang di DevDock                   │
│                                                              │
│     Jalankan dan hentikan script proyek Node.js Anda         │
│     dari satu tempat, tanpa membuka terminal.                │
│                                                              │
│                  [ + Tambah proyek pertama ]                 │
│                                                              │
│     DevDock menjalankan script dengan hak akun Anda.         │
│     Tambahkan hanya proyek yang Anda percaya.                │
└──────────────────────────────────────────────────────────────┘
```

### 2. Halaman utama

```text
┌──────────────────────────────────────────────────────────────┐
│  DevDock                                              ─ □ ×  │
├───────────────┬──────────────────────────────────────────────┤
│ PROYEK        │  toko-online            C:\Kode\toko-online  │
│ ● toko-online │                                              │
│ ○ blog        │  ┌──────────────────┐  ┌──────────────────┐  │
│ ○ api-kampus  │  │ dev              │  │ api              │  │
│               │  │ ● Berjalan · Siap│  │ ○ Berhenti       │  │
│               │  │ :5173            │  │ :3000            │  │
│               │  │ [Stop] [Buka] [≡]│  │ [Start]      [≡] │  │
│               │  └──────────────────┘  └──────────────────┘  │
│               │                                              │
│               │  GRUP (profil)                               │
│               │  Full Stack: api → dev     [Start semua]     │
│ [+ Tambah]    │                                              │
│               ├──────────────────────────────────────────────┤
│ ⚙ Pengaturan  │  Log: dev                      [Bersihkan] ▾ │
│               │  VITE v8.3.0 ready in 412 ms                 │
│               │  ➜ Local: http://127.0.0.1:5173/             │
└───────────────┴──────────────────────────────────────────────┘
```

- Setiap script dari `package.json` tampil sebagai kartu. Tombol **Start** langsung menjalankannya tanpa formulir. Port dideteksi dari log bila memungkinkan, atau diisi di **Lanjutan**.
- Status memakai bahasa sederhana: *Berhenti*, *Memulai*, *Berjalan · Siap*, *Gagal*, *Status tidak diketahui (perlu dicek)*.
- `[≡]` membuka panel **Lanjutan**: port, readiness, file env, key wajib, dan restart otomatis. Isinya sama dengan formulir sekarang, tetapi tersembunyi secara default.
- "Profil" diberi nama **Grup** di UI.

### 3. System tray

```text
DevDock ▸  Buka DevDock
           ─────────────
           toko-online: 1 berjalan
           Hentikan semua service
           ─────────────
           Keluar (hentikan semua service)
```

Notifikasi Windows muncul ketika service crash atau gagal siap.

## Arsitektur

```text
DevDock.exe (Tauri v2, Rust, tipis)
 ├─ menjalankan sidecar:  node.exe (Node 24.21.0 yang dibundel)  daemon.js (mesin DevDock)
 │     └─ supervisor, Job Object Windows, readiness, profil, SQLite  ← dipakai ulang tanpa diubah
 ├─ jendela WebView2 memuat UI React dari daemon di 127.0.0.1:<port acak>
 ├─ pairing otomatis: kode pairing dibaca dari stdout sidecar lalu diberikan ke UI
 │   melalui initialization script (tidak lewat URL, tidak disimpan di disk)
 ├─ fitur native: dialog pilih folder, buka browser default, tray, notifikasi, single-instance
 └─ saat Keluar: kirim {type:"shutdown"} ke sidecar → service dihentikan → sidecar exit 0
```

**Tetap dipakai:** supervisor, `WindowsJobProcessAdapter`, readiness, profil/rollback, log buffer, SQLite, serta keamanan Host/Origin/CSRF/session. Semuanya sudah terverifikasi.

**Berubah:**

- Pairing manual diganti handshake otomatis antara shell dan UI.
- Sidecar berhenti sendiri bila proses induknya (shell) hilang, supaya tidak ada daemon yatim yang memegang service.
- UI React mendapat mode desktop: onboarding, kartu, panel lanjutan, dan bahasa sederhana.
- Packaging baru: installer NSIS per-user untuk Windows, dengan WebView2 bootstrapper.

## Hal yang harus dibuktikan di spike (tahap D1)

Asumsi berikut belum terbukti dan bisa mengubah desain:

1. Halaman dari `http://127.0.0.1:<port>` yang dimuat di jendela Tauri dapat memakai plugin dialog/opener melalui *capability* untuk URL remote. Jika tidak bisa, alternatifnya UI dibundel di dalam Tauri dan daemon diberi izin origin aplikasi. Alternatif ini memerlukan perubahan kebijakan Host/Origin yang lebih hati-hati.
2. Initialization script dapat memberikan kode pairing sebelum UI melakukan request pertama.
3. Helper Job Object (PowerShell/C#) tetap berjalan ketika daemon diluncurkan sebagai sidecar tanpa konsol.
4. Ukuran installer dengan Node dibundel. Perkiraan 40–60 MB, perlu diukur.

## Hasil spike D1 (2026-10-09, Windows 11 x64)

1. **Capability untuk halaman daemon: terbukti.** Shell membuat capability saat runtime (`CapabilityBuilder`, fitur `dynamic-acl` bawaan Tauri) untuk origin daemon yang persis (`http://127.0.0.1:<port>/*`), hanya untuk jendela `main`, dengan izin `core:default` dan `dialog:allow-open`. Dialog folder native terbuka dari halaman daemon, sedangkan `dialog:save` yang tidak diberikan ditolak dengan pesan "not allowed". CSP daemon tidak perlu dilonggarkan: Tauri otomatis beralih dari IPC protokol khusus ke `postMessage` ketika `connect-src 'self'` memblokirnya.
2. **Initialization script: terbukti.** Kode pairing disuntikkan sebagai `window.__DEVDOCK_DESKTOP__` sebelum skrip halaman berjalan; jendela masuk ke dashboard sekitar 1,4 detik setelah aplikasi dibuka tanpa formulir pairing, dan kode terhapus dari halaman setelah dipakai.
3. **Helper Job Object sebagai sidecar tanpa konsol: terbukti.** Daemon dijalankan dengan `CREATE_NO_WINDOW`; service npm nyata mencapai `running/ready`, menjawab HTTP, lalu Stop menutup seluruh pohon prosesnya.
4. **Ukuran installer: belum diukur.** Pengukuran memerlukan Node yang dibundel dan dipindahkan ke D4. Hasil D4: 29,0 MiB, lebih kecil daripada perkiraan.

Keputusan tambahan dari spike:

- Jendela hanya boleh menavigasi di origin daemon; navigasi lain diblokir (tautan Open App akan memakai browser default di D3).
- `apps/desktop` adalah crate Rust, bukan workspace npm. Sebagai workspace, ia sempat ikut masuk SBOM produksi paket CLI dan membuat `verify:release` gagal; `@tauri-apps/cli` kini devDependency root.
- Versi di `Cargo.toml` dan `tauri.conf.json` (0.1.0) belum diperiksa oleh `check:versions`/`release:version`; sinkronisasinya masuk D4.
- D2 (selesai): menutup jendela menyembunyikannya ke tray; menu tray berisi **Open DevDock** dan **Quit DevDock (stops all services)**. Peluncuran kedua memunculkan jendela yang ada, dan `devdock-desktop.exe --quit` menghentikan instance yang berjalan (dipakai uninstaller di D4). Bila sesi berakhir, UI memanggil perintah native `request_pairing_code` lalu pairing ulang sendiri. Bila mesin gagal start (misalnya CLI memegang data) atau berhenti mendadak, jendela error lokal menampilkan alasannya dengan tombol **Try again** dan **Close**. Teks shell masih berbahasa Inggris seperti UI; bahasa UI diputuskan di D3.

## Hasil D3 (2026-10-10)

Spec: `docs/superpowers/specs/2026-10-09-d3-desktop-ux-design.md`. Acuan tampilan: mockup di `docs/mockups/d3/`. Screenshot UI asli ada di `docs/screenshots/d3/` dan dibuat ulang dengan `node docs/screenshots/d3/capture.mjs`.

Keputusan pengguna: bahasa UI **Inggris**, cakupan **seluruh isi mockup**, dan UI baru juga **menggantikan dashboard browser** CLI 0.1.0. Pada mode browser, dialog folder diganti kolom path dan Open memakai tab baru.

Yang dibangun:

- **Welcome:** layar pertama bila belum ada proyek. Berisi penjelasan "What's a script?", tiga langkah, dan tombol **Choose a project folder** yang membuka dialog folder native.
- **Add this project?:** menampilkan isi `package.json` sebelum proyek didaftarkan, melalui endpoint baru `POST /api/folders/inspect` yang tidak menyimpan dan tidak menjalankan apa pun.
- **Kartu script:** satu kartu untuk setiap script, dengan deskripsi sederhana dan jenisnya ("keeps running"/"runs once"), perintah, status dalam kata-kata, alasan gagal, dan durasi.
  - Service dibuat otomatis saat script pertama kali dijalankan atau pengaturannya disimpan, sehingga pengguna tidak lagi mengisi formulir.
  - Script yang dijalankan npm sendiri (`postinstall`, `pre*`/`post*`) disembunyikan di "More scripts".
- **Ready dan Open:** daemon mengenali alamat loopback yang dicetak aplikasi (misalnya `Local: http://localhost:5173/` dari Vite). Alamat itu dipakai sebagai status *Ready* bila readiness tidak diatur, dan sebagai tujuan tombol **Open**.
  - Port yang dikonfigurasi menang bila keduanya berbeda.
  - Kode warna terminal kini dibuang utuh dari output, tidak lagi muncul sebagai `�`.
- **Script settings:** panel samping yang mengatur port, kapan dianggap siap, file env, variabel wajib, restart setelah crash, dan cek port/env. Datanya disimpan lewat `POST /api/services/:id/settings`.
- **Output:** tab per script dengan Copy dan Clear, mengikuti baris terbaru, serta catatan cara run berakhir.
- **Grup:** dialog **New group** dengan pilihan "one after another" (rantai sesuai urutan pilih) atau "all at once".
- **Header proyek:** Open folder, Stop all, Export settings, dan Remove from DevDock.
- **Sidebar:** jumlah script berjalan/gagal per proyek (`GET /api/runtime/summary`) dan versi Node.js yang menjalankan proyek (`GET /api/system`).
- **Shell:** perintah `open_in_browser` dan `open_folder` hanya untuk origin daemon. Shell menolak alamat non-loopback, URL berkredensial, dan path yang bukan folder.

Tema (2026-10-10): atas permintaan pengguna, tampilan beralih dari tema gelap mockup ke tema editorial terang ala https://www.roberttran.com.au/:
- kertas krem dan tinta hitam;
- font Caslon dan Franklin yang dibundel (OFL-1.1, bekerja offline);
- garis tegas dan status bergaya stempel.

Alur dan teks UI tidak berubah; screenshot di `docs/screenshots/d3/` sudah memakai tema ini.

Belum ada di D3 (empat yang pertama ditutup di D3.5):

- Menghapus service atau grup, dan mengedit grup.
- Notifikasi Windows.
- Menu tray yang menampilkan script berjalan dan **Stop all**.
- Jalan keluar dari kartu "Status unknown" setelah daemon restart.
- Mode gelap.
- Ikon final.

## Hasil D3.5 (2026-10-10)

Spec: `docs/superpowers/specs/2026-10-10-d3-5-desktop-gaps-design.md`. Tujuannya menutup celah yang membuat pengguna baru terjebak sebelum installer 0.2.0 beredar.

Yang dibangun:

- **Grup:** tombol gear pada kartu grup membuka dialog **Edit group** (nama, script, urutan). Dialog ini juga punya **Delete group** dengan konfirmasi. Keduanya hanya bisa dipakai ketika grup tidak berjalan.
- **Reset script:** bagian baru di Script settings.
  - **Reset to defaults** melupakan pengaturan dan histori run; kartunya tetap ada.
  - **Remove card** untuk kartu tanpa script di `package.json`.
  - Ditolak selama script berjalan atau masih menjadi anggota grup, dan UI menyebut nama grupnya.
- **Status unknown:** kartu menampilkan tombol **Check**. Dialognya menunjukkan apakah PID lama masih dipakai suatu proses dan apakah port terpakai. Keduanya hanya petunjuk, karena PID bisa dipakai ulang program lain.
  - Pengguna menutup program itu sendiri bila perlu, lalu menekan **Mark as stopped**.
  - Run yang masih dipegang sesi daemon saat ini diarahkan ke **Stop again**.
  - Sesuai `AGENT.md` §6, tidak ada auto-adopt atau kill berdasarkan PID.
- **Tray:** menu kini berisi jumlah script berjalan per proyek (maksimal lima baris, sisanya digabung), **Stop all scripts**, dan **Quit DevDock (stops all scripts)**. Tooltip ikut menampilkan jumlahnya.
  - Datanya berasal dari event `runtime-summary` di stdout sidecar.
  - **Stop all** mengirim `{"type":"stop-all"}` lewat stdin.
  - `&` pada nama proyek digandakan agar tidak menjadi garis bawah pintasan Windows.
- **Notifikasi:** `tauri-plugin-notification` 2.5.1 (dipin) menampilkan event `script-alert` ketika jendela tersembunyi, diminimalkan, atau tidak fokus.
  - Dari `targetdebug`, plugin memakai AppUserModelID milik PowerShell. ID aplikasi sendiri baru dipakai setelah terpasang (D4).

Catatan verifikasi: di mesin pengembang notifikasi Windows dimatikan untuk pengguna (`DisabledForUser`), sehingga toast tidak bisa dilihat langsung. Event `script-alert` sudah terbukti keluar dari sidecar nyata.

## Hasil D4 (2026-10-10)

`npm run desktop:bundle` menghasilkan `DevDock_<versi>_x64-setup.exe`, installer NSIS per-user tanpa hak admin berukuran **29,0 MiB** (30.394.562 byte). Isinya:

- **Shell:** `devdock-desktop.exe` (build release Tauri, Rust 1.95.0).
- **`runtime/`:** distribusi resmi Node.js 24.21.0 win-x64 apa adanya, termasuk npm dan `LICENSE`-nya.
  - Arsipnya dipin dengan SHA-256 di `apps/desktop/runtime.json` dan harus sama dengan `.node-version`.
  - Unduhan disimpan di `.tools/` dan dicek ulang hash-nya setiap staging.
- **`engine/`:** tarball CLI terverifikasi dari `npm run package:local`, dipasang offline. Setiap paket npm membawa file lisensinya sendiri.

Keputusan:

- **Engine memakai tarball CLI, bukan bundel esbuild.** Isi dan perilakunya sama dengan paket yang sudah diuji `verify:package`, tanpa mengubah cara daemon menemukan aset web dan helper Job Object. Biayanya sekitar 5.500 file, tetapi pemasangannya tetap beberapa detik.
- **Folder instalasi tetap bawaan Tauri**, yaitu `%LOCALAPPDATA%DevDock`, yang juga folder data DevDock.
  - Uninstaller Tauri hanya menghapus file yang dipasangnya lalu `RMDir` tanpa rekursi, sehingga `registry.sqlite` tetap ada. Ini sudah diuji.
  - Memindahkan folder akan memerlukan fork template NSIS, atau hook yang diam-diam mengganti folder yang sudah dilihat pengguna.
- **Hook NSIS** (`windows/installer-hooks.nsh`): sebelum memasang atau menghapus, installer menjalankan `devdock-desktop.exe --quit` lalu menunggu sampai 30 detik hingga exe tidak terkunci. Dengan begitu script berhenti rapi seperti Quit dari tray. Penutupan paksa Restart Manager bawaan Tauri tetap menjadi cadangan.
- **Resource hanya untuk build installer** (`tauri.bundle.conf.json`), sehingga `cargo build` pengembangan tidak memerlukan staging. Shell memakai `runtime/node.exe` dan `engine/.../devdock.mjs` bila keduanya ada di samping exe; selain itu memakai `node` dari PATH dan build workspace. Variabel `DEVDOCK_SIDECAR_*` tetap menang untuk test.
- **WebView2** memakai bootstrapper unduhan senyap (bawaan Tauri), karena Windows 11 sudah menyertakannya.
- **Versi:** `check:versions` dan `release:version` kini ikut memeriksa dan mengubah `Cargo.toml`, entri `Cargo.lock`, dan `tauri.conf.json`.
- **Ikon final** mengikuti logo di sidebar: kertas krem, bingkai, dan tiga garis tinta.

`npm run desktop:verify-installer` (lokal) melakukan langkah berikut:

1. Memasang installer secara senyap di bawah LOCALAPPDATA sementara, dengan tata letak yang sama seperti bawaan.
2. Meluncurkan aplikasi tanpa Node.js di PATH dan memastikan engine berjalan dengan Node bawaan.
3. Menjalankan script npm nyata.
4. Menguninstal selagi aplikasi dan script masih berjalan.
5. Memastikan aplikasi keluar dengan kode 0, script berhenti, file program hilang, dan data tetap ada.

Job CI `Desktop installer (windows-2025)` tidak bisa memakai mode bawaan. Penyebabnya: port DevTools WebView2, yang dipakai skrip uji untuk mengendalikan halaman, tidak pernah terbuka di runner. Aplikasinya sendiri berjalan normal.

Ini terbukti di D5 lewat trace startup (`DEVDOCK_SHELL_LOG`): tray dibuat dalam 15 ms, engine siap dalam 0,6 detik, dan jendela "DevDock" dibuat dalam 3,8 detik. Dugaan awal "aplikasi macet" ternyata keliru, karena filter proses memakai nama pendek 8.3 (`RUNNER~1`) sehingga engine tidak terlihat.

CI kini menjalankan dua mode:

- **`--engine-only`:**
  1. Memasang installer secara senyap.
  2. Menjalankan engine terpasang dengan Node bawaan dan baris perintah yang sama dengan shell.
  3. Menjalankan script npm.
  4. Menghentikan engine lewat pipa kontrolnya.
  5. Memeriksa `--quit`.
  6. Menguninstal dan memeriksa file serta data.
- **`--shell-only`:** memulai aplikasi terpasang, menunggu trace melaporkan engine siap dan jendela dibuat, memeriksa jendela "DevDock" terlihat, lalu menguninstal selagi aplikasi berjalan. Aplikasi harus keluar dengan kode 0, engine berhenti, file hilang, dan data tetap ada.

Hanya penggerakan halaman lewat DevTools yang tetap diverifikasi lokal.

## Hasil D5 (2026-10-11)

- **Lisensi:** installer membawa `LICENSE.txt` (MIT) dan `THIRD-PARTY-NOTICES.txt` (sekitar 546 KB), yang dibuat oleh `scripts/desktop-notices.mjs` saat staging. Isinya:
  - 246 crate Rust yang ditaut ke shell untuk target Windows, yaitu dependensi normal; build dan dev dependency tidak ikut.
  - Teks lisensi tiap crate dari file lisensinya sendiri. Enam crate yang diterbitkan tanpa file lisensi memakai teks standar SPDX v3.27.0 (`apps/desktop/licenses/`) dengan penulisnya, atau URL repositori bila penulis tidak tercatat.
  - Teks yang identik ditulis sekali dengan daftar pemakainya.
  - 77 paket npm engine, Node.js, font, serta NSIS dan nsis_tauri_utils.
  - Crate MPL-2.0 diberi keterangan tempat sumbernya (crates.io).
  - Staging gagal bila sebuah crate tidak punya file lisensi maupun lisensi standar.
- **Checksum:** `desktop:bundle` menulis `DevDock_<versi>_x64-setup.exe.sha256`.
- **Panduan pengguna:** `docs/install-windows.md` (bahasa Inggris, seperti UI) menjelaskan unduhan dan cek hash, peringatan SmartScreen, isi instalasi, pembaruan, uninstall (data tetap ada dan cara menghapusnya), serta cara merekam trace startup. README kini mengutamakan installer desktop.

Yang masih belum ada:

- **Penandatanganan kode:** installer belum ditandatangani, sehingga SmartScreen akan memperingatkan.
- **Pembaruan otomatis** belum ada.

## Keputusan atas pertanyaan terbuka (disetujui 2026-10-09)

1. **Node untuk menjalankan proyek.** DevDock memakai Node/npm yang terpasang di komputer (ditemukan dari PATH) bila ada, dan Node bawaan DevDock bila tidak ada. Node yang dipakai harus terlihat oleh pengguna.
2. **CLI npm 0.1.0.** Tarball CLI tetap dibangun sebagai jalur sekunder; README mengutamakan aplikasi desktop.
3. **Dua DevDock bersamaan.** Aplikasi desktop dan CLI memakai database yang sama di `%LOCALAPPDATA%\DevDock`, sehingga hanya satu instance per database yang boleh aktif.

## Tahapan

Setiap tahap diakhiri verifikasi, lalu commit dan push.

| Tahap | Isi | Bukti selesai |
|---|---|---|
| D0 ✅ | Prasyarat: pengguna memasang Visual Studio Build Tools (Desktop development with C++). `AGENT.md` diperbarui: desktop wrapper masuk cakupan, target Windows dulu | `cargo build` contoh Tauri berhasil di mesin lokal |
| D1a ✅ | Persiapan daemon yang tidak memerlukan Rust: pemilihan Node dari PATH dengan cadangan Node bawaan, kunci satu instance per database, sidecar berhenti bila pipa induk tertutup, dan pairing otomatis dari nilai yang disuntikkan shell | Unit/integration test baru lulus; suite tiga OS tetap lulus |
| D1 ✅ | Spike: shell Tauri menjalankan sidecar, pairing otomatis, jendela menampilkan dashboard yang ada, dialog folder berfungsi | Demo lokal Windows; keempat asumsi di atas terjawab |
| D2 ✅ | Siklus hidup: tray, tutup ke tray, Keluar dengan shutdown rapi, single-instance, sidecar mati bila shell hilang, layar error bila sidecar gagal | Test otomatis: Keluar menghentikan service; kill shell tidak meninggalkan proses |
| D3 ✅ (menunggu review pengguna) | UX desktop: onboarding, kartu script, panel Lanjutan, Grup, log, tombol Buka, bahasa sederhana | Browser/UI test diperbarui; review tampilan oleh pengguna |
| D3.5 ✅ (menunggu review pengguna) | Celah sebelum packaging: edit/hapus grup, reset script, Check untuk status unknown, tray berisi jumlah dan Stop all, notifikasi Windows | Unit/integration/browser test baru; `desktop:verify` tetap lulus |
| D4 ✅ | Packaging: Node + daemon dibundel, installer NSIS per-user, workflow CI Windows yang membangun installer lalu menginstal diam-diam, meluncurkan, dan menguninstal | Installer lulus smoke test di runner Windows; ukuran tercatat |
| D5 | Dokumentasi pengguna (cara install, peringatan SmartScreen, cara uninstall) dan rilis 0.2.0 | Rilis dibuat setelah konfirmasi pengguna |
| Nanti | macOS (`.dmg`), lalu Linux (`.AppImage`/`.deb`) | Matriks tiga OS seperti sekarang |

## Risiko dan batasan yang diketahui

- **SmartScreen:** karena installer tidak ditandatangani, Windows menampilkan "Windows protected your PC". Pengguna harus memilih *More info → Run anyway*. Ini dijelaskan di halaman rilis.
- **Ukuran:** sidecar Node membuat installer lebih besar daripada Lumine (sekitar 10 MB). Menulis ulang mesin ke Rust tidak dilakukan sekarang.
- **Rust:** shell ditulis dalam Rust. Bagian ini dibuat sekecil mungkin dan dijelaskan bertahap sesuai `AGENT.md`.
- **WebView2:** sudah ada di Windows 11. Untuk Windows 10 lama, installer membawa bootstrapper yang memerlukan koneksi internet.
