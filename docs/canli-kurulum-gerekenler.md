# Canlı kurulum için gerekenler — 20 Ekim 2026

**23 Ekim güncel durum:** Google girişinden sonra daveti yeniden yapıştırma eksiği kodda kapatıldı. Session/state'e bağlı şifreli bağlam, tek kullanımlık callback ve açık davet kabulü eklendi; 28 hedefli backend auth ve 73 frontend testi geçti. Nuxt 4.6.2 güncellemesi moderate audit bulgularını 3'ten 0'a indirdi; iki upstream high araç zinciri bulgusu izleniyor. Yeni akışın manuel Google dönüşü kabulü ve canlı frontend/API yayını bekliyor. İki bağımsız private repository teslimi ve ilk uzak CI kabulü tamamlandı. Aşağıdaki tarihli kayıtlar geçmiş doğrulama kapsamını gösterir; güncel açık işler için kalite raporu esas alınmalıdır.


Hesapların henüz hazır olmadığı bilgisine göre bu liste hazırlandı. Yerel kod ve testler, gerçek sağlayıcı hesabı ve üretim kabulünün yerine geçmez. Gizli anahtarları sohbete veya Git'e koyma; sunucudaki secret manager/yalnız yetkili hesabın okuyabildiği `.env.production` dosyasına gir.

## Hazırlanacak hesaplar ve ayarlar

| Gereken | Hazırlaman gereken bilgi/ayar | Doğrulama |
| --- | --- | --- |
| Alan adı ve DNS | Örneğin `drive.seninalanin.com`; A/AAAA sunucuya; kullanılmayan AAAA kaydı bırakma | HTTPS ve sertifika zinciri, HTTP → HTTPS |
| Linux sunucu veya container hosting | Docker/Compose, dışarıya yalnız 80/443; yönetim erişimi sınırlı; başlangıçta en az 2 vCPU/4 GB RAM hedefi, gerçek yükle ölçülür | Restart, disk/RAM alarmı, beklenmedik kapanış sonrası sağlık |
| MongoDB replica set | TLS ve kullanıcı/parola veya yönetilen cluster; yalnız uygulama IP/ağı; ayrı test/veri tabanı | Transaction, indeksler, bağlantı kopması; Mongo portunu internete açma |
| Özel S3/R2 bucket | Public erişim kapalı; uygulamaya ayrı dar yetkili servis kimliği; bölge/endpoint/bucket | PUT, HEAD, GET, Range, conditional publish, DELETE ve ZIP; gerçek provider'da denenmeli |
| Bucket CORS | Yalnız gerçek site origin'i; PUT ve gerekli Content-Type başlıkları; imza parametrelerini değiştiren proxy kullanma | Tarayıcıdan gerçek dosya yüklemesi |
| SMTP sağlayıcısı | Doğrulanmış gönderen alan adı/adresi; SPF/DKIM/DMARC; TLS; host/port/kullanıcı/parola | Kayıt, doğrulama, sıfırlama, davet mesajlarını gerçek test adreslerinde al |
| Google Cloud OAuth | Consent screen, uygulama domain'i, Web application client ID/secret; gerekiyorsa test kullanıcıları | Login, izin iptali, aynı e-posta çakışması, açık hesap bağlama |
| Yedek deposu | Uygulamadan ayrı erişim, ayrı şifreleme anahtarı, saklama politikası ve erişim kaydı | Ayrı ortama düzenli geri yükleme tatbikatı |
| İzleme/alarmlar | Prometheus uyumlu toplama ve ekipte bir alarm hedefi | API kapalı, failed queue ve kuyruk gecikmesi alarmları |

Google callback tam olarak `https://ALAN_ADI/api/v1/auth/google/callback` olmalı. Uygulamanın kullandığı kapsamlar `openid email profile`; Drive API yetkisi istemiyor. Google hesabı hazır olana kadar e-posta/parola girişi çalışır.

S3 uygulama erişimi: `workspaces/*` için GetObject/PutObject/DeleteObject ve koşullu yazma desteği; readiness için HeadBucket sağlayıcıda genellikle ListBucket yetkisi gerektirir. Yedekleme ayrı kimlikle ListBucket/GetObject kullanabilir. Bucket versioning/ayrı yedek politikası tavsiye edilir; lifecycle süreleri aktif `.sealed` nesneleri otomatik silmemeli. Upload staging ve arşiv temizliği uygulama worker'ında var. Sağlayıcının lifecycle filtresini staging adlarına göre yanlış tahmin ederek açma.

## Hazırlanan dağıtım

`deploy/compose.yaml`, backend/frontend Dockerfile'ları ve `deploy/caddy/Caddyfile` aynı alan adından HTTPS sunacak şekilde hazır. API ve frontend portları host'a yayınlanmıyor. MongoDB, SMTP ve bucket dış servis olarak bekleniyor; geliştirme compose'u üretim için kullanılmıyor. API'nin arka plan işleri bu sürümde aynı süreçte çalışır; ek worker çoğaltmadan önce yük ve lease davranışını ölç.

1. `deploy/.env.example` → `deploy/.env`; domain ve ACME e-posta adresini yaz.
2. `deploy/.env.production.example` → `deploy/.env.production`; servis ayarlarını ve birbirinden farklı beş adet 32 bayt hex anahtarı secret manager'dan gir. Dosya izinlerini sınırla. `BACKUP_ENCRYPTION_KEY` kopyasını ayrıca güvenli yerde sakla.
3. Docker ağı `172.29.61.0/24` sunucu ağlarıyla çakışıyorsa compose ve `TRUSTED_PROXY_CIDRS` değerlerini birlikte değiştir. Güvenilen adres yalnız gateway'in gerçek `/32` adresidir.
4. `docker compose --env-file .env -f compose.yaml config --quiet` ile doğrula; sonra `docker compose --env-file .env -f compose.yaml up -d --build`.
5. `/health/ready` DB ve depolama kontrolüdür; iç ağ/Docker tarafından kullanılır. `/ops/status` ve `/metrics` ayrı `OPERATIONS_TOKEN` Bearer anahtarı ister. Public gateway bu yolları ve sağlık uçlarını dışarıya kapatır. Büyük arşivlerin private scratch disk volume'ü için en az8 GiB boş alan ve disk alarmı ayır. Prometheus örneği `deploy/monitoring` içinde; alarm hedefine bağlamak ortam kurulumudur.
6. Gerçek tarayıcı kabulünü, rol/tenant izolasyonunu, SMTP/Google/S3 smoke testlerini ve geri yükleme tatbikatını tamamladıktan sonra gerçek kullanıcı aç.

Bu kurulum henüz bir sunucuya yayınlanmadı. HTTPS, gerçek Google/S3/SMTP, maliyet, kapasite ve alarm teslimatı canlı hesaplar olmadan doğrulanmış sayılmaz.

Dayanaklar: [Caddy resmi imaj ve HTTPS kurulumu](https://hub.docker.com/_/caddy), [Google sunucu tarafı kimlik doğrulama](https://developers.google.com/identity/sign-in/web/backend-auth), [AWS imzalı yükleme başlıkları](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/).


## Kullanıcının belirlediği tercihler — 22 Ekim 2026

- GitHub hesabı: `ahmetkocdeveci`. Her iki repository **private** olacak.
- Bütçe hedefi: ücretsiz planlarla başlamak; ücretli hizmet veya ödeme gerektiren adım önceden açıklanacak.
- Cloudflare tercih ediliyor. PDF'deki Cloudflare R2 ifadesi bucket örneğidir; frontend ve API'nin tümünün Cloudflare'da çalışması belgede zorunlu tutulmuyor.
- Alan adı ve yayın adresleri henüz belirlenmedi. Başlangıç için sağlayıcının alt alan adı değerlendirilecek; DNS/domain satın alımı yapılmadı.
- MongoDB Atlas hesabı/Free cluster kullanıcıyla adım adım kurulacak.
- Cloudflare için kullanıcı adı paylaşılması gerekmiyor; hesap açıp kendi tarayıcısında giriş yapması yeterli.
- Google OAuth kurulumu daha sonraki adımda Google Cloud projesi ve yayın callback adresleriyle yapılacak. Google ile Atlas'a giriş yapmak uygulamanın Google OAuth ayarını otomatik kurmaz.
- Mevcut backend uzun yaşayan worker döngüleri, scrypt bellek kullanımı ve disk tabanlı ZIP üretimi içeriyor. Workers Free'a doğrudan dağıtım doğrulanmadı; mevcut dağıtım hedefi standart Node.js/Docker. Ücretsiz Cloudflare uyumluluğu sağlanmış sayılmayacak.
- R2 Standard ücretsiz kullanım kotası sunar; aşan kullanım ücretlidir ve açılışta abonelik/checkout adımı vardır. Sınırsız veya kesinlikle faturasız hizmet olarak anlatılmayacak.


## Atlas bağlantısı doğrulandı — 22 Ekim 2026

- Proje: `google-drive-clone`; cluster: `drive-cluster`, Free, AWS Frankfurt.
- Uygulama kullanıcısı: `drive_app`, yalnız `readWrite@ortak_drive`.
- Kullanıcı kendi bilgisayarında gizli giriş yardımcısıyla backend `.env` dosyasını ayarladı; bağlantı/parola rapora yazılmadı.
- Backend `createConfig` + `connectDatabase` ile Atlas'a bağlandı; ping başarılı, replica set doğrulandı,16 modelin koleksiyon/indeks kurulumu başarılı. Bu test uygulama verisi eklemedi.
- Bu, çalışan deployment veya Atlas üzerinde tam kullanıcı akışı kabulü değildir. Yerel uygulama süreçleri yeni ayarı kullanmak için yeniden başlatılmalı; R2/SMTP/Google ve canlı API/frontend yayını hâlâ hazırlanacak.
- Windows PowerShell için yardımcı çağrısı gerekirse yalnız süreç kapsamında `-ExecutionPolicy RemoteSigned` ile çalıştırılır; kalıcı execution policy değişikliği yapılmadı.


## R2 bucket oluşturuldu — 22 Ekim 2026

- Bucket: `google-drive-clone-files`; Standard; Eastern Europe; Public Access kapalı.
- S3 endpoint (bucket yolu olmadan): `https://d9664dd0f93cb0783865ff40b76b1dd7.r2.cloudflarestorage.com`. Bucket adı ayrı `S3_BUCKET` ayarıdır.
- Yerel frontend origin'i `http://127.0.0.1:4179`; gereken browser isteği yalnız imzalı PUT ve Content-Type başlığıdır. JSON dashboard için [yerel CORS örneği](../deploy/r2-cors.local.json) hazırlandı; kullanıcıdan kaydedildiği teyidi henüz alınmadı. Canlı origin belirlenince ayrıca güncellenecek.
- API token/Access Key ID/Secret Access Key henüz yerel backend'e kurulmadı; gerçek R2 upload/download testi henüz yapılmadı. Backend STORAGE_DRIVER hâlâ local.
- Varsayılan7 günlük tamamlanmamış multipart temizliği mevcut. Uygulamanın aktif nesnelerine genel süre dolumu kuralı eklenmedi.


## R2 anahtarlarının yerel kurulumu

Kullanıcı, `ortak-drive-backend` adlı Object Read & Write token'ını yalnız `google-drive-clone-files` için oluşturduğunu bildirdi. Anahtarlar sohbete alınmadı. `google-drive-clone-backend/scripts/setup-r2.ps1`, Access Key ID ve Secret Access Key değerlerini gizli girişle alır; yalnız ilgili S3 ayarlarını günceller. Atlas ve diğer sırlar korunur. Yardımcı geçici dosya/örnek anahtarlarla doğrulandı; gerçek `.env` henüz bu yardımcıyla değiştirilmedi. Kullanıcının yerel girişinden sonra gerçek R2 upload/read/cleanup ve CORS kontrolü yapılacak.

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "C:\Users\ahmet\Desktop\projeler\backend-starter-kit\google-drive-clone-backend\scripts\setup-r2.ps1"
```

Genel Cloudflare API token value yerine S3 uyumlu Access Key ID ve Secret Access Key alanları kullanılmalıdır.


## R2 canlı bağlantısı doğrulandı — 22 Ekim 2026

Kullanıcı `setup-r2.ps1` ile anahtarları kendi terminalinde gizli girişle kaydetti. Backend yapılandırması `STORAGE_DRIVER=s3`, bucket `google-drive-clone-files`, region `auto`; anahtar değerleri rapora/sohbete yazdırılmadı.

Gerçek R2 üzerinde, yalnız test için üretilmiş rastgele workspace/object anahtarları kullanılarak doğrulandı:

- Bucket erişim/HeadBucket kontrolü başarılı.
- Browser preflight:204; Origin `http://127.0.0.1:4179`, PUT ve Content-Type izinleri doğru. Bu API kontrolüdür; gerçek browser E2E değildir.
- İmzalı PUT200; HEAD boyutu, GET tam baytlar ve Range baytları eşleşti.
- Staging → sealed immutable finalize ve tekrar finalize başarılı.
- ZIP üretimi/R2 yazma/okuma başarılı; aynı anahtara conditional retry ilk ZIP baytlarını değiştirmedi.
- Mevcut test nesnesine imzasız S3 API GET isteği400 `InvalidArgument` ile reddedildi; içerik dönmedi. İlk testin yalnız401/403 kabul eden dar beklentisi burada durdu; ikinci kontrolde gerçek provider yanıtı ve ZIP akışı ayrıca doğrulandı. Bu, bütün alternatif public URL yollarının testi değildir; public erişim panelde kapalıdır.
- İlk kontroldeki3, ikinci kontroldeki1 test nesnesi silindi ve HEAD ile yoklukları doğrulandı. Atlas'ta uygulama verisi oluşturulmadı.

Yerel süreçler yeni ayar için yeniden başlatılmalı. Canlı API/frontend yayını, gerçek browser akışı, SMTP ve Google OAuth hâlâ tamamlanmadı.

### Google OAuth yerel istemcisi — 22 Ekim 2026

Kullanıcı Google Cloud `google-drive-clone` projesinde External başlangıç yapılandırmasını ve Web application OAuth istemcisini oluşturduğunu bildirdi. Backend koduyla eşleştirilen yerel redirect URI: `http://127.0.0.1:4100/api/v1/auth/google/callback`. JavaScript origins, sunucu üzerinden yürütülen bu akışta boş bırakılabilir.

`google-drive-clone-backend/scripts/setup-google.ps1`, Client ID ve Client Secret değerlerini terminalde gizli girişle alır; yalnız `GOOGLE_CLIENT_ID` ve `GOOGLE_CLIENT_SECRET` ayarlarını günceller. Geçici dosya ve sahte değerlerle kayıt, Atlas/R2 ayarlarını koruma, geçersiz giriş ve tekrarlanan ayar reddi doğrulandı. Gerçek Google değerleri henüz bu yardımcıyla kaydedilmedi; Google giriş testi yapılmadı. İndirilen JSON sır içerir, kaynak ağacının dışında tutulmalıdır.

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "C:\Users\ahmet\Desktop\projeler\backend-starter-kit\google-drive-clone-backend\scripts\setup-google.ps1"
```

Sonraki adımlar: yerel gizli giriş, Audience test kullanıcılarının kontrolü, uygulama süreçlerinin yeniden başlatılması ve kullanıcı tarafından gerçek Google giriş denemesi. Canlı yayın için HTTPS callback ayrıca tanımlanmalı.

Kullanıcı manuel girişin başarısız olduğunu bildirdi; sırlar okunmadan yapılan kontrol `.env` dosyasının mevcut/yazılabilir olduğunu ve iki Google alanının hâlâ boş olduğunu gösterdi. Kesin hata nedeni bilinmiyor. Yardımcıya `-FromJson` seçeneği eklendi: dosya seçicisinden Google'ın indirdiği Web application JSON dosyasını okur, yerel callback eşleşmesini doğrular ve aynı iki ayarı günceller. Hatalar artık sır içermeyen belirli açıklamalar verir. Windows PowerShell 5.1 üzerinde süreçlik RemoteSigned ile sahte JSON kaydı, Atlas/R2 değerlerini koruma, bozuk JSON ve yanlış callback reddi doğrulandı. Gerçek dosya henüz içe aktarılmadı.

```powershell
powershell -NoProfile -STA -ExecutionPolicy RemoteSigned -File "C:\Users\ahmet\Desktop\projeler\backend-starter-kit\google-drive-clone-backend\scripts\setup-google.ps1" -FromJson
```

Son durum: Hata Windows PowerShell 5.1 / `tr-TR` kültüründe büyük ASCII `I` harfinin varsayılan büyük/küçük harf duyarsız regex tarafından reddedilmesinden kaynaklandı. Client ID ve Secret kontrolleri açık ASCII büyük/küçük harf duyarlı eşleşmeye çevrildi. Türkçe kültürde `I/i` içeren sahte JSON kaydı ve maskelenmiş anahtar reddi doğrulandı. Kullanıcının Downloads klasöründeki JSON'un proje kimliği ve callback'i doğrulanarak gerçek Google ayarları `.env` içine kaydedildi; diğer tüm `.env` ayarlarının değişmediği karşılaştırıldı. Sırlar çıktılara yazdırılmadı. Gerçek Google ile giriş henüz denenmedi.

Yerel giriş denemesi için backend ve mevcut frontend derlemesi güncel ayarlarla başlatıldı. Frontend runtime API adresi `http://127.0.0.1:4100/api/v1`, veri modu `http`; arayüz adresi `http://127.0.0.1:4179`. Backend `/health` gerçek Atlas ping'iyle 200 döndü. `/api/v1/auth/google/start` 302 yanıtında Google hedefi, doğru callback, PKCE S256, yalnız `openid email profile` scope'ları ve oturum çerezi varlığı doğrulandı; URL/state/çerez değerleri yazdırılmadı. Kontrol, kısa ömürlü anonim oturum ve OAuth denemesi kaydı oluşturdu. Bu kontrol gerçek Google hesabıyla giriş veya tarayıcı testi değildir. Kullanıcı Audience/test kullanıcısı ayarını doğrulayıp arayüzden giriş denemeli. Çalışan süreçler bilgisayar yeniden başlatıldığında yeniden başlatılmalıdır.

### Gerçek Gmail SMTP hazırlığı — 22 Ekim 2026

**GitHub CI — 23 Ekim:** İlk push sonrasında her iki deponun bağımsız CI iş akışı başarıyla tamamlandı. GitHub kaynak teslimi ve ilk CI kabulü tamamdır; canlı frontend/API yayını hâlâ ayrı adımdır.

**GitHub teslimi — 23 Ekim:** Backend ve frontend kullanıcıya ait iki ayrı private GitHub deposuna push edildi. Kaynak `.env`, veri ve derleme çıktıları hariç tutuldu; uzak `main` commitleri yerelle eşleşiyor. Bağımsız CI akışları başladı; canlı yayın henüz yapılmadı. [Teslim raporu](github-teslim-durumu.md).

**Teslimat kabulü — 23 Ekim:** Kullanıcı `test-smtp.mjs --send-to-self` ile kendi gönderici adresine yollanan test e-postasının Gmail kutusuna geldiğini doğruladı. Böylece gerçek Gmail SMTP bağlantısı ve kendi adresine teslimat manuel olarak kabul edildi. Farklı alıcıya gerçek davet e-postası teslimatı ayrıca denenmedi; kullanıcı ikinci posta hesabına şu an erişemiyor. Önceki Mailpit davet kabulü/rol testleri ayrı doğrulamalardır.

**Alternatif teslimat testi — 23 Ekim:** Kullanıcı ikinci posta hesabına erişemediğini bildirdi. `scripts/test-smtp.mjs` eklendi; varsayılan çağrı yalnız SMTP bağlantısını doğrular. Kullanıcının `--send-to-self` ile çalıştırması, yalnız yapılandırılmış Gmail göndericisinin kendi adresine sabit içerikli tek test mesajı gönderir. Betik çalıştırıldığı dizinden bağımsız backend `.env` dosyasını bulur; sırları ve gönderici adresini yazdırmaz. Üç hedefli testte varsayılan gönderimsiz davranış, tek alıcının göndericiye sabitlenmesi, eksik adres ve SMTP reddi doğrulandı. Asistan gerçek test e-postasını göndermedi; kullanıcı komutu çalıştırıp kendi kutusunu kontrol edecek. SMTP kabulü ve gelen kutusu teslimatı ayrı sonuçlardır.

**23 Ekim güncellemesi:** Kullanıcı 2 Adımlı Doğrulamanın açık olduğunu, uygulama şifresini oluşturup `setup-gmail.ps1` ile yerelde kaydettiğini bildirdi. Gerçek yapılandırmada `smtp.gmail.com:465`, TLS ve SMTP kimlik doğrulaması `nodemailer.verify()` ile başarılı; sırlar ve gönderici adresi çıktıya yazdırılmadı, test e-postası gönderilmedi. Atlas outbox kontrolünde pending/sending/failed sayıları 0/0/0 idi. Önceki görev backend'i yeni Gmail ayarıyla yeniden başlatıldı; Atlas/index açılışından sonra `/health` 200/ok döndü. Uygulamada kullanıcının oluşturacağı yeni davetle gerçek Gmail/Outlook teslimatı ayrıca doğrulanmalıdır. SMTP oturumu açabilmek gelen kutusuna teslimatı doğrulamaz.

Gönderici hesabında 2 Adımlı Doğrulama ve uygulama şifresi kullanılabilirliği kullanıcıdan bekleniyor. [Google hesap gereklilikleri](https://support.google.com/accounts/answer/185833?hl=tr) ve [SMTP sunucu belgesi](https://developers.google.com/workspace/gmail/imap/imap-smtp) kontrol edildi. SMTP kimlik doğrulaması uygulamadaki Google kullanıcı girişinden ayrı yapılandırılır. Bu aşama için Gmail SMTP 465/SSL seçildi; yüksek hacimli canlı gönderim sağlayıcısı kararı ayrıca verilmelidir.

`google-drive-clone-backend/scripts/setup-gmail.ps1`, gönderici Gmail adresini ve gizli girişle uygulama şifresini alır; yalnız SMTP ve MAIL_FROM alanlarını günceller. Gruplanmış uygulama şifresinin boşlukları temizlenir; 16 ASCII alfanümerik karakter, tekrar eden ayarlar ve geçersiz girişler kontrol edilir. Windows PowerShell 5.1 `tr-TR` üzerinde sahte parola/geçici dosyayla kayıt, Atlas/R2/Google ayarlarını koruma ve hatalı giriş reddi doğrulandı. Gerçek `.env` SMTP ayarları henüz değiştirilmedi; dış e-posta gönderilmedi.

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "C:\Users\ahmet\Desktop\projeler\backend-starter-kit\google-drive-clone-backend\scripts\setup-gmail.ps1"
```

Yerel kayıt sonrasında önce e-posta göndermeyen SMTP `verify()` yapılmalı. Backend yeni SMTP ayarlarıyla yeniden başlatılmadan önce geçmiş outbox işlerinin durumu kontrol edilmeli; gerçek gönderim denemesini kullanıcı uygulamada oluşturmalıdır. Gmail/Outlook'a teslimat henüz doğrulanmadı. Yayın öncesi e-posta bağlantılarının HTTPS frontend origin'i ile oluşturulması da gerekir; localhost bağlantıları yalnız bu bilgisayarda açılır.

### Yerel davet testi — 22 Ekim 2026

**Kabul sonucu:** Kullanıcı davet e-postasının yerel kutuya geldiğini, ikinci hesapla uygulamaya giriş yaptıktan sonra aynı bağlantıyı yeniden açıp daveti kabul ettiğini bildirdi. İlgili çalışma alanında kişisel bilgi/token yazdırmadan yapılan veritabanı kontrolü `1 Owner`, `1 Viewer`, `1 kabul edilmiş davet` gösterdi. İlk bağlantı açılışından giriş sonrasına otomatik devam akışı kullanıcı tarafından doğrulanmadı; mevcut denemede bağlantı yeniden yapıştırıldı. Sonraki manuel kontrollerde kullanıcı Viewer, Editor ve üyelik kaldırılmasıyla erişim iptalinin de çalıştığını doğruladı; ayrıntılar frontend durum raporunda kayıtlı.

Kullanıcı ikinci bir Gmail hesabıyla ilerleyeceğini bildirdi. Mevcut `ortak-drive-dev-mailpit-1` konteyneri başlatıldı; SMTP 1025 ve test kutusu 8025 portlarının yalnız `127.0.0.1` adresine bağlı olduğu doğrulandı. Uygulamanın yapılandırılmış SMTP bağlantısında `verify()` başarılı, Mailpit `/livez` yanıtı 200. Mesaj içerikleri ve davet bağlantıları araç çıktısına alınmadı; test için asistan tarafından davet oluşturulmadı. Kullanıcı ana hesabıyla ikinci adresi Viewer olarak davet edip `http://127.0.0.1:8025` kutusundan bağlantıyı almalı. Bu yapılandırma Gmail'e gerçek teslimat yapmaz; dış SMTP sağlayıcısı hâlâ bekliyor. Farklı hesapla davet kabulü ve rol kabul testleri henüz tamamlanmadı.

23 Ekim son yerel doğrulaması: Nuxt 4.6.2 üretim derlemesi, E2E kaynak tip kontrolü ve 21 manifest runtime sınırı kontrolü geçti; node-forge/braces üretim çıktısında bulunmadı. İlk derleme Windows EPERM nedeniyle durdu, aynı derleme gerekli izinlerle başarılı oldu. Outbox 0 pending/0 sending/0 failed iken backend yeni kodla yeniden başlatıldı; Atlas /health ok ve frontend 4179 dinleme kontrolü başarılı. Bu kontroller frontend sayfasını açma veya yeni Google akışının manuel kabulü değildir.
