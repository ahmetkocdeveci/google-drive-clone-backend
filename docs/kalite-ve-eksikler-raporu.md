# Kalite ve bakım durumu

Güncelleme: **24 Ekim 2026**. Önceki geliştirme kayıtlarının yerine güncel teslim özeti kullanılır. Ayrıntılı kabul matrisi [teslim kontrolündedir](release-checklist.md).

## Doğrulama

- Backend testleri gerçek HTTP ve geçici MongoDB replica set veritabanları kullanır. Yetki/tenant sınırı, eşzamanlı üyelik ve finalize işlemleri, session/CSRF, OAuth state/nonce/PKCE, outbox, ZIP/Range/iptal ve yedek bütünlüğü kapsanır.
- Backend CI sözdizimi, deployment şablonu, test, üretim bağımlılığı taraması ve Docker derlemesini çalıştırır. Frontend CI ayrıca gerçek API/Mailpit ile tarayıcı ve erişilebilirlik senaryoları içerir.
- HTTPS uygulama, Google/davet dönüşü, PDF, alan ayrımı, Viewer/Editor, erişim iptali, mobil ağ, iç içe upload/ZIP, taşıma/arama ve işlem geçmişi canlıda manuel kabul edilmiştir.
- Kaynak sırları, yerel veri, OAuth JSON'ları ve derleme çıktıları Git'e alınmaz. Otomatik testlerin son sonucu Actions üzerinden doğrulanır; önceki bir çalışmanın sonucu yeni commit için kullanılmaz.

## Sınırlar

- Dosya içeriğini uygulama içinde düzenlemek kapsam dışıdır. Office dosyaları indirilir; PDF ve raster görsel önizlenir. Parolalı/bozuk PDF için indirme sunulur.
- Bağımlılık taraması kalıcı sıfır açık garantisi değildir. Backend taramasında bulgu yok; frontend'deki yamasız araç zinciri bildirimi kendi güvenlik kaydında belirtilmiştir.
- Ücretsiz tek instance kurulumunda SLA/yüksek erişilebilirlik garantisi yoktur. Dosya/alan/ZIP sınırları [README](../README.md) içindedir.
- Haftalık MongoDB snapshot ve ayrı manuel R2 yedeği vardır. Düzenli R2 ikinci konum yedeği, ortak zamana kurtarma tatbikatı ve gerçek alarm teslimi sonraki operasyon işleridir.
- Repo daveti ve ders/kişisel notlar depo sahibine aittir. Otomatik test veya hazır belge, kişinin öğrenme kaydının yerine geçmez.
