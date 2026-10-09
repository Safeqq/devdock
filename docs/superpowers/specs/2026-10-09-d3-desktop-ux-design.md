# D3 — UX desktop untuk pengguna pertama kali

Status: disetujui pengguna 2026-10-09 dengan arahan "kerjakan sesuai rekomendasi, ditinjau setelah selesai". Acuan tampilan: `docs/mockups/d3/` (commit `85c7ef5`).

## Tujuan

Pengguna yang baru pertama kali membuka DevDock bisa memilih folder proyek, menekan **Start**, lalu membuka aplikasinya di browser tanpa mengetik path, port, atau mengisi formulir teknis. Semua pengaturan teknis tetap tersedia, tetapi tersembunyi di panel **Script settings**.

## Keputusan

| Hal | Keputusan |
|---|---|
| Cakupan | Semua isi mockup: Welcome, Add project, kartu script, banner Quick start, output bertab, Script settings, Grup (termasuk dialog membuat grup), Open, dan Open folder |
| Bahasa UI | Inggris, konsisten dengan shell dan mockup |
| Mode browser (CLI 0.1.0) | Memakai UI baru yang sama. Dialog folder native diganti kolom path; Open memakai tautan tab baru |
| Tema | Gelap seperti mockup |

## Perubahan daemon dan kontrak

1. **Isi script pada discovery.** `ScriptDiscovery` mendapat `scripts: { name, command }[]`, dengan perintah dipotong maksimal 2.048 karakter. Isi ini berasal dari `package.json` proyek sendiri dan tidak memuat nilai environment.
2. **Periksa folder sebelum ditambahkan.** `POST /api/folders/inspect { path }` mengembalikan path tampilan, nama usulan, dan discovery tanpa mendaftarkan apa pun. Dialog "Add this project?" memakai endpoint ini.
3. **Ubah pengaturan service.** `POST /api/services/:id/settings` menerima port, readiness, restart policy, file env, dan key wajib dengan validasi yang sama seperti saat service dibuat. Run yang sedang berjalan tetap memakai konfigurasi lama sampai dijalankan ulang.
4. **Deteksi alamat aplikasi.** `RunLogBuffer` memindai output setiap run untuk URL loopback `http(s)://localhost|127.0.0.1|0.0.0.0|[::1]:PORT`. `0.0.0.0` dan `[::]` dinormalisasi menjadi `localhost`. Status service mendapat field `appUrl` (nullable).
5. **Open App.** Urutan prioritas URL:
   1. URL terdeteksi yang port-nya sama dengan port yang dikonfigurasi.
   2. Port yang dikonfigurasi (`http://127.0.0.1:PORT/`, seperti sekarang).
   3. URL terdeteksi pertama.

   URL hanya boleh mengarah ke loopback.
6. **Ringkasan runtime.** `GET /api/runtime/summary` mengembalikan jumlah script yang berjalan dan gagal per proyek, untuk sidebar.
7. **Info sistem.** `GET /api/system` mengembalikan sumber dan versi Node.js yang menjalankan proyek, untuk footer dan pratinjau perintah.

## Perubahan shell Tauri

Dua perintah native baru diberikan hanya kepada origin daemon:

- `open_in_browser(url)` memvalidasi URL `http`/`https` ke loopback di Rust, lalu membuka browser default.
- `open_folder(path)` memvalidasi bahwa path adalah direktori yang ada, lalu membukanya di Explorer.

Keduanya memakai fungsi dari `tauri-plugin-opener` tanpa memberikan izin plugin opener umum ke halaman, karena `openPath` umum dapat menjalankan file executable.

## UI

- **Welcome:** muncul bila belum ada proyek. Berisi penjelasan "What's a script?", tiga langkah, tombol **Choose a project folder**, dan peringatan kepercayaan.
- **Add project:** dialog konfirmasi yang memuat path, daftar script beserta deskripsinya, "Nothing runs until you press Start", dan nama yang ditampilkan.
- **Kartu script:** satu kartu untuk setiap script di `package.json`. Kartu menampilkan deskripsi sederhana, jenis script ("keeps running"/"runs once"), perintah, status dalam kata-kata, alasan gagal, dan durasi.
  - Service dibuat otomatis saat script pertama kali dijalankan atau saat pengaturannya pertama kali disimpan.
  - Script lifecycle npm (`pre*`/`post*` untuk script yang ada, `prepare`, dan hook install) disembunyikan di bawah "Show N more".
- **Status:** Not running/Never run, Starting…, Running, Running · Ready, Stopping…, Finished, Failed, dan Status unknown.
  - Tanpa readiness, script dianggap Ready begitu output memuat alamat aplikasi.
- **Quick start:** banner muncul pada proyek yang belum pernah menjalankan script dan menunjuk script yang direkomendasikan (`dev`, `start`, `serve`, `develop`, `preview`). Banner bisa ditutup.
- **Output:** satu tab untuk setiap script yang punya run, dengan tombol Copy dan Clear (Clear hanya membersihkan tampilan). Tampilan otomatis menggulir ke bawah kecuali pengguna sedang menggulir ke atas. Satu koneksi SSE aktif dalam satu waktu.
- **Script settings:** panel samping dengan bagian Opening your app, When is it ready?, Environment, If it crashes, Check port and environment, dan What DevDock runs.
- **Grup:** kartu grup dengan Start/Stop. Dialog **New group** berisi nama, pilihan script, dan pilihan "one after another" (rantai sesuai urutan pilihan) atau "all at once".
- **Header proyek:** path, Open folder, Stop all (N), serta menu ⋯ berisi Export settings dan Remove from DevDock (archive).
- **Sidebar:** daftar proyek dengan status singkat, tombol +, **How DevDock works**, dan status mesin beserta versi Node.js.
- Pesan error memakai bahasa sederhana. Kode teknis hanya muncul sebagai detail.

## Di luar cakupan

- Menghapus service atau grup (backend belum mendukung).
- Mengedit grup.
- Tema terang.
- Notifikasi Windows.
- Ikon final (masuk D4).

## Tahapan dan verifikasi

| Tahap | Isi | Bukti |
|---|---|---|
| D3.1 | Kontrak dan daemon: isi script, inspect folder, settings service, deteksi URL, Open App, ringkasan runtime, info sistem | Unit/integration test baru; suite lama tetap lulus |
| D3.2 | UI baru: welcome, add project, kartu, output, settings, grup, menu proyek; browser test ditulis ulang | `npm run typecheck`, lint, `test:browser` |
| D3.3 | Shell: `open_in_browser`, `open_folder`; verifikasi desktop | `cargo build`, `desktop:verify` |
| D3.4 | Dokumentasi: progress, rencana desktop, screenshot UI nyata | Review tampilan oleh pengguna |
