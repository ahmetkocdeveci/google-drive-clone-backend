# Yedekleme ve operasyon

## Şifreli yedek

Backend `pnpm backup` komutu MongoDB dump'ını ve özel dosyaları ayrı ayrı AES-256-GCM ile şifreler. Tamamlanmış şifreli manifest bütünlük bilgilerini içerir; anahtar yedekte bulunmaz. Yanlış anahtar, kesik/değiştirilmiş içerik ve geçersiz yollar reddedilir. Şifreli veri dışında kalıcı düz metin yedek yazılmaz. Geri yükleme geçici düz metni yalnız yeni, sınırlı izinli geçici klasörde açar ve sonunda temizler; işletim sistemi/sunucu disk şifrelemesi de kullanılmalı.

**Tutarlılık:** Önce API ve bütün worker süreçlerini durdur. Harici yazıcı/ikinci instance olmadığını doğrula. Komut erişilebilir API bulursa durur; `--maintenance-confirmed` diğer yazıcıların da durdurulduğunu operatörün açıkça bildirmesidir. Tek DB dump'ı ile dosyaların tutarlı görünmesi bu bakım aralığına bağlıdır. Canlı yazma sırasında snapshot garantisi vermez.

Backend dizininde yerel örnek (PowerShell'de Docker yolu PATH'te olmalı veya `DOCKER_BIN` tanımlanmalı):

```powershell
pnpm backup create --destination .data/backups/2026-10-20 --docker-container ortak-drive-dev-mongo-1 --maintenance-confirmed
pnpm backup restore --source .data/backups/2026-10-20 --database ortak_drive_restore_20261020 --objects .data/restored-20261020 --docker-container ortak-drive-dev-mongo-1 --maintenance-confirmed
```

`.data/backups` üst klasörünü önceden oluştur. Hedef yedek klasörü, geri yükleme veritabanı ve nesne klasörü önceden var olmamalı. Araç mevcut DB'yi veya dosya klasörünü üzerine yazmaz, `--drop` kullanmaz. Başarısız DB restore yeni hedefte kısmi veri bırakabilir; kaynağa geçmez. Tekrar denemek için başka yeni hedef seç ve başarısız hedefi ayrıca incele.

Docker modunda isim tek başına yeterli değildir: seçilen çalışan konteynerin gerçekten `127.0.0.1:27018` yayını doğrulanır ve komutlar o konteynerin değişmez ID'siyle çalışır. Başka port/cluster'a yönelen konteyner kabul edilmez. Üretim bakımında ayrıca doğru ortam değişkenlerini secret manager'dan yükle; örneğin backend dizininde `node --env-file=deploy/.env.production scripts/backup.mjs ...` ile üretim ayarlarını açıkça seç. Bu dosya gerçek sırlar içerir ve Git'e girmez.

Yerel Docker modu yalnız loopback/27018 ve kimliksiz geliştirme replica set'i içindir. Üretimde MongoDB Database Tools kurulu bakım makinesinde `--docker-container` yerine `--mongo-tools-config /run/secrets/mongo-tools.json` kullan. Dosya yalnız `{"uri":"MONGODB_URI ile aynı değer"}` içersin; JSON, araçların YAML config biçiminin alt kümesidir. Parolayı komut satırına yazma. Araç URI'nin `.env` içindeki değerle tam eşleşmesini zorunlu tutar ve çalışırken özel geçici kopyayı kullanır; hedefin boşluk kontrolü ile restore başka cluster'lara gidemez. Yedekleme kimliğinin backup/list yetkileri, restore kimliğinin yeni hedefe restore yetkileri olmalı.

S3 modunda yedekleme bucket'ın `workspaces/` önekini stream ile okur. Geri yükleme önce **yeni yerel nesne klasörüne** doğrulanmış dosyaları çıkarır ve yeni DB'ye döner. Canlı S3'e dönüş, bu klasörün **boş ve özel bir kurtarma bucket'ına** aynı object key'lerle aktarılması, sayım/boyut/içerik kontrolü, kurtarma ortamında smoke test ve kontrollü config değişimidir. Araç mevcut canlı bucket'ı üzerine yazmaz. Bu aktarım gerçek sağlayıcı hesabı hazır olduğunda ayrıca doğrulanmalı.

Her gün yedek ve en az ayda bir ayrı ortama geri dönüş hedefi başlangıç önerisidir; işin kabul ettiği veri kaybı (RPO), dönüş süresi (RTO), maliyet ve saklama süresini mentörünle belirle. Otomatik yedek scheduler'ını sunucunun bakım planına bağla; uygulama çalışırken bu komutu körlemesine zamanlama.

## Kontrol ve alarm

`GET /health` DB ping, `GET /health/ready` DB + private storage kontrolüdür. Gateway her iki sağlık yolunu da dış erişime kapatır; Docker/iç ağ kullanır. Readiness eşzamanlı isteklerde tek probe çalıştırır; sağlıklı sonucu5 saniye, hatayı1 saniye saklar. `GET /ops/status` aggregate mail/job/archive kuyruk sayıları ve yaşlarını, `GET /metrics` Prometheus formatında aynı bilgileri, geçici disk boşluğunu ve sınırlı route-template HTTP sayaçlarını verir. Kullanıcı e-postaları, tenant/node kimlikleri, raw URL veya token metric etiketi olmaz. Operasyon yolları ayrı Bearer anahtarı ister; frontend'e bu anahtar verilmez.

Üretim API konteyneri büyük arşivleri bellekteki tmpfs yerine private disk volume üzerindeki `/tmp` alanına hazırlar. En az8 GiB boş çalışma alanıyla başla; eşzamanlı iş ve dosya sayısına göre artır.5 GiB altı için alarm kuralı var. Üretilmiş ada uyan,24 saatten eski ve mevcut süreçte aktif olmayan arşiv artıkları sınırlı taramayla temizlenir. Büyük ZIP'in son tarayıcı indirmesi Blob kullandığından cihaz belleği/indirme kapasitesi ayrıca gerçek kabul testinde ölçülmeli;1 GiB sunucu sınırı bütün cihazlarda garanti değildir.

`deploy/monitoring` scrape ve alarm kuralları içerir. Gerçek alarm hedefi henüz yapılandırılmadı. Failed işler için doğrudan DB'den topluca status sıfırlamak yerine sebebi incele; kullanıcıya dosya/davet işlemini güvenle tekrar başlat. Loglardaki requestId ile olay eşleştirilir; mail içeriği ve erişim token'larını loglama.

Testler şifreleme/bütünlük, yanlış anahtar ve değiştirilmiş nesne reddini; gerçek MongoDB dump → ayrı DB restore, indeks korunması ve dosya baytlarının eşleşmesini kapsar. Bu yerel tatbikat, canlı sağlayıcı yedeğinin ve seçilmiş RPO/RTO'nun yerine geçmez.

Resmi başvuru: [mongodump](https://www.mongodb.com/docs/database-tools/mongodump/), [mongorestore](https://www.mongodb.com/docs/database-tools/mongorestore/).
