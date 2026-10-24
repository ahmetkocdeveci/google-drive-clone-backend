# Kaynak teslimi

24 Ekim 2026: Proje iki bağımsız private GitHub deposunda, üretim dalı `main` olacak şekilde tutulur:

- [Backend](https://github.com/ahmetkocdeveci/google-drive-clone-backend)
- [Frontend](https://github.com/ahmetkocdeveci/google-drive-clone-frontend)

Her deponun README'si canlı bağlantıları, bağımsız kurulumu, ayar örneklerini, test komutlarını ve sınırları içerir. `.env`, `.data`, credential dosyaları ve üretilmiş çıktılar kaynak teslimine dahil edilmez.

Backend CI: izole MongoDB/Mailpit, sözdizimi, deployment şablonu, gerçek DB/API testleri, audit ve Docker. Frontend CI: biçim, birim/tip, Node/Pages/Docker, runtime sınırı ve gerçek API ile tarayıcı senaryoları. Action sürümleri doğrulanmış commitlere sabitlenmiştir.

Frontend CI'ın özel backend'i okuyabilmesi için backend'de salt okunur deploy key, frontend'de `E2E_BACKEND_SSH_KEY` Actions secret'ı kullanılır. Bu anahtar repo yazma veya insan hesabı erişimi sağlamaz. Fork PR'larında browser işi çalıştırılmaz. Backend değişikliklerinden sonra frontend browser işi Actions üzerinden elle yeniden tetiklenebilir.

Son sonuçlar: [Backend checks](https://github.com/ahmetkocdeveci/google-drive-clone-backend/actions/workflows/ci.yml), [Frontend checks](https://github.com/ahmetkocdeveci/google-drive-clone-frontend/actions/workflows/ci.yml). Repo sahibinin değerlendirecek kişiye erişim davetini ayrıca tamamlaması gerekir.
