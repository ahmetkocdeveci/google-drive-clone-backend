# Üretim kurulumu kaynakları

Bu dizin hazırlık kaynaklarıdır; henüz çalışan bir canlı yayın kurulmadı. Cloudflare hesabı ve R2 bucket'ı tek başına bu Docker Compose servislerini barındırmaz. Ücretsiz frontend/API sağlayıcısı veya Docker sunucusu seçimi ayrıca tamamlanmalıdır.

İki depoyu aynı üst dizine klonlayın:

```text
projeler/
  google-drive-clone-backend/
    deploy/
  google-drive-clone-frontend/
```

Compose backend'i `..`, frontend'i `../../google-drive-clone-frontend` bağlamından derler. Caddy tek HTTPS origin üzerinden `/api/*` yollarını API'ye, diğer yolları frontend'e yönlendirir; API ve frontend portları doğrudan dışarı açılmaz. Bu düzen SameSite=Lax oturum çerezinin aynı site gereksinimini karşılamak içindir.

Backend kökünden yalnız şablon doğrulaması (servis başlatmaz):

```powershell
docker compose --env-file deploy/.env.example -f deploy/compose.yaml config --no-env-resolution --quiet
```

Gerçek sunucu ve domain hazır olduğunda `deploy/` dizininde `.env.example` dosyasını `.env`, `.env.production.example` dosyasını `.env.production` olarak kopyalayıp kendi ayarlarını doldurun. Var olan dosyaların üzerine yazmayın. Sırlar Git'e girmez; gerçek dosyaları paylaşmayın. `.env.production` için backend yapılandırmasının üretim doğrulamaları uygulanır; boş örnekle uygulama başlatılamaz.

`deploy/` içinde `docker compose --env-file .env -f compose.yaml config --quiet` ile gerçek ayarları doğruladıktan sonra `up -d --build` kullanılır. HTTPS için domain DNS'i sunucuya yönelmeli ve 80/443 erişilebilir olmalıdır. Henüz alan adı/sunucu hazır olmadığı için bu başlatma yapılmadı.

`r2-cors.local.json` yalnız yerel frontend origin'i içindir; yayın adresi seçilince origin ayrıca güncellenmelidir. Bucket public yapılmaz. `monitoring/` dosyaları örnek scrape/alarm kurallarıdır; gerçek alarm alıcısı ve yedekleme zamanlaması [operasyon rehberindeki](../docs/yedekleme-ve-operasyon.md) kabul adımlarını gerektirir.
