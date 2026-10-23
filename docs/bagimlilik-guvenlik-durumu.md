# Bağımlılık güvenlik durumu — 21 Ekim 2026

Backend `pnpm audit --prod` kontrolünde bilinen açık bildirmedi. Frontend kaynak paketinde aynı komut **iki high bulgu** bildirdi; “sıfır açık” sonucu yoktur. Resmi npm kayıtlarında o gün `node-forge`1.4.0 ve `braces`3.0.3 en yeni sürümlerdi; aşağıdaki resmi bildirimler yayımlanmış düzeltme belirtmiyor.

| Paket / yol | Bildirim | Durum |
| --- | --- | --- |
| `nuxt → nitropack → listhen → node-forge` | RSA imza doğrulamasında ASN.1 öğe sayısı kontrolü | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv); etkilenmiş sürüm<=1.4.0, yayımlanmış düzeltme yok |
| `nuxt → nitropack → globby → micromatch → braces` | Çok derin brace deseninde recursive walker stack taşması | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm); etkilenmiş sürüm<=3.0.3, yayımlanmış düzeltme yok |

Nuxt, kaynak `package.json` içinde dependency olduğu için araç zinciri `--prod` taramasına da giriyor. Bu sonucu bağımlılıkları başka kategoriye taşıyarak veya bildirimleri susturarak gizlemedim; upstream paketleri yamalanmış saymadım.

Üretim Dockerfile'ı yalnız derlenen `.output` dizinini taşır. Gerçek imajdaki `/app` paket manifestleri incelendi; iki paket bulunmadı. Derleme sonrası `pnpm check:runtime`, runtime manifestlerinde bu adlar veya onlara dependency kaydı bulunursa hata verir; CI ve Docker build'e bağlandı. Bu envanter kontrolü genel bir “tüm zafiyetler yok” kanıtı veya bağımsız kriptografik denetim değildir.

Uygulama kullanıcı aramasını bu glob araçlarına göndermiyor; dosya işlemleri kendi API/MongoDB katmanından geçiyor. Geliştirme sunucusu yalnız127.0.0.1/HTTP dinler; üretim TLS'i Caddy sonlandırır. Araçların build/dev yollarında kullanılması ve runtime envanterinde bulunmaması, üretimde bu iki paketin çalıştırılmadığı değerlendirmesinin dayanağıdır; kaynak araç zincirindeki risk tamamen giderildiği iddia edilmez.

Takip: resmi düzeltme veya bu bağımlılıkları kaldıran uyumlu upstream sürüm geldiğinde güncelle, frozen lockfile ile derle,101 backend/42 frontend regresyonunu ve artifact kontrolünü çalıştır. Bu çalışmada sırf sürüm numarası daha yeni diye uyumluluğu belirsiz override veya yerel kriptografi yaması yapılmadı. Derleme CI'ı salt okunur repo yetkisi ve sınırlı çalışma süresiyle hazırlanmıştır; canlı kullanıcı girdisini bir glob/sertifika yardımcı aracına bağlayan değişiklikte değerlendirme yenilenmelidir.
