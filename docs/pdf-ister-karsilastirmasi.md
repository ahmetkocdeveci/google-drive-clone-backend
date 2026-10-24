# Uygulama isterleri ve karşılıkları

Son karşılaştırma: **24 Ekim 2026**, dört sayfalık proje isterleri. Kişisel ders/not çalışması bu teknik kabulden ayrıdır.

| İster grubu | Uygulama | Doğrulama |
| --- | --- | --- |
| Ayrı isimli iki repo, Nuxt ve bağımsız yayın | `google-drive-clone-frontend`, `google-drive-clone-backend`; Pages / Northflank | Private repo ve canlı HTTPS adresleri README'de |
| Çoklu workspace ve otomatik Owner | Workspace/Membership; oluşturma transaction'ı | Gerçek DB/API testleri ve canlı alan ayrımı |
| Owner / Editor / Viewer | Üyeliğe bağlı izin matrisi ve son Owner koruması | Doğrudan API rol/tenant testleri ve canlı iki hesap kabulü |
| E-posta ile kayıt/giriş, Google, çıkış | Scrypt, cookie oturumu, doğrulama ve OAuth | Kontrollü auth testleri, tarayıcı senaryoları, gerçek Google manuel kabulü |
| Kayıtsız kullanıcıya davet, Editor/Viewer seçimi | Alan kapsamlı Invitation ve SMTP outbox | Eşleşen doğrulanmış e-posta ile açık kabul, iptal/replay/yetki testleri |
| Dosya upload/download/preview/list/info/parent | Staging/sealed nesneler; özel stream; frontend PDF/raster ve parent yolu | Gerçek bayt/Range testleri, canlı PDF ve konuma gitme |
| Klasör oluşturma/listeleme/iç içe ağaç/yönetim | Parent ilişkisi, döngü/derinlik kontrolü, metadata CRUD | API testleri ve canlı alt klasör/taşıma kabulü |
| Klasör upload/download/gezinme | Directory picker/drop, async ZIP, breadcrumb | Gerçek iç içe bayt testleri, tarayıcı senaryosu ve canlı ZIP kabulü |
| Güncel paketler ve README | Sabit sürüm/lockfile, bağımsız kurulum ve yayın rehberleri | CI ve görünür bağımlılık bakım kaydı |
| Temel uçtan uca senaryolar | Gerçek API/MongoDB/Mailpit ile frontend CI browser işi | Actions raporu; canlı Google ve telefon kabulü ayrıca manuel |
| Dört teslim bağlantısı | İki repo, frontend ve API | README bağlantı tablosu |

Dosya **içeriği** düzenleme kapsam dışıdır; ad/konum düzenleme desteklenir. Üç seviyeli ağaç parent ilişkisiyle yönetilir; sürekli açık ağaç sidebar'ı zorunlu kabul edilmemiştir. HTML/SVG çalıştırılmaz. Boş klasörlerin aktarımı tarayıcı entry API desteğine bağlıdır; directory FileList boş dizinleri bildirmez. Büyük ZIP'in bütün cihazlarda kapasite garantisi verilmez.

Güncel test/yayın kanıtları ve operasyon sınırları: [teslim kontrolü](release-checklist.md). Repo davetleri ve derslerin kişisel tamamlama kaydı depo sahibine bırakılmıştır.
