# D3.5 — Menutup celah sebelum packaging

Status: disetujui pengguna 2026-10-10 ("kerjakan D3.5 dengan keempat poin itu"), dikerjakan sesuai rekomendasi lalu ditinjau setelah selesai.

## Tujuan

Pengguna baru tidak boleh terjebak sebelum installer 0.2.0 beredar. D3.5 menutup empat celah:

1. Grup yang salah dibuat tidak bisa diubah atau dihapus. Pengaturan script juga tidak bisa dilupakan.
2. Menu tray belum menampilkan apa yang berjalan dan belum bisa menghentikan semuanya tanpa keluar.
3. Saat jendela tersembunyi di tray, pengguna tidak tahu bila script crash atau gagal siap.
4. Kartu berstatus *Status unknown* setelah DevDock crash tidak punya jalan keluar.

## Keputusan

| Hal | Keputusan |
|---|---|
| Hapus service | Di UI disebut **Reset to defaults** (script masih ada di `package.json`, kartu tetap tampil) atau **Remove card** (kartu tanpa script di root, misalnya script yang sudah dihapus dari `package.json`). Ditolak bila run masih aktif, status belum diketahui, atau script masih anggota grup. Histori run service ikut dihapus. |
| Edit dan hapus grup | Dialog grup dipakai juga untuk mengedit: nama, script, dan urutan. Tombol **Delete group** ada di dialog edit dengan konfirmasi. Ditolak selama grup berjalan. |
| Status unknown | Tidak ada auto-adopt atau auto-kill (invariant `AGENT.md` §6). Tombol **Check** memeriksa apakah PID lama masih dipakai suatu proses dan apakah port yang dikonfigurasi terpakai. PID dapat dipakai ulang proses lain, jadi hasilnya hanya petunjuk. Pengguna menutup program itu sendiri bila perlu, lalu menekan **Mark as stopped**. Ini hanya berlaku untuk run histori dari sesi daemon sebelumnya. Run yang masih dipegang daemon saat ini diarahkan ke Stop lagi. |
| Tray | Daemon mengirim event `runtime-summary` lewat stdout sidecar setiap jumlah script aktif berubah. Shell menampilkan jumlah per proyek (maksimal 5 baris), tooltip, dan **Stop all scripts** yang mengirim `{"type":"stop-all"}` lewat stdin. Daemon menghentikan grup aktif lebih dulu, lalu semua script aktif. |
| Notifikasi | Daemon mengirim event `script-alert` (judul dan isi sudah berupa teks) ketika run gagal: exit dengan error, gagal launch, atau tidak siap tepat waktu. Shell menampilkan notifikasi Windows lewat `tauri-plugin-notification` hanya bila jendela utama tersembunyi atau tidak fokus. |
| Istilah | Tray memakai kata "scripts" seperti UI: **Quit DevDock (stops all scripts)**. |

## API baru

Semua mutasi memakai POST dengan Origin dan CSRF seperti endpoint lain.

- `POST /api/services/:id/delete` menghasilkan `{ id }`. Error `SERVICE_ACTIVE` dan `SERVICE_IN_GROUP` (409).
- `POST /api/profiles/:id/update` dengan body yang sama seperti membuat grup, menghasilkan `{ profile }`. Error `PROFILE_ACTIVE` (409).
- `POST /api/profiles/:id/delete` menghasilkan `{ id }`. Error `PROFILE_ACTIVE` (409).
- `GET /api/services/:id/leftover` menghasilkan `{ pid, processRunning, port, canMarkStopped }`. Error `RUN_NOT_UNKNOWN` (409) bila status tidak unknown.
- `POST /api/services/:id/mark-stopped` menghasilkan `{ snapshot }` dengan state `stopped/known` dan alasan `MARKED_STOPPED_BY_USER`. Error `RUN_NOT_UNKNOWN` (409).

## Protokol sidecar

Tambahan pada pipa kontrol yang sudah ada (JSON per baris):

- stdout `{"type":"runtime-summary","active":N,"projects":[{"name":"…","active":N}]}`
- stdout `{"type":"script-alert","title":"…","body":"…"}`
- stdin `{"type":"stop-all"}`

## Di luar cakupan

- Mode gelap.
- Mengganti nama script atau service.
- Notifikasi pada mode browser (CLI 0.1.0).
- Auto-adoption proses dari sesi sebelumnya.

## Verifikasi

- Unit: `markStopped`/`forget` pada runtime manager, dan ringkasan, alert, serta stop-all pada bridge desktop.
- Integration: endpoint baru dengan storage nyata, termasuk run histori unknown. Sidecar: `runtime-summary` dan `stop-all` lewat pipa kontrol.
- Browser: edit dan hapus grup, serta reset pengaturan script.
- Desktop: `cargo build`, `desktop:verify`, dan cek manual tray serta notifikasi di Windows.
