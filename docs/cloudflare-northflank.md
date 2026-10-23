# Cloudflare Pages ve Northflank pilot yayını

Arayüz Cloudflare Pages'te, API/worker Northflank'ta çalışır. Tarayıcı API'ye kendi frontend origin'inin `/api/v1` yolu üzerinden erişir. Veritabanı Atlas, dosyalar private R2 üzerindedir. Bu kaynaklar canlı kurulum kabulünün tamamlandığı anlamına gelmez.

## Gateway sınırı

Backend'de `EDGE_PROXY_TOKEN` ayarlanırsa bütün `/api/*` istekleri bu gizli anahtarı ve geçerli istemci IP başlığını ister. Cloudflare Function yalnız sabit upstream'e gider, kendi anahtarını ve Cloudflare'ın gerçek istemci adresini gönderir. Backend hız sınırında ancak doğrulanmış bu adresi kullanır; rastgele forwarded başlıkları güven kaynağı değildir. Anahtar yoksa mevcut yerel/Caddy akışı korunur.

Bu kontrol cookie oturumu, Origin, CSRF, güncel üyelik, rol ve tenant kontrollerine ektir. Google callback de gateway'den geçer. `/health` ve `/health/ready` sağlayıcının sağlık kontrolleri için kalır; `/ops` ve `/metrics` kendi Bearer anahtarıyla korunur ve frontend Function tarafından sunulmaz.

## Hesap ve adresler hazır olduğunda

Northflank'ta Dockerfile, `/` build context, `/Dockerfile`, HTTP4100 ve1 instance kullanılır. Kullanıcının Free proje ekranında512 MB `nf-compute-20` seçilebilir görüldü; hizmet oluşturulmadan önce fiyat özetinde0 USD ve kaynak sınırları ayrıca doğrulanmalıdır. Atlas için sunucu çıkış ağı, R2 için yayın CORS origin'i ve Google için HTTPS callback hazırlanır.

Frontend'in `.pages.dev` adresi kendi Cloudflare hesabında doğrulandıktan sonra backend kökünde:

```powershell
node scripts/prepare-northflank.mjs --public-origin https://YOUR-APP.pages.dev --upstream-origin https://YOUR-API.code.run --reuse-current-data
```

`--reuse-current-data` mevcut Atlas DB/R2 bucket/şifreleme anahtarını birlikte korumayı açıkça seçer. Aynı bucket'ı boş/farklı DB ile bağlamayın: dosya yaşam döngüsü ve temizlik bu eşleşmeye dayanır. Geliştirme ve pilot aynı veriyi kullanacaksa yerelden yapılan silmeler de o veriyi etkiler. Tam ayrı ortam için ayrı DB, ayrı bucket, kapsamlı credential ve ayrı sırlar gerekir.

Betik yerel `.env` dosyasını değiştirmeden, yalnız gerekli ayarları `.data/deployment/northflank.env` ve `cloudflare.env` dosyalarına yazar. Bunlar gerçek sırlar içerir ve Git dışındadır. Mevcut aktarım dosyalarının üzerine yazılmaz. Her iki tarafta aynı rastgele gateway anahtarı kullanılır. Değerler terminale basılmaz ve dış servise aktarılmaz.

Northflank runtime ayarlarına `northflank.env`, Cloudflare Production ortamına `cloudflare.env` içerikleri aktarılır. `EDGE_PROXY_TOKEN` Cloudflare'da Secret olarak saklanmalıdır. Production `API_ORIGIN` ve `FRONTEND_ORIGIN` aynı Pages adresidir; Northflank fiziksel adresi yalnız gateway upstream'idir. `TRUSTED_PROXY_CIDRS` boş kalır; istemci adresi gateway anahtarıyla doğrulanır.

Bu betik Atlas erişim listesini, R2 CORS'u veya Google istemcisini uzaktan güncellemez; bunlar ayrı kurulum adımlarıdır. Değerleri sohbete veya ekran görüntüsüne koymayın. Northflank fiyat özeti, HTTPS cookie/CSRF, SMTP verify ve gerçek kullanıcı kabulü tamamlanmadan pilot yayın tamamlandı diye işaretlenmez.
