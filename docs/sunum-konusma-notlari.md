# Yiğit abiye sunum — kısa konuşma notları

Bu metin uzun [teknik rehberin](teknik-sunum-rehberi.md) yanında açık tutulabilecek konuşma sırasıdır. Kod örneklerini kendi ekranında aç; belirtilen testleri son Actions kaydıyla göster.

## 1. Açılış — problem ve çözüm

“Proje, birden fazla çalışma alanında dosya paylaşımı sağlıyor. Kullanıcı her alanda farklı role sahip olabiliyor. Owner yönetimi yapıyor, Editor içeriklerle çalışıyor, Viewer okuyup indiriyor. Dosya içeriği düzenleme kapsam dışında; dosya ve klasörün adı, konumu ve yaşam döngüsü yönetiliyor.”

Canlı uygulamayı ve iki ayrı repoyu göster. Frontend'in Cloudflare Pages'te, API ve MongoDB'nin Northflank'ta, dosyaların R2'de olduğunu söyle.

## 2. Mimariyi göster

“Arayüz API'yi aynı origin `/api/v1` üzerinden çağırıyor. Pages Function, cookie ve CSRF bilgisini sabit backend'e aktarıyor. API ayrıca gateway kimliğini, kullanıcı session'ını, güncel üyeliği ve kaynağın alanını kontrol ediyor. Metadata MongoDB'de, dosyanın gerçek baytları private R2'de.”

İmzalı PUT'un tarayıcıdan doğrudan R2'ye gidebildiğini ekle. Gateway ve R2 upload yetkisi ile kullanıcı rolünün farklı kontroller olduğunu vurgula.

## 3. Veri modeli ve tenant sınırı

`models.mjs` ve `tenant.mjs` aç:

“Rolü User'a koymadım; User ile Workspace arasındaki Membership üzerinde tuttum. Böylece bir kişi bir alanda Owner, diğerinde Viewer olabiliyor. Dosya ve klasör DriveNode; kind ve parentId ile ayrılıyor. Her kaynak workspaceId ile kapsamlanıyor. Yalnız kimliği bilmek erişim vermiyor.”

“Yazma transaction'ında Workspace belgesine dokunup üyeliği yeniden okuyoruz. Eşzamanlı rol kaldırma olduğunda eski yetkiyle yazmanın tamamlanmasını önlüyoruz. Bu, alan başına yazma çekişmesi maliyeti olan bir tutarlılık tercihi.”

## 4. Giriş ve Google

`auth.mjs` aç:

“Parolalar scrypt ve rastgele salt ile hash'leniyor. Oturum JWT değil: tarayıcıda HttpOnly/Secure cookie, DB'de rastgele session tokenının hash'i var. Yazmalar session'a bağlı CSRF ve Origin kontrolünden geçiyor. Reset eski session'ları geçersiz kılıyor.”

“Google'da Authorization Code, PKCE, state ve nonce kullanılıyor. jose ile Google ID tokenı doğrulanıyor. E-posta aynı diye hesaplar kendiliğinden birleştirilmiyor.”

“Davet tokenı Google'a giderken kaybolmasın diye session/state'e bağlı şifreli geçici OAuth bağlamında tutuluyor. Dönüşte davet ekranı açılıyor, kullanıcı ayrıca kabul ediyor.”

## 5. Dosya ve klasör demosu

Kişisel veri içermeyen küçük bir örnek ağaç seç:

```text
Sunum/
  not.txt
  2026/
    görseller/
      logo.png
```

“Klasör seçicinin göreli yollarından sığdan derine aktarım planı çıkarılıyor. Klasörler oluşturuluyor; dosyalar kendi parent kimliklerine normal yetkili upload API'siyle gidiyor.”

PDF/görsel aç, bir alt dosyayı ara, ayrıntıdaki gerçek konuma git ve ZIP indir. Yalnız listede görünmesini değil, ZIP içindeki hiyerarşiyi göster.

## 6. Upload güvenliği

`files.mjs` içindeki upload/complete ve `storage.mjs` içindeki promoteUpload'u aç:

“Upload başlarken izin ve kota kontrol ediliyor, boyut rezerve ediliyor. İmzalı PUT geçici staging nesnesine yazıyor. Complete boyut/tür metadata'sını denetleyip ayrı sealed anahtara geçiriyor. Finalize'da güncel yetki ve parent tekrar kontrol ediliyor. Böylece eski PUT URL'si tamamlanmış dosyanın baytlarını değiştirmiyor.”

“R2 ile DB tek transaction değil; yarım işlerin yaşam döngüsü ve temizlik kuyruğu var. İçerik kontrolünü antivirüs taraması diye sunmuyorum.”

## 7. Rol farkını göster

Kendi kontrolündeki ikinci hesap veya açıkça etiketlenmiş demo kullan:

- Viewer: dosyayı görür/indirir, yazma düğmeleri yoktur; doğrudan API yazması da reddedilir.
- Editor: içerik yönetir, üye/rol/alan ayarlarını yönetemez.
- Owner: üye/davet/rol ve geçmişe erişir; son Owner koruması vardır.

“Uzun indirme sırasında da üyelik yeniden kontrol ediliyor; üyelik kaldırılırsa akış kesiliyor. Daha önce gönderilmiş baytlar geri alınamaz.”

## 8. Kuyruk ve frontend durumu

“Maili request içinde göndermek yerine DB işlemiyle şifreli outbox kaydediyoruz. Worker geçerli mesajı SMTP'ye yollar ve hatada yeniden dener. Arşiv ve fiziksel silme de job üzerinden çalışır. Yavaş SMTP dosya işlerini durdurmaz.”

“Frontend'de useDrive ortak session/alan durumunu, HTTP adaptörü cookie/CSRF ve API sözleşmesini yönetiyor. Hesap/alan değişince eski cevapların yeni ekrana yazılmaması için generation sayaçları ve iptal kullanılıyor.”

## 9. Testleri göster

Actions'ta başarılı son commit'i aç:

“Frontend'in 100 birim testi var; 12'si son sertifika yamasının gerçek HTTP/TLS testleri. Ortak CI iki API adapter entegrasyonunu ve 12 Chromium masaüstü/mobil senaryosunu çalıştırıyor. Backend ayrı gerçek MongoDB testleri ve Docker/audit kontrolü içeriyor. CI maili Mailpit'e gidiyor; canlı veriye bağlanmıyor.”

“Google sağlayıcısı ve gerçek R2/telefon akışları manuel kabul edildi; axe veya test sayısı her cihazda kusursuzluk garantisi değildir.”

## 10. Güvenlik düzeltmesi ve kapanış

“Node-forge'un resmî sürümü henüz yamalı olmadığı için uyarıyı bastırmadık. Listhen'in kullanılmayan otomatik geliştirme sertifikası üretimini kaldırdık; hazır PEM/PFX için native Node TLS kullanıyoruz. Paket bağımlılık ağacından çıktı, audit istisnası kaldırıldı ve tüm bağımlılık taraması 0 bildirim verdi. Canlı HTTPS platformlarda devam ediyor. Exact-version patch yükseltmelerde bakım gerektiriyor.”

“Dosya 25 MiB, alan 5 GiB, yol 64 seviye. Office içerik düzenleme/renderer yok. Ücretsiz yayın tek instance; HA/SLA iddiası yok. Haftalık DB snapshot ve manuel şifreli R2 yedeği var; otomatik ikinci R2 konumu ve ortak zamana kurtarma ayrı operasyon işleri.”

Sorularda ezber cevap yerine ilgili dosyayı aç. Ayrıntılı tablo, akışlar ve soru-cevaplar [teknik rehberde](teknik-sunum-rehberi.md).
