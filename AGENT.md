# AGENT.md — DevDock

Panduan coding agent dan belajar bertahap. Keputusan terbaru (2026-10-09): DevDock menjadi aplikasi desktop Tauri v2 yang menjalankan daemon Node.js/TypeScript sebagai sidecar dan menampilkan UI React di jendela native; Windows lebih dahulu, macOS dan Linux menyusul bertahap. Rencana dan keputusan rinci ada di `docs/desktop-plan.md`. Roadmap v1 berbasis dashboard browser (Fase 0–7) sudah terverifikasi pada tiga OS dan dirilis sebagai 0.1.0. Tidak menggunakan Flutter atau Electron.

## 1. Penggunaan dan prioritas

Letakkan file ini di root repository DevDock. Muat sebagai instruksi coding tool; apabila tool memerlukan nama `AGENTS.md`, gunakan nama tersebut sesuai konfigurasinya. Jangan menganggap nama `AGENT.md` otomatis dibaca oleh setiap tool.

Instruksi pengguna saat ini dan instruksi dengan prioritas lebih tinggi tetap berlaku. Baca `devdock-project-plan.md` bila tersedia untuk rincian produk. Dalam hal target platform, keputusan terbaru pada dokumen ini memperjelas rencana awal: rilis v1 harus diverifikasi pada Windows, macOS, dan Linux. Implementasi bertahap pada satu OS tidak mengurangi target akhir tersebut.

Dokumen ini bukan perintah untuk mengimplementasikan seluruh roadmap sekaligus. Kerjakan lingkup yang diminta. DevDock merupakan proyek tersendiri; jangan menambahkan domain incident monitoring atau job image processing dari proyek lain.

## 2. Tujuan produk dan batas lingkup

DevDock membantu developer mengelola proyek lokal melalui satu dashboard: registrasi folder, discovery script, start/stop/restart service, live log, readiness, diagnosis konfigurasi, serta profil startup.

Alur utama: pilih proyek → pilih service/profil → Start → lihat status dan log → Open App → Stop.

### MVP

- Registrasi folder dan discovery script `package.json` tanpa execution.
- Service config: script, working directory, expected port, optional readiness, env-file references.
- Start, stop, restart; satu run aktif per service.
- Live stdout/stderr, status proses, dan run history.
- Dashboard project/service/log dengan loading, empty, disconnected dan error state.
- Penyimpanan lokal SQLite dan kontrol akses daemon sejak UI dapat menjalankan command.

### Lengkap untuk v1

- Profiles, dependency graph, readiness timeout, dan rollback startup terarah.
- Pemeriksaan port dan nama required environment keys.
- Bounded restart policy, default off.
- Graceful shutdown, crash reconciliation dan stale-run protection.
- Export konfigurasi non-secret.
- Packaging serta integration tests native pada tiga keluarga OS.

Ditunda: Flutter, terminal interaktif/PTY, cloud sync, remote execution, akun tim, install dependency otomatis, Docker control, Git overview, AI debugger, Redis, broker, dan Kubernetes. Database proyek dapat menjadi dependensi eksternal dengan readiness check; v1 tidak mengambil alih proses database yang tidak dimulai DevDock.

DevDock menjalankan kode dengan hak pengguna OS. Ia bukan sandbox untuk repository tak tepercaya dan bukan process manager produksi.

## 3. Cara agent mendampingi belajar

1. Gunakan bahasa Indonesia untuk penjelasan; gunakan identifier dan README portofolio berbahasa Inggris.
2. Default satu sublangkah per sesi. Sebelum edit, jelaskan tujuan, konsep, dan file yang terpengaruh secara singkat.
3. Jika pengguna meminta satu fase penuh, tuntaskan fase tersebut; jangan meminta konfirmasi setiap sublangkah yang sudah diotorisasi.
4. Jelaskan istilah baru melalui alur nyata. Contoh: child process adalah program yang diluncurkan daemon, sedangkan readiness menjawab apakah program itu sudah siap melayani request.
5. Buat perubahan kecil yang dapat dijalankan. Hindari menulis semua folder, interface, dan fitur masa depan sejak awal.
6. Setelah perubahan, jelaskan apa yang berubah, mengapa, cara mencoba, dan hasil test. Tambahkan satu latihan opsional dan 1–2 pertanyaan pemahaman.
7. Latihan bukan syarat izin melanjutkan. Jangan mengklaim pengguna memahami materi hanya karena test lulus.
8. Saat diminta “lanjut”, gunakan checkpoint dan repository nyata. Jangan menebak progres atau mengulang fase yang sudah terverifikasi.
9. Jika lingkungan tidak mendukung satu OS, lanjutkan pekerjaan lokal yang berguna dan tandai pengujian OS tersebut pending; jangan diam-diam menghapusnya dari kriteria rilis.
10. Pertahankan pekerjaan pengguna. Jangan melakukan refactor luas, mengubah stack, atau memublikasikan artefak tanpa relevansi dan otorisasi tugas.

Saat implementasi dimulai, buat `docs/progress.md` dengan fase/subfase aktif, perubahan selesai, command dan hasil verifikasi, keputusan, keterbatasan, latihan opsional, serta langkah berikutnya. Pisahkan `implemented`, `verified`, dan `blocked`; fase belum selesai jika acceptance gate belum terbukti.

## 4. Arsitektur yang harus dijaga

Gunakan backend modular monolith dalam satu daemon Node.js. Daemon menjalankan API dan supervisor; React SPA ditampilkan di jendela aplikasi desktop (Fase 8) atau, untuk CLI 0.1.0, di browser. Shell desktop Tauri hanya mengelola jendela, sidecar, dan fitur native (dialog, tray, notifikasi); logika proses tetap di daemon. HTTP membawa command; SSE membawa status dan log. SQLite menyimpan konfigurasi dan histori, bukan jaminan bahwa PID lama masih hidup.

| Lapisan | Tanggung jawab |
|---|---|
| Transport | Fastify handlers, schema validation, session dan SSE |
| Application | Operasi register/start/stop/profile dan koordinasi persistence |
| Domain | State transition, ownership policy, dependency graph |
| Infrastructure | Process adapter, SQLite, filesystem, readiness probe |

Domain tidak mengimpor React, Fastify, SQLite driver, atau API OS. Supervisor menggunakan platform interface; UI tidak menjalankan command secara langsung. Dependency graph package harus acyclic.

Stack: Node.js LTS yang didukung saat implementasi, TypeScript strict, Fastify, React, Vite, SQLite, SSE. Pilih driver SQLite yang teruji pada runtime dan arsitektur mesin target. Pin runtime/package manager dan commit lockfile. Gunakan npm untuk baseline tooling; adapter proyek pnpm/yarn dapat menyusul setelah diuji atau menjadi perubahan scope eksplisit.

Struktur target, dibuat hanya saat diperlukan:

| Path | Isi |
|---|---|
| `apps/daemon/` | Entry CLI, API, application modules, supervisor composition |
| `apps/web/` | UI projects, services, profiles, logs |
| `apps/desktop/` | Shell Tauri v2 (Rust): jendela, sidecar daemon, tray, dialog, installer |
| `packages/domain/` | State, graph, policy dan domain errors |
| `packages/contracts/` | Runtime schemas, request/response/event types |
| `packages/platform/` | Windows/POSIX process dan platform utilities |
| `packages/storage/` | SQLite migrations dan persistence |
| `tests/fixtures/` | Program uji process tree, log, readiness dan failure |
| `docs/` | Progress, support matrix, ADR, API, troubleshooting |

## 5. Kontrak lintas platform

### Target dan matriks dukungan

Target rilis: Windows native, macOS, Linux. WSL bukan bukti dukungan Windows native. CI Linux bukan bukti semua distribusi Linux; satu CPU architecture bukan bukti semua architecture.

Buat `docs/platform-support.md` pada fase 0. Catat untuk tiap kombinasi: versi OS, CPU architecture, Node, package manager, driver SQLite, command test, hasil/tanggal, keterbatasan. Status awal semua `not_tested`. Tambahkan kombinasi yang benar-benar diuji dan jelaskan support range; jangan menjanjikan “semua versi OS”.

### Adapter

Pisahkan `ProcessAdapter`, package-manager launcher, path/data-directory resolver dan port/probe utility. Kontrak process meliputi start, inspect ownership, graceful-stop capability, terminate-owned-tree, dan wait-for-exit. Kembalikan managed handle yang mengikat `run_id`, process identity, serta resource OS yang dimiliki. PID saja tidak cukup.

- Gunakan `node:path`, canonical path dan filesystem API; jangan merangkai path dengan `/` atau menganggap drive/case sensitivity sama.
- Simpan display path terpisah dari identitas canonical. Jangan lowercase semua path atau seluruh drive secara membabi buta. Dokumentasikan kebijakan symlink, UNC/network path dan scope cwd; fitur yang belum didukung harus ditolak secara jelas.
- Gunakan direktori data pengguna sesuai OS, bukan hardcoded `/tmp`, `/home`, atau `C:\\...`.
- Tangani executable/shim npm di Windows secara khusus. Jangan membuat command dari interpolasi string pengguna atau mengaktifkan `shell: true` secara global.
- Script npm dapat memakai shell di dalamnya; array argumen pada launcher tidak menjadikan isi repository tepercaya secara otomatis.
- POSIX process-group behavior boleh dibagi Linux/macOS jika benar-benar teruji. Windows memerlukan mekanisme ownership/tree yang sesuai, misalnya Job Objects melalui adapter/native helper bila dipilih. Jangan menjanjikan SIGTERM dan graceful-stop identik pada Windows.
- Jika graceful stop tidak tersedia, laporkan capability dan fallback yang nyata. Jangan mengaku graceful padahal selalu force-kill.
- Fixture pengujian ditulis dengan Node.js; jangan mengandalkan `sleep`, `kill`, `rm`, bash, atau PowerShell pada shared test scripts.
- Jalankan CI pada runner Windows, macOS, dan Linux. Mock hanya memverifikasi logika; lifecycle OS perlu proses nyata.

## 6. Invariant supervisor

- Satu daemon aktif per data directory/control endpoint. Gunakan mekanisme single-instance dengan verifikasi, bukan menghapus lock yang dianggap stale tanpa bukti.
- Setiap spawn mendapat `run_id` baru. Event atau timeout dari run lama tidak boleh memutasi run baru.
- Serialize start/stop/restart per service. Start concurrent saat starting/running mengembalikan run aktif, tidak spawn ganda. Start saat stopping menunggu atau ditolak konsisten; jangan overlap.
- Status proses: `stopped`, `starting`, `running`, `stopping`, `exited`, `failed`. State rekonsiliasi `unknown` menandai ownership yang tidak bisa dipastikan setelah crash.
- Readiness terpisah: `unknown`, `checking`, `ready`, `unhealthy`. Tanpa probe jangan tampilkan healthy palsu.
- Successful spawn bukan bukti readiness. HTTP 202 berarti operasi diterima; UI menunggu status berikutnya.
- Stop menargetkan tree milik run, menunggu grace period sesuai platform, lalu eskalasi hanya setelah verifikasi ownership. Jangan kill proses berdasarkan port, nama executable umum, atau PID histori saja.
- Restart menunggu tree lama berhenti. Jika cleanup belum dapat dibuktikan, laporkan stopping/unknown; jangan start pengganti yang berpotensi ganda.
- Closing browser tidak menghentikan service. Graceful daemon shutdown menutup admission, membatalkan restart timers, dan menghentikan service miliknya.
- Forced daemon termination mungkin meninggalkan proses tergantung platform. Pada startup berikutnya, periksa metadata identitas; jika ragu, tandai interrupted/unknown dan beri instruksi inspeksi. Jangan auto-adopt/auto-kill.
- Tidak ada auto-start ketika daemon baru dijalankan pada v1.
- Proses yang sengaja lepas dari containment/group yang didukung berada di luar jaminan stop; dokumentasikan daripada membuat klaim seluruh descendants selalu tertangani.
- Distinguish spawn error, exit dan stdio close; tunggu drain log akhir tanpa memutasi state dua kali. Failure reason dan exit code tetap tersimpan.

## 7. Profiles, readiness, dan environment

- Validasi DAG dependency sebelum start; cycle ditolak dengan penjelasan jalurnya.
- Dependensi dimulai dahulu. Gunakan probe TCP/HTTP yang dikonfigurasi dan dibatasi loopback, timeout, serta validasi redirect/tujuan. Port terbuka tidak membuktikan identitas service milik DevDock.
- Dependensi yang diwajibkan ready harus memiliki probe; jangan diam-diam mengganti ready menjadi process spawned.
- Jika profile start gagal, rollback hanya run yang dibuat operasi tersebut. Service yang sudah berjalan sebelumnya tetap hidup.
- Track pemakaian service antarprofile. Stop profile tidak menghentikan service yang masih dipakai profile lain; tampilkan konflik yang bisa diputuskan pengguna.
- Dependensi crash setelah startup membuat profile degraded. Tidak otomatis membunuh dependennya pada v1.
- Restart policy opsional, default off, bounded attempts dan backoff. User stop membatalkan semua restart pending.
- Port check advisory: konflik dapat terjadi sesudah check. Jangan auto-kill atau auto-change port milik proyek.
- Discovery hanya membaca JSON. Tidak ada install, source env, atau execution saat import/scan.
- Environment memakai referensi file dan pemeriksaan key. Definisikan precedence secara tertulis; filter secret milik daemon sebelum diwariskan. Nilai secret tidak disimpan di SQLite, diekspor, atau dikirim ke browser.
- `.env.example` membantu menemukan key; key tersedia belum membuktikan nilai benar. Gunakan parser data, jangan mengeksekusi file env.

## 8. Log dan realtime

Event envelope: `daemon_session_id`, `run_id`, `sequence`, `timestamp`, `type`; log menambah `stream` dan `text`. Validasi runtime, bukan mengandalkan type assertion.

- Decode UTF-8 incremental; data chunk bukan satu baris utuh. Batasi fragment tanpa newline sebelum seluruh baris terakumulasi.
- Batas awal ring buffer per service: 5.000 baris atau 5 MiB, mana lebih dulu. Batasi line 16 KiB, tampilkan truncation marker. Terapkan juga bound pada SSE client queue dan DOM frontend.
- Drain stdout/stderr walaupun tidak ada browser, UI pause, atau client lambat. Client yang tertinggal menerima gap marker, bukan membuat child process macet.
- Render plain text, sanitasi escape/control sequences; jangan `dangerouslySetInnerHTML` untuk log.
- Sequence menunjukkan urutan diterima daemon, bukan klaim urutan waktu global stdout/stderr.
- SSE reconnect membawa cursor; replay hanya yang masih tersimpan. Cursor terlalu lama atau daemon session berubah memicu reset/gap dan snapshot state baru.
- Default raw logs hanya di memori. SQLite menyimpan metadata run dan ringkasan aman. Disk logs opsional membutuhkan rotasi dan retention.
- Pencarian awal literal; hindari regex pengguna tanpa pembatasan kompleksitas.
- Redaksi secret yang diketahui bersifat best effort, bukan jaminan seluruh keluaran proyek bebas secret.

## 9. Keamanan dan persistence

- Bind loopback dengan host/port eksplisit; tanpa LAN exposure atau administrator/root.
- UI/API satu origin saat rilis. Allowlist Host/Origin, tolak wildcard CORS; cek Host mencegah sebagian serangan menuju localhost namun tidak menggantikan autentikasi.
- CLI menampilkan pairing code acak sekali pakai dengan expiry; endpoint pairing dibatasi percobaan. Tukar menjadi session HttpOnly SameSite dan gunakan CSRF protection untuk mutasi.
- Lindungi log stream dengan session juga. Jangan menjalankan command lewat GET. Jangan menaruh credential persisten pada URL/localStorage atau raw logs. Bootstrap code hanya ditampilkan di output CLI yang dimaksud, tidak ikut disimpan pada log aplikasi.
- Konfigurasi Vite dev origin/proxy harus eksplisit dan tetap authenticated; jangan mengandalkan bypass auth pada development.
- User memilih repo dan script yang dipercaya. Import konfigurasi tidak boleh otomatis start. Preview executable/argumen/cwd tanpa menampilkan secret.
- API menerima service ID/config tervalidasi, bukan arbitrary shell text. Canonicalisasi cwd dan batas path sebelum akses.
- Gunakan SQL parameter binding, migration versi, transaksi singkat. Jangan menahan transaksi saat menunggu proses/network.
- Periksa adapter/storage initialization errors dan tutup resource saat startup gagal. Archive/delete project tidak menghapus source code proyek.
- Konfigurasi ekspor tidak memuat secret. Runtime metadata tidak digunakan sebagai otoritas untuk kill.

## 10. Fase belajar dan implementasi

Seluruh checkbox dimulai belum selesai. OS utama adalah tempat iterasi pertama; tiga OS tetap gate rilis. Estimasi waktu baru dibuat setelah spike process-tree pada fase 1, karena Windows/native dependencies dapat mengubah usaha secara material.

### Fase 0 — Fondasi dan kontrak platform

**Belajar:** Node runtime, TS strict, repository layout, perbedaan shared logic dan adapter.

- [ ] 0.1 Periksa repo/tooling yang tersedia, OS utama dan kebutuhan pengguna; tentukan baseline Node LTS dan package manager yang dipin.
- [ ] 0.2 Buat workspace minimal, README startup, contoh environment tanpa secret, progress dan matriks platform.
- [ ] 0.3 Tentukan kontrak service/run/state dan ProcessAdapter tanpa membangun abstraksi generik.
- [ ] 0.4 Buat fixture Node HTTP server dengan readiness endpoint dan cleanup.

**Verifikasi/gate:** setup dan fixture berjalan pada OS utama; matriks tiga OS tersedia dengan status jujur. Tidak ada klaim dukungan dari typecheck saja.

**Latihan:** ubah port fixture. **Pertanyaan:** bagian mana harus sama di semua OS, bagian mana tidak?

### Fase 1 — Supervisor satu service

**Prasyarat:** fase 0. **Belajar:** spawn, stream, event ordering, process tree, ownership.

- [ ] 1.1 Implementasikan CLI start/inspect/stop untuk fixture pada adapter OS utama.
- [ ] 1.2 Tambahkan run ID, serialization operasi, status, exit/error handling dan timeout cleanup.
- [ ] 1.3 Uji fixture yang spawn child serta proses eksternal sebagai sentinel yang tidak boleh dihentikan.
- [ ] 1.4 Buat spike Windows native dan POSIX adapter dalam CI untuk menemukan hambatan sebelum UI membesar; catat missing capability.

**Verifikasi/gate:** double start membuat satu run, stop mengakhiri tree fixture, restart menghasilkan ID baru, sentinel tetap hidup. Spike platform yang belum dapat dijalankan dicatat sebagai blocker rilis, bukan lulus.

**Latihan:** tampilkan exit reason. **Pertanyaan:** mengapa kill satu PID belum cukup?

### Fase 2 — Project registry dan SQLite

**Prasyarat:** fase 1 pada OS utama. **Belajar:** parsing, validation, migration, canonical path.

- [ ] 2.1 Registrasi project path, dedup, archive, dan validasi cwd.
- [ ] 2.2 Discovery `package.json` yang tidak menjalankan kode; pengguna memilih script untuk service.
- [ ] 2.3 Simpan projects/services/runs/settings dan migration dalam SQLite.
- [ ] 2.4 Implementasikan npm launcher adapter; test path dengan spasi, Unicode dan karakter shell yang legal pada OS target.

**Verifikasi/gate:** restart menjaga konfigurasi; malformed JSON memberi error jelas; script fixture dengan side effect tidak dijalankan saat discovery; archive tidak menghapus source.

**Latihan:** tambahkan label service. **Pertanyaan:** mengapa schema TypeScript belum cukup untuk memvalidasi JSON?

### Fase 3 — Dashboard MVP dan akses lokal

**Prasyarat:** fase 2. **Belajar:** React, API contract, SSE, session dan CSRF.

- [ ] 3.1 Tambahkan pairing/session, loopback Host/Origin checks, autentikasi API/SSE dan perlindungan mutasi sebelum UI dapat menjalankan script.
- [ ] 3.2 Buat project list/detail, service control, command preview, log panel dan Open App dengan URL tervalidasi.
- [ ] 3.3 Implementasikan bounded log buffer, streaming decoder dan satu stream multiplex per dashboard bila praktis.
- [ ] 3.4 Tambahkan loading/empty/error/disconnected state, cleanup subscription dan akses keyboard.

**Verifikasi/gate:** browser → start → log → stop bekerja nyata; tab ditutup tidak mematikan child; request tanpa session atau dari origin asing ditolak. Tidak ada fake success/mock data pada demo integrasi.

**Latihan:** filter stdout/stderr. **Pertanyaan:** mengapa local daemon tetap membutuhkan autentikasi?

### Fase 4 — Diagnostics dan profiles

**Prasyarat:** fase 3. **Belajar:** DAG, readiness, koordinasi operasi dan rollback.

- [ ] 4.1 Tambahkan port check dan environment key diagnostics tanpa menampilkan nilai.
- [ ] 4.2 Pisahkan process state/readiness, implementasikan probe dan timeout.
- [ ] 4.3 Profiles/dependencies, topological start, cycle detection dan tracking ownership operasi.
- [ ] 4.4 Rollback hanya service baru, lindungi service pre-existing/shared, tampilkan profile degraded.

**Verifikasi/gate:** cycle ditolak, readiness gagal menghentikan startup, port conflict tidak mematikan sentinel, rollback tidak menghentikan service milik operasi sebelumnya.

**Latihan:** buat Backend Only dan Full Stack. **Pertanyaan:** mengapa running belum tentu ready?

### Fase 5 — Reliability dan reconciliation

**Prasyarat:** fase 4. **Belajar:** backpressure, race condition, stale events dan crash boundary.

- [ ] 5.1 Uji log flood, panjang baris ekstrem, UTF-8 split, UI lambat dan SSE reconnect/gap.
- [ ] 5.2 Implementasikan shutdown terarah, delayed events protection, cleanup timers/listeners.
- [ ] 5.3 Tambahkan bounded restart policy default off dan cancel scheduled restart ketika user Stop.
- [ ] 5.4 Reconcile run histori setelah forced daemon termination; unknown ownership tidak memicu kill/start otomatis.

**Verifikasi/gate:** memory/buffer bounded, child log producer tidak tersumbat client lambat, stale close event tidak merusak run baru, stop saat restart timer pending tidak menyalakan service kembali.

**Latihan:** tulis timeline sebuah crash. **Pertanyaan:** bukti apa yang dibutuhkan sebelum PID lama dianggap masih milik kita?

### Fase 6 — Paritas Windows, macOS, Linux dan packaging

**Prasyarat:** fase 5; spike fase 1 ditindaklanjuti. **Belajar:** portability, process capabilities, binary dependency dan distribusi.

- [ ] 6.1 Lengkapi adapter Windows native serta POSIX; bedakan graceful/forced stop sesuai capability nyata.
- [ ] 6.2 Jalankan suite kontrak yang sama pada tiga OS: spawn npm, tree stop, concurrent start, readiness, SSE, SQLite persistence dan auth.
- [ ] 6.3 Uji path spasi/Unicode, supported symlink policy, user data directory, environment casing dan executable discovery.
- [ ] 6.4 Buat entry CLI/packaging yang dapat dijalankan dari clean install tanpa admin, desktop wrapper atau shell Unix wajib.
- [ ] 6.5 Uji shutdown dengan signal/window-close behavior sesuai OS; audit pairing, secret filtering dan Open App URL.

**Verifikasi/gate:** laporan per OS/version/architecture mencantumkan hasil nyata. Windows native tidak digantikan WSL. Ketiga keluarga OS wajib lulus pada kombinasi yang dinyatakan supported sebelum rilis v1 cross-platform.

**Latihan:** jelaskan satu bug portability yang ditemukan. **Pertanyaan:** mengapa Windows runner tetap diperlukan meskipun seluruh kode TypeScript?

### Fase 7 — Portofolio dan pemakaian nyata

**Prasyarat:** fase 6. **Belajar:** CI, observability, profiling dan dokumentasi trade-off.

- [ ] 7.1 Pakai DevDock pada dua proyek nyata yang dipercaya; dokumentasikan perintah dan batas integrasi.
- [ ] 7.2 Jalankan profiling workload fixture; ukur CPU/memory daemon terpisah dari child, API latency, log rate dan dropped events.
- [ ] 7.3 Tulis README Inggris, API/schema docs, troubleshooting dan ADR: local daemon, log pipeline, ownership lintas OS.
- [ ] 7.4 Rekam demo 3–5 menit: dua service, log, port conflict, readiness failure dan stop tanpa gangguan proses lain.
- [ ] 7.5 Uji clean setup mengikuti README dan update progress/platform matrix.

**Verifikasi/gate:** CI tiga OS lulus, demo dapat diulang, keterbatasan tertulis, tidak ada secret atau klaim benchmark palsu. Publikasi repository/package mengikuti otorisasi pengguna; local tool tidak perlu di-host sebagai website publik.

**Latihan:** jelaskan desain dalam dua menit. **Pertanyaan:** kapan desktop wrapper atau broker benar-benar diperlukan?

### Fase 8 — Aplikasi desktop (Windows dahulu)

**Prasyarat:** rilis 0.1.0; Visual Studio Build Tools dengan workload C++ di mesin pengembang. **Belajar:** proses sidecar, siklus hidup aplikasi desktop, capability Tauri, dan packaging installer.

- [ ] 8.0 Catat keputusan di `docs/desktop-plan.md` dan dokumen ini; siapkan toolchain Rust/MSVC.
- [ ] 8.1 Spike: shell Tauri menjalankan sidecar, pairing otomatis tanpa URL, dialog folder; jawab asumsi di rencana.
- [ ] 8.2 Siklus hidup: tray, tutup ke tray, Keluar dengan shutdown rapi, single-instance, sidecar berhenti bila shell hilang.
- [ ] 8.3 UX desktop: onboarding, kartu script, panel Lanjutan, Grup, log, bahasa sederhana.
- [ ] 8.4 Installer NSIS per-user dan workflow CI Windows yang menginstal, meluncurkan, dan menguninstal.
- [ ] 8.5 Dokumentasi pengguna dan rilis 0.2.0 setelah konfirmasi pengguna.

**Verifikasi/gate:** installer lulus smoke test di runner Windows; Keluar menghentikan service milik DevDock; kill shell tidak meninggalkan daemon atau service; suite kontrak tiga OS untuk daemon tetap lulus.

**Latihan:** gambarkan alur dari klik ikon sampai service berjalan. **Pertanyaan:** mengapa pairing otomatis tidak boleh lewat URL, dan apa yang terjadi pada service bila shell desktop crash?

## 11. Pengujian dan command

Baca manifest dan scripts yang benar-benar tersedia. Jangan mengarang `npm run ...` lalu mengklaim berhasil. Pada fase 0 definisikan command untuk typecheck, lint, unit tests, integration tests, browser tests dan build, kemudian dokumentasikan.

Jalankan targeted checks untuk perubahan, diikuti gate CI relevan. Perubahan dokumentasi saja cukup diperiksa konten/link. Test OS-specific tidak boleh di-skip dan kemudian dilaporkan lulus untuk OS tersebut.

Fixture minimum: normal HTTP server, delayed readiness, immediate failure, log flooder, UTF-8 partial writer, child/grandchild tree, port conflict, stubborn process dengan perilaku per OS, dan external sentinel. Setiap test memiliki run-scoped ownership, timeout dan cleanup `finally`; jangan global kill berdasarkan nama proses.

Gunakan fake timers untuk backoff domain; integration lifecycle memakai proses nyata dan wait-until bounded, bukan sleep panjang acak. Injeksi factory/clock diperlukan hanya pada batas yang membantu test, bukan semua fungsi.

Saat SQLite driver membutuhkan native binary, verifikasi instalasi pada matriks platform/CPU yang didukung. Jalankan install terkontrol hanya untuk dependency DevDock; discovery repo pengguna tidak melakukan install.

Target eksperimen awal: maksimal 10 service fixture, kontrol API p95 <200 ms di luar startup child, normal-load log latency <500 ms. Ini hipotesis, bukan acceptance angka universal. Catat hardware, OS, Node, log rate, durations, memory limit, serta gap count dan jangan mengarang hasil.

## 12. Aturan kualitas TypeScript

- `strict` aktif. Hindari `any` dan non-null assertions untuk menutupi input invalid; gunakan narrowing, runtime schemas dan discriminated unions.
- Error domain memiliki kode dan pesan aman; jangan kirim stack trace atau environment dump ke UI.
- Semua async task/listener/timer memiliki owner dan lifecycle cleanup; rejected promises tidak diabaikan.
- Hindari sync long-running filesystem/process work pada request path. Buffer dan antrean client selalu dibatasi.
- Jangan memindahkan rahasia ke shared contracts atau build frontend. Parameter SQL selalu bound.
- Jangan edit migration yang sudah dipakai; buat migration baru dengan kompatibilitas yang jelas.
- UI menampilkan fakta server, bukan menganggap sukses hanya karena tombol diklik. Batasi rendered log rows dan bersihkan EventSource saat unmount.
- Perubahan OS detection hanya di composition/platform layer, bukan tersebar di UI/domain.
- Komentar menjelaskan intent atau keterbatasan, bukan menyalin nama fungsi.

## 13. Checkpoint, handoff, dan selesai

Format minimal `docs/progress.md`:

```markdown
# DevDock Progress
Fase/subfase aktif: 0 / 0.1
Status: not_started | in_progress | blocked | verified
OS utama: belum diperiksa

## Selesai
- Perubahan dan file

## Verifikasi
- Command, OS/runtime, tanggal, hasil

## Belajar
- Konsep dan latihan opsional

## Blocker dan batas dukungan
- Bagian yang belum teruji beserta dampaknya

## Berikutnya
- Satu sublangkah konkret
```

Handoff agent selalu memuat perubahan, alasan, test/result dan keterbatasan material. Jangan mencampur “ditulis”, “dijalankan”, dan “lulus di tiga OS”. Produk selesai jika fitur v1 dan seluruh gate platform yang dinyatakan didukung terverifikasi, setup reproducible, demo tersedia, serta pengelolaan proses tidak merusak aplikasi lain.

Instruksi awal yang disarankan: “Baca AGENT.md DevDock. Mulai fase 0.1, jelaskan konsepnya sambil mengerjakan, dan simpan checkpoint.”
