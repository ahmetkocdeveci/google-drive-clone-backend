# Ortak Drive backend

Frontend sözleşmesini uygulayan bağımsız Express/Mongoose projesi. Kullanıcılar, cookie oturumları, workspace üyelikleri ve dosya bilgileri gerçek MongoDB'de tutulur. Eşlik eden arayüz: [google-drive-clone-frontend](https://github.com/ahmetkocdeveci/google-drive-clone-frontend). İki depoyu aynı üst dizine klonlayarak birlikte çalıştırabilirsiniz.

## Yerelde çalıştırma

Node.js 24.16+, pnpm ve çalışan Docker Desktop gerekir. Bu klasörde:

```powershell
pnpm install --frozen-lockfile
pnpm run setup
docker compose up -d
pnpm dev
```

`setup`, mevcut `.env` dosyasını korur; yoksa bağımsız rastgele sırlar oluşturur. Sırları terminale yazmaz. `.env` ve `.data/` Git'e dahil edilmez.

- API: `http://127.0.0.1:4100/api/v1`
- Sağlık kontrolü: `http://127.0.0.1:4100/health`
- Geliştirme e-posta kutusu: `http://127.0.0.1:8025`
- MongoDB: localhost:27018, `rs0` replica set; Docker volume üzerinde kalıcı veri.

İkinci terminalde frontend klasöründe:

```powershell
cd ../google-drive-clone-frontend
pnpm install --frozen-lockfile
Copy-Item .env.example .env # yalnız .env henüz yoksa
pnpm dev
```

Frontend adresi `http://127.0.0.1:4179`. `.env.example`, `http` modunu ve API 4100 adresini kullanır. Farklı port seçilirse backend `FRONTEND_ORIGIN` ile frontend `NUXT_PUBLIC_API_BASE` değerleri birlikte ayarlanmalıdır. `localhost` ve `127.0.0.1` adreslerini karıştırmayın.

Uygulamada kayıt ol; doğrulama mesajını **yerel Mailpit kutusundan** aç, bağlantıdaki sayfada doğrulamayı tamamla. Geliştirme ortamında mesajlar gerçek alıcılara gitmez. Süresi dolan bağlantı, doğrulama ekranındaki yeniden gönder düğmesiyle yenilenir; 60 saniye bekleme uygulanır. Demo hesabı/parolası gerçek API hesabı değildir.

## Uygulanan akışlar

- Scrypt parola hash'i; session tokenının yalnız hash'ini saklayan HttpOnly cookie oturumu; giriş/çıkışta oturum değişimi, uygulama seviyesinde süre kontrolü.
- `GET /auth/providers` yalnız kullanılabilir sağlayıcıları bildirir. Google ayarı yoksa frontend normal giriş ekranında açıklama gösterir; callback iptal/hataları sabit hata kodlarıyla aynı frontend'e döner. Üçüncü taraf Google e-postalarında Google posta alanını yönetmiyorsa ayrı doğrulama e-postası gerekir.
- Anonim oturuma da bağlı CSRF anahtarı; Origin kontrolü; MongoDB tabanlı hız sınırı; sınırlı parola/dosya eşzamanlılığı.
- Workspace oluştururken Owner üyeliği. Owner/Editor/Viewer rolü kullanıcıya değil üyeliğe aittir ve her API isteğinde güncel kayıttan kontrol edilir.
- Workspace/üye/rol yönetimi, atomik sahiplik devri, eşzamanlı işlemlerde son Owner koruması.
- Google girişinde bekleyen daveti koruyan CSRF korumalı POST başlangıcı; 10 dakikalık, session/state'e bağlı AES-256-GCM bağlamı. Callback tek kullanımlıdır, şifreli bağlamı siler ve açık davet kabul ekranına döner; iptal/yeniden deneme daveti korur.
- Kayıtlı olmayan e-postaya Editor/Viewer daveti; hash'lenmiş tek kullanımlık token, 72 saat süre, iptal/yenileme, doğrulanmış eşleşen e-posta ile kabul. Tokenlar liste yanıtlarına verilmez.
- İç içe klasörler; arama/sıralama/tür filtresi; ad değiştirme/taşıma/silme, sürüm ve döngü kontrolü; tüm üst klasörlerin aktif olması şartı.
- İmzalı PUT → özel staging nesnesi → doğrulanan immutable dosya → transaction ile görünür kılma. Dosya başına25 MiB; workspace başına5 GiB kota ve eşzamanlı rezervasyon kontrolü.
- Her istekte yetki kontrolü yapılan dosya/Range indirme ve klasör ZIP'i. Dosyalar statik/public klasörden sunulmaz. HTML/SVG gibi içerikler attachment olarak indirilir.
- Dosya/Range ve iki ZIP indirme yolu boyunca güncel oturum, kullanıcı, üyelik ve aktif kaynak zinciri izlenir. Kontroller arasında250 ms beklenir; doğrulama1 saniyede bitmezse erişim açık bırakılmaz. Süreç başına32/kullanıcı başına4 açık izlenen stream sınırı vardır; HEAD izleme açmaz. Gönderilmiş baytlar geri alınamaz; gerçek kesilme süresine ağ/event-loop gecikmesi eklenebilir.
- `GET /workspaces/:wid/audit-events` Owner'a ait sayfalı işlem geçmişidir (50 varsayılan/100 üst sınır). UI `/workspaces/:wid/activity`; actor email'i, token ve istek gövdesi verilmez. Geçerli Owner yetkisi sayfa hazırlanırken kaybedilirse yanıt engellenir.
- Şifreli transactional e-posta outbox'ı, sunucunun request ID'siyle ilişkilenen tenant audit kayıtları, kiralanan ve yeniden denenebilen temizlik işleri. Yavaş SMTP dosya temizliğini durdurmaz; ayrı kuyruk döngüleri vardır. API süreci yerelde worker'ı da çalıştırır; `pnpm worker` ek worker süreci başlatabilir.

API ayrıntıları: [API sözleşmesi](docs/api-contract.md). Yeni `/page` uçları `{items,nextCursor}` döner; sayfa50, üst sınır100, imzalı cursor15 dakika geçerlidir. Dosya cursor'u kullanıcı/tenant/arama/sıralama/veri sürümüne bağlıdır; değişen listede yenileme gerekir. Workspace dizini canlı keyset listesidir; her sayfada güncel üyelik ve aktif workspace yeniden süzülür. Eski array uçları uyumluluk için sınırlıdır; yeni UI sayfalama kullanır. Klasör derinliği64; doğrudan ZIP1000 öğe/100 MiB, asenkron arşiv100000 öğe/1 GiB ile sınırlıdır; sonsuz kaynak kullanımı yoktur.

Parola kurtarma, e-posta yanıtını ele vermeyen istek ve1 saatlik tek kullanımlık token ile çalışır. Başarılı sıfırlama bütün mevcut oturumları ve bekleyen OAuth işlemlerini iptal eder. `/account` üzerinden açık Google bağlama mevcut parola ve browser-bound OAuth doğrulaması ister; e-posta eşleşmesi otomatik hesap birleştirme yapmaz.

Korumalı operasyon uçları, şifreli DB+dosya yedeği ve ayrı hedefe restore: [operasyon rehberi](docs/yedekleme-ve-operasyon.md). Docker/HTTPS ve servis hesapları: [canlı kurulum listesi](docs/canli-kurulum-gerekenler.md). Bu depoya ait `.github/workflows/ci.yml`, sözdizimi/test/audit ve Docker derlemesini çalıştırır; sonuçları GitHub Actions ekranından izlenir.

## Kodun düzeni

`auth.mjs`: kimlik/oturum/Google; `tenant.mjs`: güncel üyelik ve transaction sınırı; `workspaces.mjs`: alan/üye/davet; `files.mjs`: içerik; `models.mjs`: şemalar ve indeksler; `storage.mjs`: yerel/S3 adaptörleri; `mailer.mjs`: şifreli outbox; `worker.mjs`: fiziksel temizlik.

Kısa tenant yazmaları aynı Workspace belgesine yazıp güncel üyeliği transaction içinde yeniden okur. Rol kaldırma/değiştirme, dosya yazmaları ve davet kabulü aynı sıralamaya girer. Dosya baytları transaction dışında işlenir; finalize sırasında yetki ve üst klasörler yeniden kontrol edilir. Uzun indirmelerde daha önce teslim edilen baytlar geri alınamaz.

## Kontroller

```powershell
pnpm test
pnpm run check
# API ve Docker servisleri çalışırken gerçek yerel SMTP kontrolü:
pnpm run test:local
```

Testler gerçek MongoDB replica set ve gerçek HTTP kullanır; her test grubu benzersiz geçici veritabanını oluşturup kendi verisini temizler. `MONGO_TEST_URI` ile ayrı test replica set'i seçilebilir. MongoDB taklidi kullanılmaz. SMTP unit/integration testlerinde yakalanan transport kullanılır; `test:local` çalışan API'de sentetik bir kontrol hesabı oluşturup gerçek SMTP/Mailpit akışını ayrıca doğrular.

Frontend kardeş klasördeyse aynı test komutu gerçek frontend HTTP adapter'ıyla kayıt → doğrulama → workspace → davet → upload → indirme → tekrar giriş akışını da doğrular. Frontend başka repository'ye taşınırsa yalnız bu entegrasyon senaryosu açıkça skip edilir.

## Gerçek servis ayarları

Varsayılan yerel depolama `.data/objects` içindedir. `STORAGE_DRIVER=s3` ile private S3/R2 bucket, bölge/endpoint/IAM ayarları gerekir. 22 Ekim'de gerçek Atlas ve private R2 bağlantıları doğrulandı; kullanıcı PDF yükleme/önizleme/indirmeyi denedi. Kimlik bilgileri depoya eklenmez. Bucket public erişimi kapalı, CORS yalnız frontend origin'ine PUT izni verecek şekilde ayarlanmalıdır. Staging lifecycle kuralları finalized `.sealed` dosyalarını silmemelidir.

Google OAuth kodu state/nonce/PKCE ve imzalı ID token doğrulaması uygular. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` ve kayıtlı callback `${API_ORIGIN}/api/v1/auth/google/callback` gerekir. Yerel istemci yapılandırıldı; kullanıcı iki hesapla davet ve rol kontrollerini tamamladı. Yapılandırılmamışsa503 döner; aynı e-postalı hesaplar otomatik bağlanmaz.

Varsayılan SMTP yerel Mailpit'tir. Gmail için `scripts/setup-gmail.ps1` uygulama şifresini gizli girişle kaydeder. `node scripts/test-smtp.mjs` yalnız bağlantıyı kontrol eder; `--send-to-self` açıkça verilirse gönderici hesabın kendi adresine tek test mesajı gönderir. 23 Ekim'de kullanıcı bu mesajın Gmail'e ulaştığını doğruladı. Kendi servis ayarlarınızı `.env.example` üzerinden oluşturun; gerçek `.env` ve indirilen OAuth JSON dosyalarını paylaşmayın.

Üretimde HTTPS frontend/API origins, private S3 ve SMTP zorunludur; session cookie `__Host-`/Secure olur. Frontend/API aynı site altında veya `/api/v1` reverse proxy ile aynı origin altında çalışmalıdır; SameSite=Lax farklı site dağıtımına uygun değildir. Frontend üretim ortamında `NUXT_PUBLIC_DATA_MODE=http` ve `NUXT_PUBLIC_API_BASE=/api/v1` değerlerini açıkça ayarlayın; geliştirmede kullanılan localhost4100 adresini yayımlamayın. SMTP TLS ister. Geliştirme compose'u localhost içindir; üretim MongoDB erişim denetimi, yedekler ve TLS ayrıca kurulmalıdır. Dış ortama yayın yapılmadı.

Proxy arkasında `TRUSTED_PROXY_CIDRS` yalnız gerçek proxy IP/CIDR'lerini içermelidir (örnek: `127.0.0.1/32,::1/128`; kendi altyapınıza göre seçin). Varsayılan boş değer proxy başlıklarına güvenmez. API'ye doğrudan erişimi sınırlayın; gateway istemcinin gönderdiği forwarded başlıklarını güvenilir biçimde yeniden yazmalıdır. Tüm adresleri kapsayan ağlar/boolean trust ayarı kabul edilmez. Aksi takdirde tüm kullanıcıların aynı proxy hız sınırına takılması veya sahte IP ile sınırı aşması mümkün olur.

Güncel kalite incelemesi ve kalan işler: [eksik ve kalite raporu](docs/kalite-ve-eksikler-raporu.md). Mimari: [multi-tenant tasarım](docs/google-drive-multi-tenant-mimari.md).

Üretim Compose/Caddy, örnek ortam ve izleme kaynakları bu depodaki [deploy rehberinde](deploy/README.md) bulunur. Frontend deposunu aynı üst dizine klonlayın. Bu dosyaların hazırlanması canlı kurulumun tamamlandığı anlamına gelmez.

Temel kaynaklar: [Mongoose transactions](https://mongoosejs.com/docs/transactions.html), [Express güvenlik](https://expressjs.com/en/advanced/best-practice-security.html), [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).
