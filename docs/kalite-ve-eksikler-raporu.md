# Kalite incelemesi ve kalan eksikler — 23 Ekim 2026

Google ile girişten sonra davet bağlantısını yeniden yapıştırma sorunu giderildi. Davet tokenı Google URL'sine veya tarayıcı depolamasına yazılmadan, 10 dakikalık şifreli OAuth kaydında session ve state'e bağlanır. Callback bağlamı tek sefer tüketip siler; kullanıcı yine daveti açıkça kabul eder. İptal, başka oturum, değiştirilmiş bağlam, süre, replay, CSRF ve geciken frontend yanıtları test edildi. Yeni akışın gerçek tarayıcıda Google dönüşü kabulü ayrıca bekliyor.

Bu değişiklikler için **28/28 hedefli backend auth** ve **73/73 frontend testi**, Nuxt tip ve E2E kaynak tip denetimleri geçti. Tam backend ve Docker sonuçları aşağıda tarihleriyle ayrılır; bu hedefli çalıştırma tüm testlerin yeniden çalıştırıldığı anlamına gelmez. Nuxt 4.6.2'ye güncellendi: audit sonucu frontend'de 2 high/0 moderate/0 critical, backend'de 0 bulgu. İki upstream araç zinciri bildirimi ve üretim çıktısı sınırı [bağımlılık raporunda](bagimlilik-guvenlik-durumu.md).

**Tamamlanan teslim ve manuel kabul:** İki ayrı private GitHub repository oluşturulup kaynakları push edildi; ilk backend/frontend uzak CI ve Docker kontrolleri başarılı. Gerçek Atlas ve private R2 doğrulandı. Kullanıcı Google ile iki hesapta giriş, bir PDF'nin yükleme/önizleme/indirmesi, iki workspace ayrımı, davet kabulü, Viewer/Editor sınırları ve üyelik kaldırınca erişimin kesilmesini doğruladı. Gmail SMTP bağlantısı başarılı; kullanıcı kendi gönderici adresine test mesajının teslimini doğruladı. Farklı alıcıya gerçek SMTP davet teslimi ayrıca bekliyor. [GitHub teslim kaydı](github-teslim-durumu.md), [PDF eşleştirmesi](pdf-ister-karsilastirmasi.md).

Aşağıdaki teknik tablolar önceki inceleme/test kayıtlarını korur. Son bölümdeki kalan işler güncel durumu gösterir. Otomatik tarayıcı E2E/axe bu ortamın erişim politikası nedeniyle çalıştırılmadı; DOM, odak ve tüm cihaz kabulü tamamlanmış sayılmıyor.

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
- Playwright/axe test kaynakları ve ayrı E2E tip kontrolü hazır; tarayıcı testleri çalıştırılmadı. Otomatik tarayıcı kabulü uzak bağımsız CI akışlarına dahil değildir; ilk unit/tip/build/Docker CI çalışmaları geçti, canlı yayın yapılmadı.
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

Test kaynakları: [frontend aktarım testleri](https://github.com/ahmetkocdeveci/google-drive-clone-frontend/blob/main/tests/features.test.ts), [oturum/rol yarışları](https://github.com/ahmetkocdeveci/google-drive-clone-frontend/blob/main/tests/session.test.ts), [gerçek API entegrasyonu](https://github.com/ahmetkocdeveci/google-drive-clone-backend/blob/main/tests/frontend-integration.test.mjs). Geçici test DB'leri temizlendi; ana verilere dokunulmadı.

Tarayıcı için Owner→Viewer değişiminde açık klasör modalının kapanması ve işlem geçmişinden yönlendirme senaryoları da yazıldı; yalnız kaynak tip denetimi yapıldı. Tarayıcı erişim politikası nedeniyle bu testler çalıştırılmadı. DOM/odak/görsel kabulü tamamlanmış sayılmaz. Son host derlemesi izin kısıtı nedeniyle önce başarısız oldu; aynı proje derlemesi gerekli dosya izinleriyle tamamlandı. Entegrasyon ilk denemede kapalı MongoDB nedeniyle çalışamadı; mevcut MongoDB konteyneri başlatılınca iki test de geçti.

## Atlas ve R2 sağlayıcı kontrolü — 22 Ekim

Atlas bağlantısı/ping, replica set ve16 modelin koleksiyon/indeks kurulumu doğrulandı. R2 üzerinde gerçek imzalı PUT200, tam/Range bayt eşleşmesi, immutable finalize/retry, ZIP ve conditional write testleri başarılı. Yerel frontend için CORS preflight204 ve izin başlıkları doğru. Tüm geçici test nesneleri temizlendi. Bu provider/API testidir; gerçek browser, dış SMTP, Google ve canlı deployment kabulü değildir. [Ayrıntılı kurulum kaydı](canli-kurulum-gerekenler.md).

## Hâlâ kalanlar

| Öncelik | İş | Neden tamamlanmış sayılmıyor? |
| --- | --- | --- |
| PDF öğrenme kapsamı | Tüm dersler ve Data Modeling bölümleri için kişisel notlar | Hazır rehber/özet var; kaynakların tamamının çalışıldığına dair bölüm envanteri ve kişisel tamamlama kaydı yok |
| Canlı kullanım öncesi | Yayın ortamı ve farklı alıcıya gerçek davet e-postası | Google yerel kabulü, Atlas/R2 ve Gmail self-test tamamlandı. HTTPS yayın origin'leri ve farklı alıcıya gerçek SMTP davet teslimi bekliyor |
| Canlı kullanım öncesi | HTTPS, aynı site/gateway, üretim MongoDB erişimi ve secret yönetimi | Yerel compose üretim altyapısı değildir. Üretim ortamı kurulup gerçek cookie/CSRF/proxy akışı test edilmeli |
| Canlı kullanım öncesi | Gerçek tarayıcı E2E, mobil/klavye/erişilebilirlik ve önizleme kabulü | Kaynak, tip, API ve composable kontrolleri DOM/görsel davranışı garanti etmez. Son değişiklikler tarayıcıda onaylanmadı |
| Güvenlik takibi | Nuxt araç zincirinde `node-forge` ve `braces` için iki high bildirim | Kaynak paketin `pnpm audit --prod` çıktısında mevcut; yayımlanmış düzeltme sürümü yok. Üretim imajında bu paketler bulunmadı ve tekrar girmelerini engelleyen `check:runtime` derleme kontrolü eklendi. Paket açıkları düzeltilmiş sayılmadı; [ayrıntı ve resmi kaynaklar](bagimlilik-guvenlik-durumu.md) |
| Canlı operasyon | Gerçek alarm teslimatı ve bakım/yedek zamanlaması | Uzak CI ilk teslimde geçti. Canlı alarm, saklama/RPO/RTO ve canlı kurtarma ortamı doğrulanmadı |

Dosya içeriğini düzenleme ilk kapsamın dışındadır. Çöp kutusu/geri alma, Office içeriği render etme ve ek paylaşım modelleri de bu sürümün uygulanmış özellikleri olarak gösterilmemelidir. Önizleme desteklenen görsel/PDF türleriyle sınırlıdır; diğer dosyalar indirilebilir.

## Sıradaki somut adımlar

Tasarımla karşılaştırmada bulunan işlem geçmişi API/ekranı ve aktif indirme erişim iptali tamamlandı. Kontrol aralığı ve doğrulama beklemesine ağ/event-loop gecikmesi eklenebilir; önceden gönderilmiş baytlar geri alınamaz. Genel `/jobs/:jobId` tasarım rotasının yerini arşive özgü `/archives/:id` durum sorgusu aldı.

[PDF karşılaştırmasındaki](pdf-ister-karsilastirmasi.md) iki kod eksiği kapatıldı; iki bağımsız repository teslim edildi; sırada yayın ve kalan tarayıcı kabulü var.

1. [Canlı kurulum listesi](canli-kurulum-gerekenler.md) üzerinden domain, sunucu, MongoDB, Google, private bucket ve SMTP hesaplarını hazırlamak.
2. Gerçek tarayıcıda rol/hesap değişimi, davet, yükleme, indirme, mobil/klavye ve erişilebilirlik kabulünü çalıştırmak. Büyük ZIP'in son Blob indirmesini hedef cihazlarda ölçmek.
3. HTTPS altında gerçek sağlayıcı smoke testleri, alarm teslimatı ve [yedek/restore planını](yedekleme-ve-operasyon.md) tamamlamak.
4. İki upstream bildirimi düzeltme sürümü yayımlandığında güvenli güncelleyip yeniden taramak; derleme araçlarını kullanıcı girdisi alan genel servis olarak açmamak.

[Backend kurulum](https://github.com/ahmetkocdeveci/google-drive-clone-backend/blob/main/README.md) · [Frontend kurulum](https://github.com/ahmetkocdeveci/google-drive-clone-frontend/blob/main/README.md) · [API sözleşmesi](https://github.com/ahmetkocdeveci/google-drive-clone-frontend/blob/main/docs/api-contract.md)

Teknik dayanaklar: [Google e-posta otoritesi](https://developers.google.com/identity/sign-in/web/backend-auth), [AWS SDK checksum davranışı](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html), [S3 presigner başlıkları](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/).

23 Ekim son yerel doğrulaması: Nuxt 4.6.2 üretim derlemesi, E2E kaynak tip kontrolü ve 21 manifest runtime sınırı kontrolü geçti; node-forge/braces üretim çıktısında bulunmadı. İlk derleme Windows EPERM nedeniyle durdu, aynı derleme gerekli izinlerle başarılı oldu. Outbox 0 pending/0 sending/0 failed iken backend yeni kodla yeniden başlatıldı; Atlas /health ok ve frontend 4179 dinleme kontrolü başarılı. Bu kontroller frontend sayfasını açma veya yeni Google akışının manuel kabulü değildir.
