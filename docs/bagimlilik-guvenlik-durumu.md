# Bağımlılık güvenlik durumu

**24 Ekim 2026** üretim taramasında backend için bildirim yoktur. Express 5.3.0, body-parser 2.4.0 ve Nodemailer 10.1.4 güvenlik güncellemeleri uygulanmıştır. Sürümler lockfile ile sabittir; CI `pnpm audit --prod` hatasında durur.

Bu anlık sonuç uygulamanın bütün olası güvenlik sorunlarından arınmış olduğu anlamına gelmez. Scrypt/session/CSRF/OAuth, tenant ve stream kontrolleri ayrıca test edilir; sırlar kaynak depoya alınmaz.

Frontend ayrı bağımlılık ağacına sahiptir. Yamasız node-forge araç zinciri bildirimi, runtime dışlama ve dar kapsamlı audit istisnası [frontend güvenlik kaydındadır](https://github.com/ahmetkocdeveci/google-drive-clone-frontend/blob/main/docs/bagimlilik-guvenlik-durumu.md).
