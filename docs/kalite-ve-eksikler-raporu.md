# Kalite incelemesi ve kalan eksikler — 22 Ekim 2026

**23 Ekim — Gerçek e-posta teslimatı:** Kullanıcı gönderici Gmail hesabının kendi adresine gönderilen test mesajının gelen kutusuna ulaştığını doğruladı. Gmail SMTP bağlantısı ve self-test teslimatı kabul edildi. İkinci posta hesabına erişim olmadığından farklı alıcıya gerçek davet teslimatı henüz denenmedi. İki bağımsız private repository ve canlı yayın çalışmaları devam ediyor; GitHub CLI yerel PATH'te bulunmadı.

**23 Ekim — Gmail SMTP bağlantısı:** Kullanıcı gerçek gönderici ayarını yerelde kaydetti; Gmail TLS/kimlik doğrulaması e-posta göndermeyen `verify()` ile geçti. Eski posta kuyruğu boşken backend yeni ayarla yeniden başlatıldı ve Atlas sağlık kontrolü başarılı. Gerçek davetin alıcı kutusuna teslimi kullanıcı testi olarak bekliyor; SMTP bağlantı başarısı teslimat kabulü olarak gösterilmemelidir.

**Yerel manuel kabul sonuçları:** Kullanıcı bir PDF için yükleme/önizleme/indirmeyi, iki workspace arasında dosya listelerinin ayrıldığını, ikinci hesapla davet kabulünü, Viewer ve Editor yetki sınırlarını ve üyeliğin kaldırılmasıyla erişimin kesildiğini doğruladı. Bu kapsamda planlanan manuel kontrol listesi tamamlandı. Sonuçlar doğrudan API güvenlik testlerinin veya otomatik browser E2E'nin bu tur yeniden çalıştırıldığını göstermez. Gerçek dış e-posta teslimatı, iki bağımsız private repository, canlı frontend/API yayını ve diğer cihaz/dosya türü kabul çalışmaları hâlâ bekliyor.

**Manuel PDF kabulü:** Kullanıcı, PDF.js düzeltmesinden sonra kendi tarayıcısında PDF önizlemesinin düzeldiğini doğruladı. Aşağıdaki düzeltme notunda bekleyen mevcut PDF görsel kabulü tamamlandı; diğer tarayıcı/cihaz ve dosya türü kontrolleri ayrıca bekliyor.

**Son güncelleme — PDF önizleme:** Kullanıcının bildirdiği PDF hatasında mevcut iframe sandbox'ının Chromium PDF eklentisini engellediği belirlendi ([Chromium kaydı](https://issues.chromium.org/issues/41131921)). Önizleme uygulama içinde canvas'a çizilen PDF.js görüntüleyicisiyle değiştirildi; çalışma alanı/API erişim kontrolü korunuyor. Son frontend sonucu **68/68**; iki gerçek PDF sayfası piksel düzeyinde ve bozuk dosya reddi test edildi. Nuxt tip, E2E kaynak tip, üretim derlemesi ve runtime sınırı kontrolleri başarılı. Yerel güncel frontend çalışıyor; kullanıcı tarayıcısında tekrar deneme bekleniyor. Bu sonuç önceki API/MongoDB entegrasyonlarını veya tam backend paketini yeniden çalıştırıldığı anlamına gelmez.

**Karar:** Son incelemede bulunan üç kod sorunu düzeltildi: hazır ZIP iptalinde arşiv sınırının serbest kalması, sekmeye dönüşte güncel workspace rolünün uygulanması ve kesilen indirmede güvenli Türkçe hata. 22 Ekim'de frontend66/66, hedefli gerçek API/MongoDB entegrasyon2/2 testi, Nuxt tip kontrolü, E2E kaynak tip kontrolü, üretim derlemesi ve runtime paket kontrolü geçti. Backend'in önceki tam101/101 sonucu21 Ekim'e aittir; bu tur tam backend paketi ve Docker imajları yeniden çalıştırılmadı. Canlı sağlayıcı kurulumu, gerçek tarayıcı kabulü ve iki araç zinciri güvenlik bildiriminin takibi sürüyor.

İnceleme sadece önceki testleri tekrar çalıştırmakla sınırlanmadı. Kimlik, dosya yaşam döngüsü ve frontend ayrı incelendi; eşzamanlılık, istemci iptali, protokol ve yapılandırma hataları kontrollü olarak yeniden üretildi. Başarılı testler bütün olası hataların yokluğu anlamına gelmez.

**PDF kapsam kontrolü — 22 Ekim:** Dört sayfalık karşılaştırmada son bulunan iki kod eksiği kapatıldı: hiyerarşik klasör upload ve dosya ayrıntısında klasör konumu/Klasöre git.66 frontend ve2 hedefli API/MongoDB testi başarılı; ikinci entegrasyon testi artık nested upload baytları ve Viewer reddini de kapsar. İki proje hâlâ bağımsız repository olarak teslim edilmedi; canlı bucket/deployment ve gerçek browser kabulü bekliyor. [Madde eşleştirmesi](pdf-ister-karsilastirmasi.md).

## Bulunan ve düzeltilen sorunlar

| Konu | Önceki sorun | Düzeltme ve kanıt |
| --- | --- | --- |
| Google e-posta sahipliği | Her `email_verified:true` Google yanıtı posta adresinin güncel sahipliğini doğrulanmış sayıyordu | Gmail/uygun hosted domain dışındaki adreslere ayrı doğrulama; gerçek RS256/JWKS doğrulaması kullanan kontrollü test. Canlı Google girişi sayılmaz |
| S3 imzalı yükleme | SDK, henüz gövdesi olmayan imzaya boş dosyanın CRC32 toplamını ekleyebiliyordu; dolu dosya reddedilebilirdi | Boş checksum dayatması kaldırıldı; Content-Type/Length imzaya bağlı. Gerçek SDK ve yerel SigV4/S3 protokol fixture'ıyla upload/finalize/range/replay testleri |
| ZIP ve dosya indirme | İstemci kapatıldığında alt depolama akışları açık kalabiliyordu | AbortSignal ve açık stream destroy; bağlantı kesme testleri |
| HEAD arşiv isteği | Gövde istemeyen istek dosyaları okuyup sıkıştırabiliyordu | Yetki/manifest kontrolünden sonra veri akışı açılmadan yanıt; storage.read çağrısı olmaması doğrulandı |
| Silme ile geciken finalize | Silinen dosyanın geç biten ikinci finalize işlemi sahipsiz sealed nesne bırakabiliyordu | Upload iptali transaction içinde; periyodik GC; başka workspace'in aktif dosyası korunarak yarış testi |
| Geç biten bucket PUT | Süresi dolmadan başlayan PUT, ilk temizlikten sonra staging nesnesini geri oluşturabiliyordu | Tamamlanmış upload'larda da staging tekrar temizlenir; aktif sealed baytlar korunur |
| Çökme artıkları | Süreç kapanınca geçici yerel dosyalar kalabiliyordu | Yalnız üretilmiş ada/yola uyan eski `.tmp` nesnelerini toplayan sınırlı kapsam; yeni/geçerli/ilgisiz dosyalar korunur |
| Dosya eşzamanlılığı | Yanıt kapanması, asıl nesne işlemi bitmeden HTTP sayacını serbest bırakabiliyordu | Depolama işleminin gerçek Promise ömrü boyunca ayrı4 işlem sınırı; provider işlemleri bekletilerek test |
| Arka plan işleri | Yavaş e-posta sağlayıcısı dosya temizliğini geciktirebiliyordu | Bağımsız mail/job döngüleri; bloklanmış SMTP sırasında cleanup tick'leri test edildi; kapanış beklemesi sınırlı |
| Giriş yanıtı | Parola kontrolü sürerken başka sekmede doğrulanan hesap için eski emailVerified bilgisi dönebiliyordu | Transaction içindeki güncel kullanıcı DTO'su döner; kontrollü HTTP yarış testi |
| Yanlış başarı gösterimi | Başka hesaba ait doğrulama linkinde mevcut hesabın verified olması başarı ekranı gösterebiliyordu | Gelen token ayrıca doğrulanır; doğru hesaba geçiş için token yalnız bellekte korunur |
| Eski oturum yanıtları | Gecikmiş401/başlangıç yanıtı yeni oturumu kapatabiliyor veya kullanıcıyı geriye alabiliyordu | Kimlik+session generation kontrolü; gerçek useDrive üzerinden dört yarış testi |
| Demo yapılandırması | Eksik/yanlış mod sessizce örnek oturuma geçebiliyordu | HTTP varsayılan; demo açık seçim; hatalı mod fail-fast |
| Google hata ekranı | Yapılandırma/izin/sağlayıcı hatası kullanıcıyı ham JSON'a götürebiliyordu | Sağlayıcı keşfi; callback'te yalnız izinli hata koduyla kendi frontend'ine yönlenme; sabit Türkçe mesajlar, token/provider metni aktarılmaz |
| Klasör taşıma | Tüm workspace klasörlerini tek seferde istemek limitlere takılıyor, aynı adlar belirsiz kalıyordu | Konum konum açılan hedef seçici, üst yollar ve döngü engeli; ortak64 seviye; istek iptalleri ayrıldı |
| Sekmeler | Başka sekmede doğrulama/hesap değişikliği açık ekranda güncellenmiyordu | Görünürlük/focus'ta oturum yenileme; kimlik değişiminde tenant state ve sayfa içeriği temizlenir |
| Proxy hız sınırı | Varsayılan proxy arkasında kullanıcılar tek IP kovasına düşebilirdi | Açık IP/CIDR allowlist; varsayılan güven yok; sahte forwarded başlığı ve farklı gerçek client IP testleri |
| Yapılandırma | Yanlış origin protokolü, SMTP portu ve eksik OAuth çifti geç fark edilebilirdi | Başlangıçta doğrulama; geniş/boolean proxy güveni reddedilir |
| Audit/veri sınırı | Audit requestId alanı dolmuyordu; outbox tenant kapsamı şemada zorunlu değildi | Sunucunun async request context'i; koşullu zorunlu tenant/identity alanları; API header–audit eşleşmesi testi |

## Doğrulama sonucu

- Backend: **21 Ekim tam çalıştırması101/101 başarılı**, skip yok. 22 Ekim hedefli frontend entegrasyon dosyası2/2 geçti; yeni iptal/yeniden deneme regresyonu dahil. Tam backend paketi bu tur tekrarlanmadı. MongoDB replica set, gerçek HTTP,2 kullanıcı/çoklu workspace, rol, hesap güvenliği, arşiv/lease yarışları, sayfalama ve gerçek DB restore dahil.
- Frontend: **22 Ekim66/66 başarılı**; domain, HTTP adapter ve gerçek composable oturum yarışları. Bunlar tarayıcı DOM testleri değildir.
- TypeScript denetimi ve son Nuxt üretim derlemesi başarılı.
- Playwright/axe test kaynakları ve ayrı E2E tip kontrolü hazır; tarayıcı testleri çalıştırılmadı. CI'daki browser kabulü yalnız açık manuel seçimle başlar; uzak GitHub üzerinde çalıştırma/yayın yapılmadı.
- Backend/frontend üretim Docker imajları derlendi. Root olmayan kullanıcıyla backend import ve Nuxt sunucu başlangıcı doğrulandı. Compose ve Caddy yapılandırma doğrulaması geçti; gerçek TLS/alan adı kurulumu değildir.
- Gerçek SMTP/Mailpit ile kayıt → doğrulama → workspace → parola sıfırlama → yeni parolayla giriş geçti. Mesajlar yerel kutuda kalır.
- MongoDB dump + özel dosya baytları şifreli yedekten ayrı DB/dizine döndürüldü; indeksler ve içerik eşleşti. CLI ile yerel geliştirme DB'sinin ayrıca yedeği alınıp ayrı hedefe restore edildi; koleksiyon sayıları eşleşti. Prova hedefi temizlendi, şifreli yedek Git dışında `.data/backups/20261021-cli-b72a3d` altında kaldı.
- Sınırlı yerel yük ölçümü:200 HTTP isteği,8 eşzamanlı istek; tenant izolasyonu korundu. Bu çalıştırmada p50=59 ms, p95=90 ms, p99=104 ms; canlı kapasite/SLA veya büyük ZIP performansı garantisi değildir.
- Sıfır bayt ve tam25 MiB dosya, limit aşımı, paralel kota/finalize, Range, ZIP ve disconnect senaryoları doğrulandı.
- Gerçek frontend HTTP adapter'ıyla kayıt → doğrulama → Owner workspace → upload/download → Viewer daveti → yazma reddi → ZIP → yeniden giriş başarılı.
- S3 test sunucusu, imzayı ve protokol davranışını yerelde denetler; AWS/R2 canlı ortam uyumluluğu, IAM ve bucket politikası doğrulaması yerine geçmez.
- Tarayıcı aracı önceki localhost erişimini politika nedeniyle reddetti. Bu incelemede aynı engel farklı browser, CLI veya dolaylı sayfa okuma yöntemiyle aşılmaya çalışılmadı; görsel/tarayıcı kabul testleri tamamlanmış sayılmadı.

## Bu tur tamamlanan eksikler

| Konu | Son davranış ve doğrulama |
| --- | --- |
| Parola kurtarma | Genel202 yanıtı,1 saatlik tek kullanımlık hash token, cooldown, şifre sürümü; başarılı sıfırlama tüm session/OAuth işlemlerini iptal eder. Eşzamanlı confirm ve geciken login/callback testleri geçti |
| Açık Google bağlama | `/account`, mevcut parola ile yeniden doğrulama, browser-bound OAuth, sabit subject ve benzersiz kullanıcı/provider; e-posta değişmez ve hesap otomatik birleşmez. Başarılı bağlama cookie döndürür |
| Sayfalama | Workspace/üye/davet/dosya sayfaları, UI “daha fazla yükle”, imzalı ve kapsamlı cursor.507 öğenin eksiksiz dolaşımı ve5000 gizli adaydan sonra görünen arama sonucu test edildi |
| Büyük klasör ZIP | Job/poll/progress/cancel/retry,1 GiB/100000 öğe sınırı, private attempt nesneleri, güncel yetki ve içerik sürümü kontrolü. Rol kaybı, kaynak değişimi, lease değişimi, expiry ve eski workspace testleri geçti |
| Arşiv temizliği | Başarılı indirme sonrası istemci temizliği, TTL, eski denemelerin sınırlı döngülü temizliği,24 saatten eski üretilmiş scratch artıklarının toplanması. Onuncu denemeyi aşan nesneler de kapsandı |
| Operasyon | Korumalı aggregate status/Prometheus, private ve cache/single-flight readiness, disk/kuyruk alarm örnekleri, CI kaynakları, Docker/HTTPS hazırlığı |
| Yedek/restore | AES-256-GCM, bütünlük doğrulaması, yeni hedef zorunluluğu, native URI ve Docker port/container kimliği eşleştirmesi. Kaynakla farklı cluster'a giden restore engellenir |
| Owner işlem geçmişi | Tenant kapsamlı, sayfalı `/audit-events` API'si ve `/activity` ekranı eklendi. Güncel Owner dışında403/404, actor için yalnız ad/ID, silinmiş kullanıcı yedek adı; sorgu sürerken Owner yetkisini kaybetme testi de geçti |
| Devam eden indirmede erişim iptali | Dosya/Range, doğrudan ZIP ve hazır async ZIP boyunca oturum/hesap/üyelik/kaynak/üst klasörler yeniden kontrol edilir.250 ms kontrol beklemesi,1 sn doğrulama bekleme sınırı; hata veya erişim kaybında stream kapanır. Owner→Viewer okuma erişimini korur. HEAD, iptal, kapasite salma ve64 seviye testleri geçti |

## Son incelemenin üç düzeltmesi — 22 Ekim

| Önceki bulgu | Uygulanan düzeltme | Doğrulama |
| --- | --- | --- |
| Hazır ZIP indirmesinde iki iptal sonrası429 `ARCHIVE_LIMIT` | Arşiv temizliği ortak `finally` bölümüne taşındı. Başarı, iptal ve aktarım hatasında `pending`/`running`/`ready` kayıtları bağımsız5 saniyelik sinyalle iptal edilir. Temizleme hatası asıl sonucu değiştirmez; TTL yedeği korunur | Gerçek adaptör + gerçek API/MongoDB ile dört ardışık iptalden sonra aktif kayıt sayısı0; sonraki oluşturma202. Hazır durum ve kesilen gövde kontrollü test girdisidir. Ayrı entegrasyon testi gerçek ZIP üretimi ve başarılı indirmeyi de doğrular |
| Aynı hesabın Owner→Viewer değişikliğinde eski menülerin kalması | Focus/visibility yenilemesi aktif workspace rol/yeteneklerini de alır. Değişiklik sayfa anahtarını yeniler; önceki sayfanın modal/istekleri dispose edilir. Üye/ayar/geçmiş ekranına yetki kaybında dosyalara, üyelik kaybında workspace listesine dönülür | Gerçek `useDrive` ile dört ekran,403/404, geciken eski hesap/workspace yanıtları, oturum sona ermesi, geçici ağ hatası ve eşzamanlı focus kontrolleri geçti. Değişmeyen yetkiler sayfayı gereksiz sıfırlamaz |
| Gövde kesilince `terminated` gibi ham teknik hata | `response.blob()` hataları sabit Türkçe `DOWNLOAD_INTERRUPTED` mesajına çevrilir. Bilinçli iptalin özgün `AbortError`/sinyal nedeni korunur | Dosya ve hazır ZIP gövde kesilmesi, bilinçli iptal, başarısız temizlemenin asıl hatayı koruması test edildi |

Test kaynakları: [frontend aktarım testleri](../google-drive-clone-frontend/tests/features.test.ts), [oturum/rol yarışları](../google-drive-clone-frontend/tests/session.test.ts), [gerçek API entegrasyonu](../google-drive-clone-backend/tests/frontend-integration.test.mjs). Geçici test DB'leri temizlendi; ana verilere dokunulmadı.

Tarayıcı için Owner→Viewer değişiminde açık klasör modalının kapanması ve işlem geçmişinden yönlendirme senaryoları da yazıldı; yalnız kaynak tip denetimi yapıldı. Tarayıcı erişim politikası nedeniyle bu testler çalıştırılmadı. DOM/odak/görsel kabulü tamamlanmış sayılmaz. Son host derlemesi izin kısıtı nedeniyle önce başarısız oldu; aynı proje derlemesi gerekli dosya izinleriyle tamamlandı. Entegrasyon ilk denemede kapalı MongoDB nedeniyle çalışamadı; mevcut MongoDB konteyneri başlatılınca iki test de geçti.

## Atlas ve R2 sağlayıcı kontrolü — 22 Ekim

Atlas bağlantısı/ping, replica set ve16 modelin koleksiyon/indeks kurulumu doğrulandı. R2 üzerinde gerçek imzalı PUT200, tam/Range bayt eşleşmesi, immutable finalize/retry, ZIP ve conditional write testleri başarılı. Yerel frontend için CORS preflight204 ve izin başlıkları doğru. Tüm geçici test nesneleri temizlendi. Bu provider/API testidir; gerçek browser, dış SMTP, Google ve canlı deployment kabulü değildir. [Ayrıntılı kurulum kaydı](canli-kurulum-gerekenler.md).

## Hâlâ kalanlar

| Öncelik | İş | Neden tamamlanmış sayılmıyor? |
| --- | --- | --- |
| PDF teslimi | Gerçekten iki ayrı repository ve bağlantıları | İsimler uygun iki paket aynı üst repository içinde; ayrı repo teslimi henüz yok |
| PDF öğrenme kapsamı | Tüm dersler ve Data Modeling bölümleri için kişisel notlar | Hazır rehber/özet var; kaynakların tamamının çalışıldığına dair bölüm envanteri ve kişisel tamamlama kaydı yok |
| Canlı kullanım öncesi | Google OAuth, harici SMTP ve yayın ortamı ayarları | Atlas ve özel R2 bağlantısı, yerel CORS ve provider dosya akışı doğrulandı. Google, dış SMTP, yayın origin ve canlı uygulama kabulü bekliyor; Mailpit gerçek alıcılara mesaj göndermez |
| Canlı kullanım öncesi | HTTPS, aynı site/gateway, üretim MongoDB erişimi ve secret yönetimi | Yerel compose üretim altyapısı değildir. Üretim ortamı kurulup gerçek cookie/CSRF/proxy akışı test edilmeli |
| Canlı kullanım öncesi | Gerçek tarayıcı E2E, mobil/klavye/erişilebilirlik ve önizleme kabulü | Kaynak, tip, API ve composable kontrolleri DOM/görsel davranışı garanti etmez. Son değişiklikler tarayıcıda onaylanmadı |
| Güvenlik takibi | Nuxt araç zincirinde `node-forge` ve `braces` için iki high bildirim | Kaynak paketin `pnpm audit --prod` çıktısında mevcut; yayımlanmış düzeltme sürümü yok. Üretim imajında bu paketler bulunmadı ve tekrar girmelerini engelleyen `check:runtime` derleme kontrolü eklendi. Paket açıkları düzeltilmiş sayılmadı; [ayrıntı ve resmi kaynaklar](bagimlilik-guvenlik-durumu.md) |
| Canlı operasyon | CI'ı uzak repoda çalıştırma, gerçek alarm teslimatı ve bakım/yedek zamanlaması | Kaynaklar ve yerel tatbikat hazır; sunucu/hesap olmadığı için uzak çalıştırma, saklama/RPO/RTO ve canlı kurtarma ortamı doğrulanmadı |

Dosya içeriğini düzenleme ilk kapsamın dışındadır. Çöp kutusu/geri alma, Office içeriği render etme ve ek paylaşım modelleri de bu sürümün uygulanmış özellikleri olarak gösterilmemelidir. Önizleme desteklenen görsel/PDF türleriyle sınırlıdır; diğer dosyalar indirilebilir.

## Sıradaki somut adımlar

Tasarımla karşılaştırmada bulunan işlem geçmişi API/ekranı ve aktif indirme erişim iptali tamamlandı. Kontrol aralığı ve doğrulama beklemesine ağ/event-loop gecikmesi eklenebilir; önceden gönderilmiş baytlar geri alınamaz. Genel `/jobs/:jobId` tasarım rotasının yerini arşive özgü `/archives/:id` durum sorgusu aldı.

[PDF karşılaştırmasındaki](pdf-ister-karsilastirmasi.md) iki kod eksiği kapatıldı; sırada gerçek tarayıcı kabulü ve iki bağımsız repository teslimi var.

1. [Canlı kurulum listesi](canli-kurulum-gerekenler.md) üzerinden domain, sunucu, MongoDB, Google, private bucket ve SMTP hesaplarını hazırlamak.
2. Gerçek tarayıcıda rol/hesap değişimi, davet, yükleme, indirme, mobil/klavye ve erişilebilirlik kabulünü çalıştırmak. Büyük ZIP'in son Blob indirmesini hedef cihazlarda ölçmek.
3. HTTPS altında gerçek sağlayıcı smoke testleri, alarm teslimatı ve [yedek/restore planını](yedekleme-ve-operasyon.md) tamamlamak.
4. İki upstream bildirimi düzeltme sürümü yayımlandığında güvenli güncelleyip yeniden taramak; derleme araçlarını kullanıcı girdisi alan genel servis olarak açmamak.

[Backend kurulum](../google-drive-clone-backend/README.md) · [Frontend kurulum](../google-drive-clone-frontend/README.md) · [API sözleşmesi](../google-drive-clone-frontend/docs/api-contract.md)

Teknik dayanaklar: [Google e-posta otoritesi](https://developers.google.com/identity/sign-in/web/backend-auth), [AWS SDK checksum davranışı](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html), [S3 presigner başlıkları](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/).
