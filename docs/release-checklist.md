# Teslim kontrolü

Kontrol tarihi: **24 Ekim 2026**. Canlı adresler ve yeniden kurulum adımları [README](../README.md) içindedir.

| İster | Uygulama ve doğrulama |
| --- | --- |
| Ayrı frontend/backend depoları ve yayınları | İki private GitHub deposu, Cloudflare Pages frontend, Northflank API |
| Multi-tenant çalışma alanları | Üyeliğe bağlı roller, güncel yetki/aktif kaynak kontrolü, transaction ve doğrudan yabancı ID testleri |
| Owner / Editor / Viewer | API izin matrisi, son Owner koruması, canlı iki hesapla rol/üye çıkarma kabulü |
| E-posta/parola ve Google girişi | API auth testleri; Google ve davet dönüşü canlı manuel kabulü |
| E-posta daveti | Kayıtsız alıcı, Editor/Viewer seçimi, doğrulanmış e-posta ile açık kabul; SMTP/outbox testleri |
| Dosya yükleme/indirme/önizleme/konum | Gerçek bayt testleri ve canlı PDF kabulü; konumdan klasöre gitme doğrulandı |
| İç içe klasör ve ZIP | API alt ağaç testleri; canlı Word dosyaları ve resimler alt klasörü yükleme/ZIP kabulü |
| Mobil ve klavye | Canlı mobil ağ ve temel klavye kabulü; frontend Playwright/axe CI senaryoları |
| Kurulum ve teslim belgeleri | İki güncel README, ortam örnekleri, API/yayın/operasyon rehberleri |

Backend CI gerçek MongoDB, testler, deployment şablonu, güvenlik taraması ve Docker derlemesini çalıştırır. Frontend CI tarayıcı işi bağımsız runner'da backend'in `main` sürümünü kullanır ve test edilen SHA'yı loglar. Sonuç kanıtı için [backend Actions](https://github.com/ahmetkocdeveci/google-drive-clone-backend/actions/workflows/ci.yml) ve [frontend Actions](https://github.com/ahmetkocdeveci/google-drive-clone-frontend/actions/workflows/ci.yml) incelenmelidir; kaynak dosyanın bulunması testi geçmiş sayılmaz.

## Kapsam sınırları

- Dosya içeriği düzenleme kapsam dışıdır; PDF/raster önizlemesi vardır, Office dosyaları indirilir.
- Ücretsiz kaynak kotaları, dosya/alan/ZIP sınırları README'de belirtilmiştir.
- Haftalık MongoDB snapshot ve manuel şifreli R2 yedeği vardır. Otomatik R2 ikinci konum kopyası, ortak zamana tam kurtarma ve gerçek alarm teslimi ayrıca operasyon işidir.
- Frontend'in node-forge bağımlılığı kullanılmayan sertifika üretimi kaldırılarak ağacından çıkarılmıştır; tüm audit temizdir, istisna yoktur. Exact-version listener yaması ve native TLS testleri frontend güvenlik kaydında belgelenmiştir.
- Repo davetleri ve kişisel ders/not teslimi depo sahibi tarafından tamamlanır; bu belge onlar adına tamamlandı iddiası içermez.
