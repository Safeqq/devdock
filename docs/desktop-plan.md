# Rencana DevDock Desktop (draf untuk ditinjau)

Status: **draf, belum dikerjakan.** Dokumen ini menunggu persetujuan pengguna sebelum ada kode yang diubah.

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

## Pertanyaan yang masih terbuka

1. **Node untuk menjalankan proyek Anda.** Saat ini DevDock menjalankan `npm run` memakai Node miliknya sendiri. Di aplikasi desktop, proyek yang butuh Node 18/20 bisa gagal. Usul saya: pakai Node/npm yang terpasang di komputer (dari PATH) bila ada, dan pakai Node bawaan DevDock bila tidak ada. Ini perubahan perilaku, jadi perlu persetujuan.
2. **CLI npm 0.1.0.** Tarball CLI tetap dibangun sebagai jalur sekunder, atau dihentikan setelah aplikasi desktop tersedia? Usul saya: tetap ada, tetapi README mengutamakan aplikasi desktop.
3. **Dua DevDock bersamaan.** Aplikasi desktop dan CLI memakai database yang sama di `%LOCALAPPDATA%\DevDock`. Usul saya: kunci satu instance per database agar keduanya tidak mengelola service yang sama.

## Tahapan

Setiap tahap diakhiri verifikasi, lalu commit dan push.

| Tahap | Isi | Bukti selesai |
|---|---|---|
| D0 | Prasyarat: pengguna memasang Visual Studio Build Tools (Desktop development with C++). `AGENT.md` diperbarui: desktop wrapper masuk cakupan, target Windows dulu | `cargo build` contoh Tauri berhasil di mesin lokal |
| D1 | Spike: shell Tauri menjalankan sidecar, pairing otomatis, jendela menampilkan dashboard yang ada, dialog folder berfungsi | Demo lokal Windows; keempat asumsi di atas terjawab |
| D2 | Siklus hidup: tray, tutup ke tray, Keluar dengan shutdown rapi, single-instance, sidecar mati bila shell hilang, layar error bila sidecar gagal | Test otomatis: Keluar menghentikan service; kill shell tidak meninggalkan proses |
| D3 | UX desktop: onboarding, kartu script, panel Lanjutan, Grup, log, tombol Buka, bahasa sederhana | Browser/UI test diperbarui; review tampilan oleh pengguna |
| D4 | Packaging: Node + daemon dibundel, installer NSIS per-user, workflow CI Windows yang membangun installer lalu menginstal diam-diam, meluncurkan, dan menguninstal | Installer lulus smoke test di runner Windows; ukuran tercatat |
| D5 | Dokumentasi pengguna (cara install, peringatan SmartScreen, cara uninstall) dan rilis 0.2.0 | Rilis dibuat setelah konfirmasi pengguna |
| Nanti | macOS (`.dmg`), lalu Linux (`.AppImage`/`.deb`) | Matriks tiga OS seperti sekarang |

## Risiko dan batasan yang diketahui

- **SmartScreen:** karena installer tidak ditandatangani, Windows menampilkan "Windows protected your PC". Pengguna harus memilih *More info → Run anyway*. Ini dijelaskan di halaman rilis.
- **Ukuran:** sidecar Node membuat installer lebih besar daripada Lumine (sekitar 10 MB). Menulis ulang mesin ke Rust tidak dilakukan sekarang.
- **Rust:** shell ditulis dalam Rust. Bagian ini dibuat sekecil mungkin dan dijelaskan bertahap sesuai `AGENT.md`.
- **WebView2:** sudah ada di Windows 11. Untuk Windows 10 lama, installer membawa bootstrapper yang memerlukan koneksi internet.
