# Bağımlılık güvenlik durumu — 23 Ekim 2026

Backend `pnpm audit --prod` sonucu 0 bulgudur. Frontend Nuxt 4.6.1 taramasında 2 high ve 3 moderate paket bulgusu vardı. Nuxt 4.6.2 güncellemesinden sonra aynı tarama **2 high, 0 moderate, 0 critical** bildirdi. Üç moderate paket bulgusu aşağıdaki iki Nuxt bildirimine aitti; node-forge ve braces açıkları giderilmiş sayılmaz.

| Paket / bildirim | Güncel durum |
| --- | --- |
| Nuxt / `@nuxt/nitro-server`: büyük-küçük harf değişimiyle route rules atlama | [GHSA-vjh5-4x84-xrqp](https://github.com/advisories/GHSA-vjh5-4x84-xrqp); 4.6.2 düzeltmesi uygulandı |
| Nuxt: server islands `useHeadSafe` sanitizasyonu | [GHSA-xfq5-w38q-pc2x](https://github.com/advisories/GHSA-xfq5-w38q-pc2x); 4.6.2 düzeltmesi uygulandı |
| `nuxt → nitropack → listhen → node-forge`: RSA imza doğrulamasında ASN.1 kontrolü | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv); <=1.4.0 etkilenmiş, 23 Ekim taramasında yayımlanmış yama bildirilmedi |
| `nuxt → nitropack → globby → micromatch → braces`: derin desenlerde stack taşması | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm); <=3.0.3 etkilenmiş, 23 Ekim taramasında yayımlanmış yama bildirilmedi |

Nuxt kaynak dependency olduğu için derleme/geliştirme araçları da `--prod` taramasına girer. Bulgular dependency kategorisi değiştirilerek veya audit bastırılarak gizlenmedi. Uyumluluğu belirsiz override ya da yerel kriptografi yaması uygulanmadı.

Üretim Dockerfile'ı yalnız derlenen `.output` dizinini taşır. `pnpm check:runtime`, `.output/server` içindeki manifestleri ve dependency/optionalDependency kayıtlarını tarayıp node-forge veya braces bulursa derlemeyi durdurur. CI ve Docker derlemesi bu kontrolü çalıştırır. İlk teslimin uzak frontend CI ve Docker kontrolü başarılıydı; yeni 4.6.2 çıktısında da 21 manifest kontrolü geçti; iki paket bulunmadı. Bu envanter kontrolü genel bir güvenlik denetimi veya bütün açıkların yokluğu kanıtı değildir.

Uygulama kullanıcı aramasını bu glob araçlarına iletmez; dosya işlemleri kendi API/MongoDB katmanından geçer. Geliştirme sunucusu yalnız loopback üzerinde dinler. Build/dev bağımlılıkları bakım kapsamında kalır; resmi yama veya bu bağımlılıkları kaldıran uyumlu sürüm geldiğinde frozen lockfile ile unit/tip/derleme/runtime ve CI kontrolleri yeniden yapılmalıdır. Canlı TLS/gateway kurulumu henüz tamamlanmadı.
