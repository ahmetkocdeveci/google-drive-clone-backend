# Frontend — backend API sözleşmesi

Bu sözleşme kardeş `google-drive-clone-backend` projesinde uygulanır. Eski referans starter API bu sözleşmeye dönüştürülmedi.

## Genel

- Prefix `/api/v1`. DTO tipleri `shared/types.ts`; adapter `app/services/http-drive-api.ts`.
- Başarı yanıtları doğrudan DTO veya DTO dizisidir; `{data:...}` wrapper beklenmez. Session yanıtı `{user:{id,name,email,emailVerified}}` olur.
- Arayüz listeleri `/page` endpointlerini kullanır: `{items:T[],nextCursor:string|null}`. Query `limit` (1–100) ve isteğe bağlı opak `cursor` içerir. Sonraki sayfa aynı kullanıcı/workspace/sorgu/sıralamayla istenir. Tenant içi listelerde veri veya yetki sürümü değiştiğinde409 döner; kullanıcı listeyi ilk sayfadan yeniler. Workspace dizini canlı keyset listesidir ve her sayfada aktif üyelikleri yeniden süzer. Eski dizi endpointleri uyumluluk için korunur; arayüz bunlara bağlı değildir.
- Hata: `{error:{code,message,requestId?}}`, uygun HTTP 400/401/403/404/409/429/5xx.
- API istekleri `credentials:include`, `cache:no-store` kullanır. Backend güvenli cookie session'ı oluşturur; frontend bearer/refresh token saklamaz.
- `GET /auth/csrf-token` → `{csrfToken:string}`; anonim cookie session da oluşturabilir. Login/register dahil durum değiştiren istekler `X-CSRF-Token` ve izinli Origin gönderir; token mevcut oturuma bağlıdır. Açık `CSRF_INVALID` yanıtında adapter tokenı yenileyip yalnız bir kez tekrar dener.
- `AbortSignal` route/liste değişiminde iptal desteği sağlar. İstemci iptali backend'de commit edilmiş yazmayı geri almaz.

## Identity

| İşlem | İstek | Yanıt |
| --- | --- | --- |
| Oturum | GET `/auth/me` | Session; 401 anonim session |
| Giriş sağlayıcıları | GET `/auth/providers` | `{google:boolean}`; gizli yapılandırma değerleri dönmez |
| Hesabın giriş yöntemleri | GET `/auth/identities` | `{google:boolean,hasPassword:boolean}`; doğrulanmış oturum |
| Giriş | POST `/auth/login` `{email,password}` | Session |
| Kayıt | POST `/auth/register` `{name,email,password}` | Session, emailVerified=false |
| Doğrula | POST `/auth/email-verification/confirm` `{token}` | Güncel Session |
| Bağlantıyı yenile | POST `/auth/email-verification/resend` | 204; kullanıcı başına60sn, eski tokenlar iptal |
| Çıkış | POST `/auth/logout` | 204 |
| Google | GET `/auth/google/start?returnTo=/...` | Backend OAuth redirect |
| Google ve bekleyen davet | POST `/auth/google/start` `{returnTo?:string,invitationToken?:string}` | `{authorizationUrl:string}`; CSRF ve Origin zorunlu |
| Google hesabını bağla | POST `/auth/google/link/start` `{password?:string}` | `{authorizationUrl:string}`; doğrulanmış oturum, şifreli hesap için mevcut şifre |
| Şifre yenileme iste | POST `/auth/password-reset/request` `{email}` | Her adres için genel202; boş body olabilir |
| Şifreyi yenile | POST `/auth/password-reset/confirm` `{token,password}` | 204; token tüketilir ve hesabın tüm oturumları kapatılır |
| Davet özeti | POST `/invitations/inspect` `{token}` | InvitationPreview |
| Davet kabul | POST `/invitations/accept` `{token}` | Workspace |

OAuth state/nonce/PKCE, ID token doğrulama, hesap eşleştirme ve returnTo allowlist backend sorumluluğudur. Davet/verification tokenları query yerine fragment kullanır; GET ile tüketilmez. Frontend Google girişini POST ile başlatır. `invitationToken` yalnız tam `/invitations/accept` dönüş yolu için kabul edilir; GET query'sinde reddedilir. Token Google yetkilendirme URL'sine veya tarayıcı depolamasına eklenmez. Backend tokenı 10 dakikalık OAuthAttempt içinde AES-256-GCM ile şifreler; şifreli bağlam session ve state'e bağlıdır. Geçerli callback kaydı tek sefer tüketir ve bağlamı siler. Başarı `/invitations/accept#token=...` ile döner; kabul ayrıca eşleşen doğrulanmış e-posta ve kullanıcının açık onayını ister. İptal/sağlayıcı hatasında aynı oturum için `/login?authError=...&returnTo=/invitations/accept#invitationToken=...` kullanılır. Login fragmenti belleğe alıp URL'den kaldırır; yeniden deneme daveti korur. Başka oturum, tekrar callback, değiştirilmiş veya süresi geçmiş kayıt tokenı geri döndürmez.

Google düğmesi önce sağlayıcı durumunu sorgular. Google yapılandırılmamışsa kullanıcı giriş sayfasında kalır ve e-posta ile giriş seçeneği açıklanır. Başlatma sırasında oturum veya bekleyen davet değişirse geciken sonuçla yönlendirme yapılmaz; hedef yalnız `https://accounts.google.com/o/oauth2/v2/auth` olabilir.

OAuth callback başarısızlıkları backend tarafından `/login?authError=...` sayfasına yönlendirilir. Frontend yalnız `google_cancelled`, `google_failed`, `google_account_link_required`, `google_state_invalid`, `google_unavailable` kodları için sabit mesaj gösterir. Sağlayıcı hata metni veya rastgele query içeriği gösterilmez; işlenen kod URL'den kaldırılırken `returnTo` korunur.

Google bağlama hesap güvenliği ekranından açıkça başlatılır. Yetkilendirme URL'si yalnız `https://accounts.google.com` için kabul edilir; aynı e-posta adresi otomatik birleştirme yapmaz. Başarı `/account?linked=google` ile döner; ekran ayrıca güncel `identities.google` değerini doğrular.

Şifre yenileme bağlantısı `/reset-password#token=...` biçimindedir. Token URL'den kaldırılıp yalnız bellekte tutulur; şifre veya token tarayıcı depolamasına yazılmaz. GET token tüketmez. Kullanıcı yeni şifreyi açıkça gönderir. Başarıdan sonra frontend kimlik ve tenant durumunu temizler, yeni şifreyle giriş ekranını açar; bekleyen davet bağlantısı yalnız bellekte korunabilir.

Şifre yenileme şifreli hesaplar içindir. Yalnız Google ile oluşturulmuş hesaplara ilk şifre belirleme bu sürümde sunulmaz; hesap güvenliği ekranı bu durum için yenileme düğmesi göstermez. Başarılı reset e-posta sahipliğini de doğrular.

## Workspace ve üyeler

`GET /workspaces/page?limit=50&cursor=...` →Page<Workspace>. `POST /workspaces`, `GET/PATCH/DELETE /workspaces/:wid` Workspace döndürür; silme 204. Workspace DTO güncel `role`/`capabilities`, toplam `memberCount` ve `ownerCount` içerir. Oluştururken role gönderilmez; backend Owner üyeliği oluşturur.

`GET .../members/page?limit=100&cursor=...` →Page<Member>. `PATCH .../members/:mid/role` `{role}` → Member; `DELETE .../members/:mid` →204. `POST .../ownership-transfer` `{memberId}` → güncel Workspace. Son Owner ve eşzamanlı değişiklikler backend transaction'ıyla korunur; UI son Owner kontrolünü yalnız yüklenen sayfalardan türetmez.

`GET .../invitations/page?limit=100&cursor=...` →Page<Invitation> (token yok). Arayüz bekleyen ve geçmiş davetleri gösterir; yalnız bekleyen davetler iptal edilebilir. `POST .../invitations` `{email,role:editor|viewer}` → Invitation. `DELETE .../invitations/:iid` →204. `demoToken` yalnız demo adapter'ın oluşturma yanıtında bulunur; gerçek API tokenı listeye vermez.

`GET /workspaces/:wid/audit-events?limit=50&cursor=...` →Page<AuditEvent>. Yalnız güncel Owner ve `audit:read` izni; Editor/Viewer403, üye olmayan404 alır. Aynı yolun `/page` takma adı da vardır. En yeni işlemden başlanır; tarih eşitliğinde ID ile kararlı sıralama yapılır. Cursor kullanıcı/tenant/sayfa boyutu/veri ve yetki sürümüne bağlıdır. DTO `{id,workspaceId,action,targetId?,actor:{id,name},createdAt}`; e-posta, token, istek gövdesi ve dahili requestId dönmez. Actor silinmişse güvenli yedek ad gösterilir. `/workspaces/:wid/activity` sayfasında yükleme/boş/hata/yenileme ve daha eski işlemleri yükleme vardır; role/hesap/tenant değişiminde eski kayıtlar temizlenir.

## İçerik

`GET /workspaces/:wid/nodes/page` →Page<DriveNode>. Query: kök için `parentId=root`, diğerlerinde folder ID; `search`, `type`, `sort`, `direction`, `recent`, `limit`, `cursor`. Arama ve son kullanılanlar aynı workspace ağacını kapsar. Dosya listesi ve taşıma penceresi sonraki sayfaları kullanıcı talebiyle yükler; 500 öğede sessiz kırpma yapılmaz. `GET .../nodes/:nid` →DriveNode. `POST .../folders` `{name,parentId:null|id}` →DriveNode.

`PATCH .../nodes/:nid` `{name?,parentId?,version?}` →DriveNode; eski version için409 beklenir. `DELETE .../nodes/:nid` →204. Çoklu silme adapter'da sırayla yapılır; hata önceki silmeleri geri almaz. Ekran hatadan sonra listeyi yeniler.

Yükleme:

1. `POST .../files/uploads` `{name,parentId,mimeType,size}` → `{uploadId,uploadUrl,headers?}`.
2. Verilen **http(s) signed URL** adresine raw File PUT; cookie/CSRF taşınmaz, referrer gönderilmez. Backend storage adreslerini güvenli sağlayıcı allowlist'inden üretmelidir.
3. `POST .../files/uploads/:uploadId/complete` →DriveNode. Backend boyut/tür, workspace, güncel rol ve upload sahipliğini doğrular.

İlerleme tamamlanan dosyaların toplam baytına göredir; fetch anlık gönderilen bayt ilerlemesini sağlamaz.

`GET .../files/:fid/content` →Blob + Content-Type + Content-Disposition. Preview/download aynı guarded API'den alınır. Güvenli image türleri ve yetkili API blob'unu çizen PDF.js canvas önizlemesi desteklenir; HTML/SVG aktif içerik olarak render edilmez.

Dosya/Range, doğrudan ZIP ve hazır async ZIP aktarımı boyunca oturum, hesap, üyelik, kaynak ve aktif üst klasörler tekrar denetlenir. Kontrol aralığı250 ms; bir kontrolün toplam bekleme sınırı1 saniyedir. Erişim kaybı veya kontrol hatasında sunucu bağlantıyı ve storage akışını kapatır. Bu sınırlar ağ gecikmesi ve daha önce gönderilmiş istemci tamponlarını geri almaz. HEAD gövde/izleme açmaz. Aynı süreçte en fazla32 açık akış ve kullanıcı başına4 akış izlenir; dolulukta503 `STREAM_BUSY` döner.

Klasör ZIP'i arka plan işiyle hazırlanır:

1. `POST /workspaces/:wid/archives` `{nodeId}` →202 ArchiveJob.
2. `GET .../archives/:id` →ArchiveJob; `pending|running|ready|failed|cancelled|expired` durumları, `processedFiles`, isteğe bağlı `totalFiles`, `bytes`, `filename`, `expiresAt`, `errorCode` içerir.
3. `GET .../archives/:id/content` yalnız hazır arşiv için private içerik döndürür; auth/membership/permission/tenant sınırı yeniden kontrol edilir.
4. `DELETE .../archives/:id` →204; başlatanın işini iptal eder.

HTTP adapter hazırlamayı varsayılan 1,5 saniye aralıkla en fazla 10 dakika bekler; süre ve aralık test/uygulama seçenekleriyle sınırlı aralıkta değişebilir. İptal, zaman aşımı veya başarısız takipte tamamlanmamış iş için en iyi çabayla DELETE gönderilir. Hazır arşiv indirilirken iş körlemesine silinmez. UI ilerleme, iptal, yeniden deneme ve durum kartını kapatma sağlar. Sayfa kapanınca istekler iptal edilir. Sunucu boyut/öğe/kota ve TTL sınırları ayrıca geçerlidir; istemci iptali sunucu temizliğinin tek mekanizması değildir.

Arşivin tamamı Blob olarak alındıktan sonra istemci bağımsız5 saniyelik süreyle DELETE göndererek geçici arşiv kotasını serbest bırakır. Temizlik başarısız olsa da alınan dosya kullanıcıya teslim edilir; sunucu TTL temizliği yedektir.


## Klasör upload ve dosya konumu — 22 Ekim

Klasör yükleme yeni bir toplu yetki endpoint'i açmaz. İstemci göreli yolları doğrular; seçili hedef parent altında üstten alta `POST /workspaces/:wid/folders` ile dizinleri kurar ve her dosyayı elde edilen parentId ile mevcut upload → PUT → complete akışına yollar. Her istek güncel workspace/rol kontrolünden geçer. Sınırlar:10000 toplam öğe, hedef dahil64 seviye, dosya başına25 MiB; workspace kotası API'dedir. Aynı import içindeki dosya/klasör yol çakışmaları reddedilir. Var olan ada otomatik birleşme yoktur. İşlem atomik değildir: hata/iptalde tamamlanan öğeler görünür kalır, istenirse UI'dan silinir; sonraki seçim yeni kök oluşturur.

Directory seçici `webkitRelativePath` kullanır; boş dizinleri tarayıcının FileList'i sunmaz. Entry destekli drop, `readEntries` batch'lerinin tamamını okuyarak boş dizinleri de korur. Destek hedef tarayıcıda kabul edilmelidir.

Dosya ayrıntısındaki konum, dosyanın parentId'sinden mevcut scoped `GET /nodes/:id` çağrılarıyla çözülür. Kök ve gerçek yol gösterilir, Klasöre git ilgili folder query'sine yönlendirir. Kapanış/hesap/tenant değişiminde eski yol sonucu yayınlanmaz.
