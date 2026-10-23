# PDF isterleri ile uygulamanın karşılaştırılması

İlk PDF kontrolü: 22 Ekim 2026; durum güncellemesi: 23 Ekim 2026. Kaynak: `C:/Users/ahmet/Desktop/Ahmet_Kodeveci_-_6.pdf`, 2 Ekim 2026 tarihli dört sayfa. Metin ve dört sayfanın görseli birlikte incelendi. PDF, proje kapsamını değerlendirmek için kullanıldı; içeriği ayrıca bir yayınlama, hesap açma veya dış servise veri gönderme izni olarak yorumlanmadı.

**Sonuç: PDF'nin tamamı henüz karşılanmıyor.** Son bulunan iki kod eksiği22 Ekim'de kapatıldı: klasör seçme/sürükleme ile hiyerarşik upload ve dosya ayrıntısında klasör yolu/konuma gitme.66 frontend ve2 gerçek API/MongoDB entegrasyon testi geçti. Gerçek Atlas ve özel R2 bağlantıları ayrıca doğrulandı. İki ayrı private repository teslimi ve ilk uzak CI kabulü tamamlandı. Kullanıcı yerelde Google, PDF, workspace, davet ve rol kontrollerini doğruladı. API/frontend canlı deployment, kalan tarayıcı/cihaz kabulü ve kişisel kaynak tamamlama kayıtları hâlâ açık.

Durumlar: **Kod mevcut** = uygulama ve ilgili kaynak/test mevcut; canlı/tarayıcı kabulünü tek başına kanıtlamaz. **Kısmi** = isterin bir bölümü karşılanıyor. **Eksik** = gerekli sonuç henüz yok. **Doğrulanmadı** = tamamlandı diyebilmek için yeterli kanıt yok. İlk karşılaştırma sonrasında iki özellik uygulandı ve aşağıdaki satırlar yeni kanıtlara göre güncellendi. Tarayıcı test kaynakları yazıldı/tip kontrolü yapıldı; tarayıcıda çalıştırılmadı.

## Teknik yapı ve workspace — PDF sayfa 1–2

| ID | İster | Durum | Kanıt / kalan iş |
| --- | --- | --- | --- |
| T01 | Frontend/backend ayrı repository | Tamamlandı | İki bağımsız Git kökü ve private remote oluşturuldu, main dallarına push edildi; [teslim kaydı](github-teslim-durumu.md) |
| T02 | Nuxt frontend | Kod mevcut | [Frontend package.json](https://github.com/ahmetkocdeveci/google-drive-clone-frontend/blob/main/package.json), Nuxt sayfaları; 22 Ekim tip kontrolü ve üretim derlemesi başarılı |
| T03 | Frontend/backend ayrı deployment | Kısmi | Ayrı Dockerfile ve [compose servisleri](../deploy/compose.yaml) var; çalışan canlı API/frontend deployment'ı yok |
| T04 | `google-drive-clone-backend` / `google-drive-clone-frontend` isimleri | Tamamlandı | Kullanıcıya ait iki ayrı private repository bu adlarla teslim edildi |
| W01 | Multi-tenant mimari | Kod mevcut | [Tenant politikası](https://github.com/ahmetkocdeveci/google-drive-clone-backend/blob/main/src/tenant.mjs), [modeller](https://github.com/ahmetkocdeveci/google-drive-clone-backend/blob/main/src/models.mjs); workspace kapsamlı sorgular |
| W02 | Kullanıcının bir veya birden fazla workspace'i | Kod mevcut | [Workspace API](https://github.com/ahmetkocdeveci/google-drive-clone-backend/blob/main/src/workspaces.mjs), frontend liste/alan değiştirme, sayfalama |
| W03 | Workspace oluşturanın otomatik Owner olması | Kod mevcut | Oluşturma transaction'ı ve [workspace testleri](https://github.com/ahmetkocdeveci/google-drive-clone-backend/blob/main/tests/workspaces.test.mjs) |
| W04 | Owner tüm içerik, ayar ve üye işlemleri | Kod mevcut | Tenant izin tablosu; üyelik/rol/ayar API'leri, son Owner koruması; işlem geçmişi de eklendi |
| W05 | Editor içerik görüntüleme/oluşturma/düzenleme/silme; yönetim yapamama | Kod mevcut | Metadata ad/konum düzenleme ve içerik CRUD izinleri. Dosyanın içeriğini düzenleme PDF'de kapsam dışı. Doğrudan API rol kontrolleri mevcut |
| W06 | Viewer yalnız görüntüleme | Kod mevcut | Okuma/indirme var; yazma, upload, silme ve yönetim API'de reddedilir. [Dosya rol testleri](https://github.com/ahmetkocdeveci/google-drive-clone-backend/blob/main/tests/files.test.mjs) |
| W07 | Davet workspace'e bağlı ve e-posta üzerinden | Kod mevcut | Workspace/Invitation ilişkisi, Owner kontrolü, [mailer](https://github.com/ahmetkocdeveci/google-drive-clone-backend/blob/main/src/mailer.mjs) |
| W08 | Kayıtsız kullanıcıyı davet edebilme | Kod mevcut / yerel kabul | Hesap olmadan davet; kabul için eşleşen doğrulanmış e-posta. İkinci hesapla Mailpit davet kabulü ve Gmail self-test doğrulandı; farklı alıcıya gerçek SMTP davet teslimi bekliyor |
| W09 | Davette Editor/Viewer seçimi | Kod mevcut | Backend doğrulama ve üye ekranındaki rol seçimi; Owner davet rolü kabul edilmez |
| W10 | UI ve doğrudan API'de yetki kontrolü | Kod mevcut | Üye/ayar/içerik endpoint'leri güncel üyeliği kontrol eder; 403/404 testleri var. UI rol yenilemesi22 Ekim'de düzeltildi |
| W11 | Auth/authz/data access boyunca tenant sınırı | Kod mevcut | Workspace/parent/node kapsamı, transaction kilidi, immutable object key, doğrudan yabancı ID testleri. Bu kontrol bütün olası güvenlik hatalarının yokluğu garantisi değildir |

## Kimlik, dosya ve klasör — PDF sayfa 2–3

| ID | İster | Durum | Kanıt / kalan iş |
| --- | --- | --- | --- |
| A01 | E-posta/şifre kayıt | Kod mevcut | [Auth API](https://github.com/ahmetkocdeveci/google-drive-clone-backend/blob/main/src/auth.mjs), kayıt sayfası; yerel gerçek HTTP/MongoDB testi |
| A02 | E-posta/şifre giriş | Kod mevcut | Auth API, login; cookie ve gerçek frontend adaptör entegrasyonu |
| A03 | Google ile giriş | Yerel manuel kabul — canlı HTTPS bekliyor | İki gerçek Google hesabıyla yerel giriş kullanıcı tarafından doğrulandı. Yeni davet dönüşü 28 hedefli auth testinde doğrulandı; bu düzeltmenin Google dönüşü manuel kabulü bekliyor |
| A04 | Çıkış ve oturum yönetimi | Kod mevcut | Session hash, HttpOnly cookie, CSRF, süre ve logout; oturum yarışları ve aktif indirme erişim iptali testli |
| D01 | Dosya yükleme | Kod mevcut / yerel manuel kabul | İmzalı upload/finalize, gerçek bayt/kota ve R2 provider testleri başarılı; kullanıcı bir PDF yüklemeyi doğruladı. Canlı origin kabulü bekliyor |
| D02 | Dosya indirme | Kod mevcut | Private dosya/Range, gerçek bayt eşleşmesi ve bağlantı iptali testleri |
| D03 | Dosya görüntüleme/önizleme | Kısmi / PDF yerel kabul | Raster görseller ve PDF.js canvas var; kullanıcı bir gerçek PDF önizlemesini doğruladı. Diğer türler indirilir; tüm cihaz/tür kabulü tamamlanmadı |
| D04 | Dosya listeleme | Kod mevcut | Workspace/folder kapsamlı liste, sayfalama, arama/filtre/sıralama; API/adapter testleri |
| D05 | Dosya bilgileri ve ilgili klasörünü gösterme | Kod mevcut — browser kabulü bekliyor | Ayrıntı paneli gerçek üst klasör yolunu/kökü gösterir, Klasöre git ile konuma götürür; arama/son kullanılanlardan bağımsız parentId çözümü ve geç kalan yanıt koruması testli |
| K01 | Klasör oluşturma | Kod mevcut | `POST /folders`, UI klasör formu |
| K02 | Klasör listeleme | Kod mevcut | Parent/type kapsamlı sayfalama ve klasör görünümü |
| K03 | Klasör içinde klasör | Kod mevcut | `parentId`, aynı tenant/aktif parent ve derinlik kontrolleri |
| K04 | Klasör ağacını yönetme | Kod mevcut | Parent ilişkisi, gezinme, ad değiştirme, taşıma, döngü engeli ve alt ağacı silme. Ayrı bir sürekli açık ağaç sidebar'ı PDF'de açıkça zorunlu tutulmuyor |
| K05 | Klasör yükleme | Kod mevcut — browser kabulü bekliyor | Directory seçici ve drop entry okuyucusu, alt klasörler ve dosyalar; göreli yol doğrulama,10000 öğe/64 seviye/25 MiB dosya sınırı. Boş klasörler entry destekli sürükleme ile korunur; standart directory FileList boş dizinleri bildirmez. Her adım mevcut yetkili API üzerinden çalışır |
| K06 | Klasör indirme | Kod mevcut | Sync ZIP + asenkron ZIP job/ilerleme/iptal. İç içe baytlar testli;22 Ekim iptal-sonrası-slot regresyonu geçti. Büyük Blob için hedef cihaz kabulü bekliyor |
| K07 | Klasörler arasında gezinme | Kod mevcut | Folder query, breadcrumb ve üst yol çözümü; API'de ancestor kontrolü |
| K08 | PDF'deki çok katmanlı örnek ağaç | Kod mevcut — browser kabulü bekliyor | Hiyerarşik upload ve elle oluşturma mevcut; gerçek API testinde nested dosya baytları ve boş klasör doğrulandı. Örnek ağacın tarayıcı kabulü bekliyor |

Klasör upload kabul ölçütü: yerel kök klasör, alt dizinler ve dosyalar hedef workspace altında aynı hiyerarşiyle oluşmalı; göreli yollar doğrulanmalı, her klasör/dosya işlemi API rol ve tenant kontrollerinden geçmeli. Boş klasörlerin korunması desteklenen tarayıcı mekanizmasına göre ayrıca ele alınmalı. Çoklu dosya seçimi bu isterin yerine geçmez.

Dosya konumu kabul ölçütü: ayrıntılarda kök veya gerçek üst klasör yolu gösterilmeli; arama/son kullanılanlardan bulunan dosyada da çalışmalı. Kullanıcı klasöre gidebilmeli; yol çözümlenirken başka workspace/hesaba ait gecikmiş sonuç gösterilmemeli.

## Teslim ve planlama — PDF sayfa 3–4

| ID | İster | Durum | Kanıt / kalan iş |
| --- | --- | --- | --- |
| L01 | İki repository'yi ayrı oluşturma | Tamamlandı | T01 ile aynı; bağımsız geçmiş/remote ve private görünürlük doğrulandı |
| L02 | İkisinde anlaşılır README | Kod mevcut / ilk CI geçti | Bağımsız kurulum, kardeş repo bağlantıları ve ayrı CI/Docker bağlamları güncellendi; ilk uzak kontroller başarılı |
| L03 | Güncel ve kararlı paketler | Kısmi / güvenlik takibi açık | Nuxt 4.6.2 güncellemesi sonrası 0 moderate/2 high frontend audit bulgusu var. İki upstream high için yama bildirilmedi; runtime sınırı derlemede denetlenir. Backend audit 0; [güvenlik kaydı](bagimlilik-guvenlik-durumu.md) |
| L04 | API ve frontend deploy | Eksik | Paketleme/compose hazırlığı var; çalışan canlı ortam ve HTTPS doğrulaması yok |
| L05 | Çalışan deployment + repository linklerini teslim | Kısmi | İki private repo bağlantısı hazır; API ve frontend canlı deployment adresleri henüz yok. Localhost yayın kabulü değildir |
| L06 | Kayıt, giriş, Google, upload/download, görüntüleme ve ağaç için uçtan uca test | Kısmi | API/MongoDB ve adapter entegrasyonları; kullanıcı Google/PDF/davet/rol kabulü mevcut. Otomatik Playwright/axe, kalan ağaç/mobil/klavye kabulü çalıştırılmadı |
| M01 | Önce kullanıcı/dosya/klasör ilişkileri ve ağaç tasarımı | Belge mevcut | [Mimari](google-drive-multi-tenant-mimari.md), `Workspace/Membership/DriveNode.parentId`; tasarım belgesi var. Geçmiş çalışma sırası bu tur yeniden ispatlanmadı |
| M02 | Saklama yeri ve metadata tasarımı | Belge/kod mevcut | MongoDB metadata, private object key ve staging/sealed yaşam döngüsü |
| M03 | Veri modeli ve API sözleşmesi | Belge/kod mevcut | Modeller ve API sözleşmesi var; klasör upload mevcut create-folder/upload/finalize çağrılarını bileştirir. Konum için scoped getNode kullanılır; yeni yetkisiz endpoint eklenmedi |
| M04 | Bucket servisi kullanma | Gerçek R2 ve yerel PDF kabulü — canlı origin bekliyor | Private R2 PUT/GET/Range/finalize/ZIP/temizlik ve CORS testleri geçti. Kullanıcı PDF yükleme/önizleme/indirmeyi doğruladı; yayın origin kabulü bekliyor |

## Ders ve kaynaklar — PDF sayfa 3–4

Not dosyası hazırlamamız, Ahmet'in bütün dersleri izleyip kavramları öğrendiğini tek başına kanıtlamaz. Kaynakların tamamlanma durumu kişisel çalışma günlüğüyle izlenmeli; izlenmeyen/okunmayan kaynaklar mentor raporunda tamamlandı diye yazılmamalı.

| Kaynak/ister | Eldeki çıktı | Eksik doğrulama |
| --- | --- | --- |
| Express: Make a Blog with Node.js, Express & MongoDB | Ders01, repo incelemesi ve çalışma rehberi | Bütün derslerin kişisel notlarla tamamlanması doğrulanmadı |
| Advanced Node.js | Kaynak/sıra ve stream/event loop notları | Bölüm bazında çalışma/tamamlama kaydı yok |
| Node.js Security Best Practices | Kaynak ve auth/authz/oturum notları | Playlist'in tamamının çalışıldığı doğrulanmadı |
| MongoDB playlist | Mentor raporu ve defter notları | Hazır özetler bütün videoların izlenmesine eşit değil |
| Mongoose kaynağı | Schema/model/query notları | Kaynağın tümünün not alarak izlendiği doğrulanmadı |
| MongoDB ek playlist | Kaynak rehberde korunmuş | Kavram notlarının kaynak bazında tamamlanması doğrulanmadı; PDF bu kaynaktaki uygulamayı yapmayı zorunlu tutmuyor |
| Data Modeling dokümantasyonunun tüm bölümleri | Temel modelleme notları ve günlük şablonu | Tüm bölüm ağacını kapsayan doldurulmuş not/okuma envanteri yok; eksiksiz çalışıldı denemez |
| Kavramları kendi cümleleriyle deftere geçirmek | [Defter notları](defter-notlari-mongodb-backend.md), [çalışma rehberi](calisma-rehberi.md) | Kullanıcının fiziksel defterini veya öğrenme/tamamlama durumunu bu araçlarla doğrulayamam |
| Eski kaynakların zihniyetini güncel sürümlerle uygulamak | Modern ayrı Nuxt/Express/Mongoose paketleri, modelleme ve güvenlik kararları | Ders/okuma kabulü ile bağımlılık bakımının ayrıca tamamlanması gerekir |

## Öncelikli devam sırası

1. **Klasör upload** ve **dosyanın klasör konumu** kodları ve API/adapter kontrolleri tamamlandı. Yazılan browser senaryosunu izin verilen ortamda çalıştır; directory seçme/drop ve boş klasör desteğini hedef browserlarda kabul et.
2. Tamamlandı: iki bağımsız private repository, ayrı README/CI ve ilk uzak Docker kontrolleri. Sonraki değişikliklerde bağımsız CI sonuçlarını izlemeyi sürdür.
3. [Canlı kurulum listesindeki](canli-kurulum-gerekenler.md) hesaplarla bucket, Google OAuth, SMTP, MongoDB, API/frontend deployment ve HTTPS akışlarını tamamla.
4. Gerçek browser/mobil/klavye/preview/Google/ağaç kabulü; bağımlılık taraması; çalışan dört teslim bağlantısı.
5. Dersler ve Data Modeling'in bütün bölümleri için gerçek kişisel çalışma kayıtlarını tamamla.

Kapsamı genişletmeyelim: PDF yalnız dosya düzenlemeyi açıkça dışarıda tutuyor; çöp kutusu, public link ve Office renderer'ını isimle zorunlu saymıyor. Bunları varsayımsal eksik diye eklemiyorum. Önizlemenin hangi dosya türlerini kapsadığını ise teslim kabulünde açıkça belirtmek gerekiyor.
