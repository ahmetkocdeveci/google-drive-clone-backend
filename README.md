# Ortak Drive · Backend

Çalışma alanlarına ayrılmış dosya paylaşım uygulamasının Express API'si. Hesaplar, üyelikler ve dosya bilgileri MongoDB'de; dosya içerikleri özel nesne deposunda tutulur. Her istek güncel oturum, rol ve çalışma alanı sınırı üzerinden yetkilendirilir.

## Bağlantılar

| Kaynak | Adres |
| --- | --- |
| Canlı uygulama | [ahmet-drive.pages.dev](https://ahmet-drive.pages.dev) |
| Canlı API | [Northflank API](https://p01--google-drive-clone-backend--d7y2sxv84npc.code.run) |
| API hazırlık kontrolü | [/health/ready](https://p01--google-drive-clone-backend--d7y2sxv84npc.code.run/health/ready) |
| Backend deposu | [google-drive-clone-backend](https://github.com/ahmetkocdeveci/google-drive-clone-backend) |
| Frontend deposu | [google-drive-clone-frontend](https://github.com/ahmetkocdeveci/google-drive-clone-frontend) |
| Otomatik kontroller | [Backend checks](https://github.com/ahmetkocdeveci/google-drive-clone-backend/actions/workflows/ci.yml) |

Depolar özeldir; kaynak koduna erişim için depo yetkisi gerekir. API'nin korumalı yollarına doğrudan erişimde `403 EDGE_REQUIRED` beklenir. Uygulama bu yollara Cloudflare Pages üzerindeki aynı origin `/api/v1` gateway'i üzerinden erişir. Gateway doğrulaması kullanıcı girişinin ve rol kontrolünün yerine geçmez.

## İşlevler ve roller

- E-posta/parola ile kayıt, doğrulama, giriş/çıkış, parola sıfırlama; Google ile giriş ve açık onayla hesap bağlama.
- Birden fazla çalışma alanı; yeni alanı oluşturan kullanıcı için Owner üyeliği.
- Kayıtlı olmayan e-postalara Editor/Viewer daveti, yenileme/iptal ve doğrulanmış hesapla kabul.
- İç içe klasörler, klasör yükleme, arama, filtreleme, sıralama ve cursor ile sayfalama.
- Dosya yükleme/indirme/önizleme akışı; ad değiştirme, taşıma, çoklu silme ve klasör ZIP indirme.
- Owner için işlem geçmişi, üyelik/rol yönetimi ve sahiplik devri.

| İşlem | Owner | Editor | Viewer |
| --- | :---: | :---: | :---: |
| Dosya/klasör görüntüleme ve indirme | ✓ | ✓ | ✓ |
| İçerik yükleme, oluşturma, taşıma, adlandırma ve silme | ✓ | ✓ | — |
| Üye/davet/rol ve alan ayarlarını yönetme | ✓ | — | — |
| İşlem geçmişi, sahiplik devri ve alan silme | ✓ | — | — |

Rol kullanıcıya değil **alan üyeliğine** aittir. Kaynak kimliğini değiştirmek başka bir alanın verisine erişim sağlamaz. Son Owner'ın kaldırılması engellenir. Dosya içeriğini uygulama içinde düzenleme kapsam dışıdır. Word/PowerPoint dosyaları özgün biçimleriyle indirilir; görsel/PDF çizimi frontend'de yapılır.

## Yerel kurulum

Node.js **24.19.0**, pnpm **11.25.0** ve çalışan Docker gerekir. İki depoyu aynı üst dizine klonlayın:

```sh
git clone https://github.com/ahmetkocdeveci/google-drive-clone-backend.git
git clone https://github.com/ahmetkocdeveci/google-drive-clone-frontend.git
cd google-drive-clone-backend
pnpm install --frozen-lockfile
pnpm run setup
docker compose up -d
pnpm dev
```

`setup`, `.env.example` üzerinden yerel ayarları ve bağımsız rastgele anahtarları oluşturur. Mevcut `.env` değerlerini korur, eksik anahtarları tamamlar; sırları terminale yazmaz. Yeni klonda varsayılanlar yerel MongoDB, Mailpit ve `.data/objects` deposudur. Mevcut üretim `.env` dosyasını geliştirmede kullanmayın.

| Servis | Yerel adres |
| --- | --- |
| API | `http://127.0.0.1:4100/api/v1` |
| Hazırlık kontrolü | `http://127.0.0.1:4100/health/ready` |
| Frontend | `http://127.0.0.1:4179` |
| Geliştirme e-posta kutusu | `http://127.0.0.1:8025` |
| MongoDB | `127.0.0.1:27018`, `rs0` replica set |

İkinci terminalde kardeş frontend deposunun README'sindeki kurulumu tamamlayın. Uygulamada kayıt olup doğrulama bağlantısını Mailpit'ten açın. Yerel varsayılanlar gerçek alıcılara mesaj göndermez. Origin ayarlarında `localhost` ile `127.0.0.1` adreslerini karıştırmayın.

## Yapılandırma ve canlı yayın

```text
Tarayıcı → Cloudflare Pages /api/v1 → Northflank API
                                       ├─ Private MongoDB (TLS)
                                       ├─ Private Cloudflare R2
                                       └─ SMTP / Google OAuth
```

Yayın Docker imajıyla Northflank'ta çalışır: port `4100`, hazırlık yolu `/health/ready`, tek API instance. MongoDB aynı projede özel ağ ve TLS ile bağlıdır; dosyalar R2'dedir. Bilgisayarın açık kalması gerekmez.

Başlıca ayarlar `.env.example` içindedir:

| Alan | Ayarlar |
| --- | --- |
| Sunucu / origin | `NODE_ENV`, `HOST`, `PORT`, `API_ORIGIN`, `FRONTEND_ORIGIN` |
| MongoDB | `MONGODB_URI` |
| Depolama | `STORAGE_DRIVER`, `LOCAL_STORAGE_PATH` veya `S3_*` |
| E-posta | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Bağımsız anahtarlar | `OUTBOX_ENCRYPTION_KEY`, `UPLOAD_SIGNING_KEY`, `PAGINATION_SIGNING_KEY`, `OPERATIONS_TOKEN`, `BACKUP_ENCRYPTION_KEY` |
| Gateway | `EDGE_PROXY_TOKEN`, gerektiğinde dar kapsamlı `TRUSTED_PROXY_CIDRS` |

Üretimde HTTPS, özel S3/R2 bucket ve TLS destekleyen SMTP kullanılır. `API_ORIGIN` ve `FRONTEND_ORIGIN`, dışarıdan görünen `https://ahmet-drive.pages.dev` adresidir. Google istemcisindeki dönüş adresi:

```text
https://ahmet-drive.pages.dev/api/v1/auth/google/callback
```

Google istemcisi ve test kullanıcıları Google Cloud'da ayrıca yapılandırılır. Sağlayıcı yoksa API bunu `/auth/providers` ile bildirir. E-posta eşleşmesi otomatik hesap birleştirme sağlamaz.

`EDGE_PROXY_TOKEN`, Pages ve API'de aynı **Secret** olmalıdır. Sırlar public Nuxt ayarlarına veya Git'e konmaz. R2 CORS yalnız uygulama origin'inden yüklemeye açılır; bucket public yapılmaz. Ayrıntılar: [Cloudflare–Northflank kurulumu](docs/cloudflare-northflank.md), [Docker/alternatif yayın](deploy/README.md).

## Testler

```sh
docker compose up -d
pnpm check
pnpm check:deploy
pnpm test
pnpm audit --prod
docker build -t ortak-drive-api:local .
```

Testler gerçek MongoDB replica set ve HTTP kullanır; gruplar ayrı geçici veritabanlarını oluşturup temizler. Yetkilendirme, tenant sınırı, eşzamanlı rol değişimi, davet/OAuth state/PKCE, CSRF, dosya/arşiv, kuyruk ve yedek bütünlüğü kapsanır. Google token ve SMTP hata testlerinde kontrollü servisler kullanılır; canlı sağlayıcı kabulünün yerine geçmez.

Frontend kardeş dizindeyse gerçek HTTP adapter entegrasyonu da çalışır; bağımsız backend klonunda yalnız bu senaryo açıkça atlanır. Tarayıcıdan kayıt, e-posta, davet, dosya/klasör, masaüstü/mobil ve erişilebilirlik testleri **frontend CI `browser` işindedir**. Bu iş kendi MongoDB/Mailpit ve rastgele test DB'sini kullanır; canlı kullanıcı verisine bağlanmaz.

`pnpm test:local`, çalışan geliştirme API'sinde sentetik hesap oluşturur. `node scripts/test-smtp.mjs` bağlantıyı denetler; gerçek mesaj ancak `--send-to-self` ile gönderilir. Bunları canlı ortamda genel test komutu olarak kullanmayın.

## Kod düzeni ve güvenlik

| Dosya | Sorumluluk |
| --- | --- |
| `src/auth.mjs` | Hesap, oturum, doğrulama ve Google OAuth |
| `src/tenant.mjs` | Güncel üyelik ve transaction sınırı |
| `src/workspaces.mjs` | Alan, üye, davet ve roller |
| `src/files.mjs` | Klasör/dosya ve aktarım işlemleri |
| `src/models.mjs` | Şemalar ve indeksler |
| `src/storage.mjs` | Yerel/S3 adaptörleri |
| `src/mailer.mjs` | Şifreli transactional e-posta outbox'ı |
| `src/worker.mjs` | Temizlik ve arşiv işleri |

Parolalar scrypt ile hash'lenir; oturum ve bağlantı tokenlarının yalnız hash'leri saklanır. Üretim cookie'si HttpOnly/Secure/SameSite'tır. Yazmalar Origin ve oturuma bağlı CSRF kontrolünden geçer. Hız sınırı MongoDB'de tutulur. Dosyalar public URL ile sunulmaz; stream boyunca yetki tekrar kontrol edilir. Teslim edilmiş baytlar geri alınamaz.

[API sözleşmesi](docs/api-contract.md) · [Teslim kontrolü](docs/release-checklist.md)

Kod üzerinden anlatım için [ayrıntılı teknik sunum rehberi](docs/teknik-sunum-rehberi.md) ve [kısa konuşma notları](docs/sunum-konusma-notlari.md): teknoloji seçimleri, veri modeli, güvenlik, dosya yaşam döngüsü, kod haritası ve soru-cevaplar.

## Sınırlar ve yedekleme

- Dosya **25 MiB**, alan **5 GiB**, klasör yolu **64 seviye**.
- Doğrudan ZIP **1.000 öğe / 100 MiB**; arka plan arşivi **100.000 öğe / 1 GiB**. Büyük indirmelerde istemci belleği de sınırdır.
- Klasör aktarımı atomik değildir; hata/iptalde tamamlanan öğeler kalabilir. Tekrar yükleme yeni kök oluşturur.
- MongoDB'de **Pazartesi 01:00 UTC**, **14 gün saklamalı** haftalık Northflank snapshot planı vardır. İlk manuel snapshot tamamlanmıştır. Ücretsiz planda günlük plan desteklenmemiştir.
- R2'nin ayrı şifreli yerel yedeği ve yerel geri çıkarma kontrolü yapılmıştır. Düzenli R2 bulut yedeği ve ortak MongoDB/R2 anına tam geri dönüş henüz kurulmamıştır; DB snapshot'ı dosya içeriğini kapsamaz.

`pnpm backup` bakım aralığında DB ve nesneleri şifreli yedekler; restore yalnız yeni hedefe yapılır. Anahtar ayrı saklanmalıdır. [Operasyon rehberi](docs/yedekleme-ve-operasyon.md) tutarlılık koşullarını açıklar. Ücretsiz kotalar ve tek instance yapısı yüksek erişilebilirlik garantisi sağlamaz.
