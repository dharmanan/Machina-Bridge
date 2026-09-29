# Machina Arc Intelligence — Phase 0 Data Source Audit

Audit tarihi: 2026-09-29 UTC. Dal: `feature/arc-intelligence`. Kapsam: Arc mainnet (chain ID 5042), salt okunur ve sınırlı canlı sorgular. Bu belge ürün metriği, production API veya geçmiş zincir taraması değildir.

## 1. Executive summary

Arc JSON-RPC blokları, tam işlemleri, receipt'leri, log'ları ve kontrat kodunu döndürüyor. Yakın geçmişteki sabit 50 blokluk örneğin 646 işleminin tamamı için receipt elde edildi. Blok sayısı, zaman damgası, üst düzey işlem sayısı ve sınırlı kontrat olayları bugün zincirden doğrudan doğrulanabilir. Bu sonuç, aynı erişimin zincirin tamamı için sınırsız hızda ve eksiksiz geçmiş derinliğinde sağlandığını **kanıtlamaz**.

Arc USDC'nin native ve ERC-20 yüzleri aynı ekonomik bakiyeye bağlıdır. İki `Transfer` log akışını toplamak hacmi şişirir; bu denetimde 10 blokta örtüşen işlem/log örnekleri görüldü. CCTP V2 için bilinen Arc kontratlarından inbound mint ve mesaj olayları okundu. Tam net köprü akışı için outbound burn olayları ile kaynak zincirdeki mint/burn olaylarını eşleştirmek, domain ve fee tanımlarını sabitlemek gerekir. DEX swap/hacim metrikleri için repoda doğrulanmış router/pool registry yoktur; swap sınıflandırması üretilemez.

**Öneri:** Phase 1'de RPC'yi doğrulama ve canonical olay kaynağı, ayrı bir indexer'ı discovery/backfill yardımcısı yapan hibrit veri hattının dar bir dilimini kurmak. Önce blok/receipt tutarlılığı ve bilinen CCTP/vault kontratlarının olayları; DEX ve tüm zincir token hacmi kapsam dışı. Kalıcı depolama ileride ayrı bir Arc Intelligence domain'i olmalı; mevcut Bridge Upstash Redis'i bu amaçla kullanılmamalı. Database/altyapı seçimi bu fazda yapılmadı.

## 2. Current Machina data architecture

| Mevcut parça | Kanıt / rol | Intelligence açısından sınır |
| --- | --- | --- |
| Arc ve CCTP konfigürasyonu | [`src/config/mainnet.ts`](../src/config/mainnet.ts), [`src/config/mainnetNetworks.ts`](../src/config/mainnetNetworks.ts), [`src/config/mainnetCctp.ts`](../src/config/mainnetCctp.ts) | Chain ID, RPC, USDC, CCTP domain/kontrat ve Bridge rota adresleri yeniden kullanılabilir. Rota konfigürasyonu tüm zincir işlemleri için index değildir. |
| Wallet Activity | [`api/arc-wallet-activity.js`](../api/arc-wallet-activity.js), [`src/lib/mainnetWalletActivity.ts`](../src/lib/mainnetWalletActivity.ts) | Etherscan V2 `txlist` + `tokentx` ile tek cüzdana ait en fazla 30 kayıt; sınıflandırma cüzdan bağlamında. Chain-wide CCTP veya DEX analitiğinin yerini tutmaz. |
| Earn | [`src/config/mainnetEarn.ts`](../src/config/mainnetEarn.ts), [`src/components/MainnetEarnPreview.tsx`](../src/components/MainnetEarnPreview.tsx) | İki seçili Arc vault adresi/share metadata'sı doğrulanmış konfigürasyon. Circle EarnKit discovery/doğrudan lookup ve Morpho GraphQL fallback anlık vault gösterimi içindir; geçmiş onchain olay index'i değildir. Earn execution'a dokunulmadı. |
| Bridge tracker | [`api/_lib/redis.js`](../api/_lib/redis.js), [`api/transfers.js`](../api/transfers.js), [`api/activities.js`](../api/activities.js) | Mevcut Upstash Redis, Bridge transfer/aktivite durumunu ve kısa süreli indeksleri saklar. Arc Intelligence kalıcı zincir verisi için kullanılmamalı. |

Bilinen Arc mainnet adresleri: USDC `0x3600000000000000000000000000000000000000`; CCTP V2 TokenMessenger `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`; MessageTransmitter `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`; Galaxy USDC `0x8E357432CC12ff425c36432F312968aEb16112AF`; Gauntlet USDC Prime `0xdECcd53BE5453215821184824B519E04C7e00bC7`. Bridge konfigürasyonu ayrıca Arc GatewayWallet `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`, GatewayMinter `0x2222222d7164433c4C09B0b0D809a9b52C04C205` ve Ethereum/Base/Optimism/Arbitrum USDC ile CCTP domain'lerini içeriyor. Galaxy payı `arcUSDC`, Gauntlet payı `gtusdcp`; ikisi de 18 decimals. Adresler yalnız yapılandırılmış, bilinen protokol kapsamı sağlar; başka vault veya DEX otomatik keşfi sağlamaz. Arc'ın [resmi adres listesi](https://docs.arc.io/arc/references/contract-addresses) USDC ve CCTP kontratlarını destekler.

## 3. Arc data sources tested

### Arc JSON-RPC

Kaynak: [`https://rpc.mainnet.arc.io`](https://docs.arc.io/arc/references/connect-to-arc). Secret veya API key olmadan salt okunur JSON-RPC çağrıları yapıldı. Hex blok numaralarıyla `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber(number, true)`, `eth_getTransactionReceipt`, `eth_getBlockReceipts`, `eth_getLogs` ve `eth_getCode` sınandı. `eth_chainId = 0x13b2` (5042); `eth_blockNumber` 2026-09-29 14:51:04 UTC'de `0x164d5c9` (23,385,545) döndürdü. Tekil `eth_getTransactionReceipt` örneği (`0x6de8dfc9d5012358e318488ad9bb96d324e1fa29d5b7758f3f89d6099700bccd`) `status=0x1` ve 2 log verdi. Sabit örnek aralığı aşağıda. `eth_getCode` latest yanıtı USDC, CCTP TokenMessenger/MessageTransmitter ve her iki Earn vault için boş değildi; bu, ABI veya semantik doğrulaması değildir.

`eth_getLogs` için bilinen adres filtreli 10, 50, 200 ve 500 blok aralıkları başarıyla döndü. 500 blokluk bir ilk deneme HTTP 429 aldı; kısa süre sonra **aynı 500 blok sorgusu HTTP 200 ve 5 log** döndürdü. Böylece 500 blokluk katı limit kanıtlanmadı, fakat burst/rate kapasitesi güvence altında değil. 65 çağrılık ilk probe'da en büyük JSON-RPC yanıtı yaklaşık 296.6 kB, en uzun ölçülen çağrı 1.471 saniyeydi. Bunlar hizmet seviyesi ölçümü veya kapasite testi değildir.

Genesis blok başlığı (`0x0`) ve örnek uç bloğundan 100,000 blok eski başlık alınabildi. Genesis yakınında 0–10 ve 100,000 blok geride 11 blokluk **filtreli** `eth_getLogs` sorguları HTTP 200 döndü (sırasıyla 0 ve 134 log). Bu yalnız iki noktadaki erişimi kanıtlar; genesis'ten itibaren tüm receipt/log geçmişinin eksiksizliği, archive state veya sorgu aralığı üst sınırı doğrulanmadı.

### Etherscan V2 / Arc

Mevcut Wallet Activity kaynağı `https://api.etherscan.io/v2/api?chainid=5042`; `txlist` ve `tokentx` **adres odaklı** çağrılır. [Normal transactions](https://docs.etherscan.io/api-reference/endpoint/txlist) ve [ERC-20 transfers](https://docs.etherscan.io/api-reference/endpoint/tokentx) dokümanlarında `address`/`contractaddress`, `startblock`, `endblock`, `page`, `offset`, `sort` parametreleri var. Sayfalama ve tarihsel derinlik kayıt sayısı, sağlayıcı kapsamı ve planla sınanmalı; ilk sayfa ile tüm geçmiş veya chain-wide toplam ispatlanmaz. Repo API'si özellikle ilk sayfadan en çok 100 upstream satır ister ve kullanıcıya 30 kayıt döndürür.

Bu yerel probe sürecinde `ETHERSCAN_API_KEY` ortam değişkeni mevcut değildi; `.env` dosyaları okunmadı. Anahtarsız `txlist` çağrısı `status: 0`, `message: NOTOK`, `result: Missing/Invalid API Key` döndürdü. Dolayısıyla **canlı yetkili `txlist`/`tokentx` kayıtlarının doğruluğu ve derinliği bu denetimde test edilmedi**. Dokümantasyonda Free plan 3 çağrı/saniye ve 100,000 çağrı/gün (seçili chain'ler) olarak listeleniyor; [Arc 5042 için plan erişiminin 2026-10-16'da değişeceği](https://docs.etherscan.io/supported-chains) belirtiliyor. Bu tarihler ve ücretler kullanım öncesi yeniden doğrulanmalı. Adres odaklı API, tüm Arc bloklarını/receipt'lerini eksiksiz toplama kaynağı olarak kabul edilmemeli.

### Explorer / indexer

Arc belgeleri [`explorer.arc.io`](https://docs.arc.io/arc/references/connect-to-arc) bağlantısını verir; resmi, dokümante edilmiş genel amaçlı explorer veri API'si bu araştırmada bulunmadı. Salt okunur `/api/v2/blocks` ve `/api?module=proxy&action=eth_blockNumber` denemeleri HTTP 403/HTML döndürdü. Bu iki yolun reddi tüm olası API'lerin yokluğunu kanıtlamaz; **production bağımlılığı olarak doğrulanmış bir public explorer endpoint'i yok**. HTML scraping veri motoru seçeneği değildir.

Arc'ın [Data indexers](https://docs.arc.io/arc/tools/data-indexers) sayfası Alchemy, Envio, Goldsky, Pinax, The Graph, Thirdweb ve Zerion gibi indexer sağlayıcılarını listeliyor. Belirli sağlayıcının Arc mainnet kapsamı, event doğruluğu, backfill SLA'sı ve maliyeti bu fazda canlı yetkili sorguyla doğrulanmadı; mimaride aday keşif/backfill katmanıdır, canonical gerçek olarak kabul edilmez.

## 4. Probe results

### 50 blokluk audit snapshot

Yöntem: `eth_getBlockByNumber(number, true)` ile **23,385,491–23,385,540 dahil** 50 blok okundu; aynı blokların 646 receipt'i `eth_getBlockReceipts` ile karşılaştırıldı. Başlangıç ve bitiş timestamp'leri sırasıyla `1790693436` (`2026-09-29 14:50:36 UTC`) ve `1790693461` (`2026-09-29 14:51:01 UTC`). Ölçüm yaklaşık 25 saniyelik hareketli zincir kesitidir.

| Ölçüm | Sonuç | Tanım |
| --- | ---: | --- |
| Block count | 50 | İki uç dahil |
| Total transactions | 646 | Blokların `transactions` toplamı |
| Unique senders | 317 | Üst düzey `from` adresleri |
| Unique recipients | 81 | Null olmayan üst düzey `to` adresleri |
| Unique active addresses | 385 | `from ∪ non-null to`; **wallet sayısı değildir** |
| Top-level contract creation transactions | 0 | `to = null`; iç `CREATE/CREATE2` kapsam dışı |
| Successful / failed / unknown receipt status | 642 / 4 / 0 | 646 receipt eşleşti |
| Native `value > 0` top-level transactions | 104 | Tüm native hareket veya USDC transfer hacmi değildir |
| Nonempty calldata with non-null `to` | 573 | Kontrat etkileşimi için yalnız aday; code/selector doğrulaması gerekir |
| Average transactions/block | 12.92 | 646 / 50 |
| Observed average block interval | yaklaşık 0.51 saniye | 25 saniye / 49 sınır |
| Observed transaction rate | yaklaşık 1,550.4 tx/dakika | 646 × 60 / 25; yalnız bu kesit |

Bu sayılar Arc'ın günlük/genel metriği, benzersiz cüzdan sayısı veya uzun süreli throughput garantisi değildir. Arc bloklarında aynı saniye timestamp bulunabildiğinden olay sırası için `(block_number, transaction_index, log_index)` kullanılmalı; timestamp tek başına sıralama anahtarı olamaz. [Arc event indexing rehberi](https://docs.arc.io/integrate/infrastructure/indexing-events) de log sırasını ve native/ERC-20 USDC ayrımını ele alır.

### Transfer log örneği ve USDC çift sayım riski

`Transfer(address,address,uint256)` topic `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` ile örnek son 10 blokta tüm emitter'larda 227 log/17 emitter görüldü. Arc USDC kontratı 58, sistem emitter'ı `0xfffffffffffffffffffffffffffffffffffffffe` 91 `Transfer` log üretti. 50 blokta karşılıkları 255 ve 468'di. Bunlar **toplanabilir bağımsız USDC transfer sayıları değildir**.

10 bloktaki 36 tx hash her iki akışta vardı; kontrat kaynaklı 58 USDC transfer log'unun 57'si aynı tx hash, gönderen, alıcı ve normalleştirilmiş tutarla sistem log'uyla eşleşti. Eşleşme örneğinde ERC-20 arayüzü 6 decimals, sistem/native gösterimi 18 decimals olduğundan `native_raw / 10^12 = erc20_raw`. Bir kontrat log'u eşleşmedi; bu yüzden basit bire bir veya tüm zincire genellenmiş dedupe kuralı kanıtlanmış değildir. [Arc resmi kontrat açıklaması](https://docs.arc.io/arc/references/contract-addresses) native ve ERC-20 USDC'nin aynı bakiye olduğunu, 18 ve 6 decimals kullandığını belirtir. Unknown token'ların `Transfer` miktarları symbol/decimals/fiyat doğrulanmadan USD hacmi diye etiketlenmemeli.

### Known contract ve CCTP örneği

Bilinen TokenMessenger/MessageTransmitter adreslerinde **23,385,341–23,385,540** arası 200 blok için 4 CCTP V2 log bulundu: 2 `MessageReceived`, 2 `MintAndWithdraw`, 0 `DepositForBurn`. Bu yalnız yakın örnek penceresinde inbound olayları görüldüğü anlamına gelir; genel outflow yokluğu sonucu değildir.

| Arc tx hash | Block | Olaydan doğrulanan alanlar |
| --- | ---: | --- |
| `0x81da4b880ef194a173b3ed239115618471ada823a200c7f42fda542f69b80f56` | 23,385,427 | `MessageReceived.sourceDomain=0` (Ethereum); `MintAndWithdraw.amount=999956737` raw Arc USDC (999.956737 USDC, 6 decimals), `feeCollected=43263` raw |
| `0x09caca2bbd91a2114362e66be15cb5128accb4a507b2c67b289420ef357e7df9` | 23,385,533 | `MessageReceived.sourceDomain=6` (Base); `MintAndWithdraw.amount=174138` raw (0.174138 USDC), `feeCollected=17428` raw |

Her iki Arc tx'de CCTP mesajı ile mint aynı receipt'te gözlendi. Olay imzaları Circle'ın [TokenMessengerV2](https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/TokenMessengerV2.sol), [MessageTransmitterV2](https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/MessageTransmitterV2.sol) ve [BaseTokenMessenger](https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/BaseTokenMessenger.sol) kaynaklarından alındı; sadece log topic'i değil, emit eden kontrat ve alan şeması da doğrulama koşuludur.

İki seçili Earn vault adresine filtrelenen aynı 200 blokta vault log'u yoktu. Bu, vault activity yokluğu veya event ABI'si hakkında zincir geneli kanıt değildir; daha geniş ama kontrollü örnek, deployed ABI ve receipt düzeyinde eşleştirme Phase 1 doğrulamasıdır.

## 5. Metric feasibility matrix

Sınıflar: `RPC_DIRECT` = tek/az doğrudan çağrıyla onchain alan; `RPC_DERIVED` = sınırları tanımlanmış blok/receipt/log hesabı; `KNOWN_CONTRACT_REQUIRED` = doğrulanmış adres/ABI ve semantik; `INDEXER_REQUIRED` = üretimde tarihsel ve zincir geneli eksiksiz kapsama için kalıcı indeks; `NOT_RELIABLE_YET` = gerekli kimlik/semantik veya kaynak bugün doğrulanmamış. Sınıf, aşağıdaki **tanımlı** metriğe aittir; daha iddialı yorum otomatik geçerli değildir.

| # | Metrik | Sınıf | Gerekçe / güvenilir tanım |
| ---: | --- | --- | --- |
| 1 | Latest block | `RPC_DIRECT` | `eth_blockNumber` canlı döndü; head zamanla değişir. |
| 2 | Block timestamp | `RPC_DIRECT` | `eth_getBlockByNumber.timestamp` canlı döndü; saniye çözünürlüğü. |
| 3 | Block time | `RPC_DERIVED` | Ardışık blok timestamp farkı; aynı saniye blokları ve pencere tanımı korunmalı. |
| 4 | Transactions per block | `RPC_DIRECT` | Tam bloktaki transaction listesi/uzunluğu. |
| 5 | Transaction count over a time window | `RPC_DERIVED` | UTC sınırlarına giren blokların tx toplamı; timestamp eşitlik ve sınır blokları tanımlanmalı. Uzun dönem servis için indeks gerekir. |
| 6 | Unique active wallets | `NOT_RELIABLE_YET` | `from ∪ to` adres sayısı ölçülür ama bunlar kontratları da içerir, iç çağrılar eksik ve EOA/cüzdan eşitliği yoktur. Ayrı “unique top-level active addresses” `RPC_DERIVED` olarak yayınlanabilir. |
| 7 | New wallets | `NOT_RELIABLE_YET` | “Yeni cüzdan” onchain doğum olayı değildir. Önerilen alternatif “tam geçmişte ilk kez görülen adres”; ilk görülme için genesis'ten eksiksiz indeks ve EOA/contract politikası gerekir. |
| 8 | Contract interactions | `RPC_DERIVED` | `to` için ilgili blokta code ve başarılı/başarısız receipt; yalnız üst düzey çağrılar. İç çağrılar için trace gerekir. Calldata varlığı tek başına yeterli değil. |
| 9 | Contract deployments | `RPC_DERIVED` | Üst düzey `to=null` ve başarılı receipt `contractAddress`; iç `CREATE/CREATE2` için trace/indexer gerekir. Örnek pencerede 0. |
| 10 | Unique active contracts | `RPC_DERIVED` | Tanım: üst düzey hedef veya log emitter olup ilgili blokta code bulunan adresler. İçte çağrılan ama log üretmeyen kontratlar eksik. |
| 11 | ERC-20 transfers | `INDEXER_REQUIRED` | Belirli bounded pencerede `Transfer` log'u RPC'den alınır; tüm geçmiş/token evreni, uyumsuz tokenlar ve Arc USDC dedupe için indeks + doğrulama gerekir. |
| 12 | Token transfer volume | `INDEXER_REQUIRED` | Per-token raw miktar indekslenip token identity/decimals doğrulanmalı. USD karşılığı için ayrıca doğrulanmış fiyat ve zaman metodolojisi gerekir; bu fazda USD hacim yok. |
| 13 | Arc native USDC transfers | `NOT_RELIABLE_YET` | Üst düzey `value>0` alt kümedir; iç native hareket/gas ve ERC-20 yüzüyle ortak bakiye nedeniyle ayrı, tam ekonomik seri tanımlanmadı. |
| 14 | ERC-20 Arc USDC transfers | `KNOWN_CONTRACT_REQUIRED` | Bilinen `0x3600…0000` `Transfer` log'ları okunuyor; native/sistem akışıyla örtüşme giderilmeden “toplam USDC” denemez. |
| 15 | Other stablecoin activity | `KNOWN_CONTRACT_REQUIRED` | Resmi kontrat registry ve decimals bazında (örn. resmi Arc EURC) izlenebilir; bilinmeyen `Transfer` token'ı stablecoin kabul edilmez. |
| 16 | Bridge / Circle CCTP inflow | `KNOWN_CONTRACT_REQUIRED` | Arc V2 `MintAndWithdraw` + `MessageReceived` ve USDC/domain filtresi; örnekte 2 olay. Net mint ve fee ayrı. |
| 17 | Bridge / Circle CCTP outflow | `KNOWN_CONTRACT_REQUIRED` | Arc V2 `DepositForBurn` burn token, amount, destinationDomain; örnek pencerede 0, genel yokluk sonucu değil. |
| 18 | Net bridge flow | `INDEXER_REQUIRED` | Tanımlı zaman penceresinde net Arc minted-in eksi burned-out, fee politikası ve crosschain eşleştirme; Arc tek başına tamamlanmış transfer/diğer chain finalitesini kanıtlamaz. |
| 19 | DEX swap activity | `NOT_RELIABLE_YET` | Doğrulanmış Arc router/pool/event registry yok; rastgele token in+out swap değildir. |
| 20 | DEX volume | `NOT_RELIABLE_YET` | Swap kimliği, yön, token decimals ve tarihsel fiyat olmadan hacim yok. |
| 21 | Unique DEX traders | `NOT_RELIABLE_YET` | Doğrulanmış swap ve `trader` semantiği yok; router/aggregator ile kullanıcı ayrımı çözülmeli. |
| 22 | Token creation / newly seen token contracts | `INDEXER_REQUIRED` | Başarılı top-level ve iç deployment + token interface doğrulaması, ilk görülme ve proxy ayrımı gerekir; yalnız `Transfer` veya `to=null` token yaratımı değildir. |
| 23 | Earn vault deposits/withdrawals | `KNOWN_CONTRACT_REQUIRED` | İki bilinen vault için deployed event ABI/receipt doğrulaması sonrası zincir geneli olaylar çıkarılabilir. 200 blokta olay yok; tutar/flow bu fazda ölçülmedi. |
| 24 | Protocol level activity by known contract | `KNOWN_CONTRACT_REQUIRED` | Adres, ABI, proxy ve olay semantiği doğrulanmış protokolle sınırlı tx/log serisi; tüm protokol iç çağrılarını otomatik kapsamaz. |
| 25 | Hourly/daily time series | `INDEXER_REQUIRED` | Küçük aralık RPC ile türetilebilir, fakat sürekli API için backfill, checkpoint, yeniden işleme ve idempotent aggregation gerekir. |

## 6. CCTP feasibility

Arc domain 26 ve V2 kontrat adresleri repo ile [resmi Arc adres listesinde](https://docs.arc.io/arc/references/contract-addresses) mevcut. `DepositForBurn` event'i burn token, gross amount, depositor, mint recipient, destination domain, fee/finality alanlarını; `MessageReceived` source domain ve nonce'u; `MintAndWithdraw` recipient, net minted amount, mint token ve collected fee'yi sağlar. İşlem hash'i/log konumu receipt'ten, timestamp bloktan gelir. Bu alanlar bilinen V2 kontratı/ABI'si ve Arc USDC ile filtrelenirse Arc tarafındaki CCTP sinyallerini güvenilir kılar.

Çıkış ve giriş farklı domain/chain'lerde gerçekleşir: Arc üzerindeki burn'un gerçekten başka chain'de mint edildiğini Arc log'ları tek başına söylemez. `net flow` için “Arc'da belirli zaman aralığında mint edilen net USDC − Arc'da yakılan gross USDC” gibi açık muhasebe tanımı, fee ayrımı, kaynak/destination domain ve nonce/message eşleştirmesi gerekir. Gateway akışı CCTP V2 ile aynı event set'i değildir; Bridge rota konfigürasyonunu chain-wide CCTP sayacına dönüştürmeyin. Wallet Activity'nin tek cüzdan işlem sınıflandırması da zincir geneli CCTP index'i değildir.

## 7. Earn/vault feasibility

Konfigürasyonda yalnız iki launch vault var: Galaxy ve Gauntlet. Bilinen vault/share adresleriyle RPC üzerinden ilgili receipt/log'lar filtrelenebilir. Fakat bir share `Transfer` (mint/burn), USDC `Transfer`, iç çağrı veya vault `Deposit`/`Withdraw` event'i tek başına doğrulanmış deposit/withdraw değildir. Önce Arc'daki gerçek deployed contract ABI'si, proxy implementation, ERC-4626 event signature'ları ve birkaç gerçek tx receipt'i karşılaştırılmalı. Ardından vault event'ini tx hash/log index, owner/receiver/caller ve asset/share miktarıyla eşleştirip çift sayım önlenmeli. 200 blokluk filtremiz iki vault'ta 0 log verdi; doğrulanmış canlı deposit/withdraw tutarı raporlanmıyor.

Mevcut Circle EarnKit ve Morpho GraphQL vault discovery/finansal gösterim kaynağı olarak kalır. Intelligence tarihsel onchain vault flow'ları için ayrı okuma hattı kurabilir; Earn'in deposit/withdraw/quote davranışına veya seçili iki vault allowlist'ine müdahale gerekmez. İleride doğrulanmış ortak **read API** verisi Earn'e sunulabilir, ancak APY/likidite ile zincir event flow'ları ayrı provenance ve freshness alanları taşımalıdır. Bu fazda böyle bir API eklenmedi.

## 8. DEX limitations

Repo'da Arc mainnet için doğrulanmış DEX router, factory, pool registry veya swap ABI bulunmadı. Tek tx'de in ve out token hareketleri; köprü, vault, transferFrom, fee, batch veya swap olabilir. Bunları swap diye etiketlemek yanlış pozitif üretir. Swap sayısı, hacim ve trader sayısı için önce resmi/verified pool registry, event semantiği, aggregator ayrıştırması, token metadata ve gerektiğinde fiyat yöntemi doğrulanmalı. Phase 0 DEX metriği üretmez.

## 9. Recommended Intelligence architecture

| Seçenek | Correctness / gecikme | Historical backfill / rate | Operasyon / maliyet / vendor | Gelecek API/agent kullanımı |
| --- | --- | --- | --- | --- |
| A. RPC-only indexer | Zincirle doğrudan mutabakat; küçük anlık pencerede hızlı. Eksik trace/USDC özel semantik yine çözülür. | Genesis backfill ve yoğun log/receipt sorguları public RPC limitine takılabilir; örnekte 429 görüldü. | Tam kendi indeks, worker, checkpoint, storage ve RPC kapasitesi gerekir; vendor az, işletim yükü yüksek. | Güçlü olabilir, ancak ancak eksiksiz tarihçe ve sağlam işletimden sonra. |
| B. Third-party indexer first | Adres/token discovery ve hazır sayfalama hızlı olabilir; kapsam/yeniden sıralama vendor'a bağlı. | Plan, kota, chain erişimi ve derinlik değişebilir; Arc Etherscan plan değişimi duyurulmuş. | Düşük ilk işletim, yüksek sağlayıcı ve fiyat bağımlılığı. | Tek vendor semantiği API/agent doğruluğunu sınırlar; RPC karşılaştırması gerekir. |
| C. Hybrid (önerilen) | Bilinen olayları canonical RPC receipt/log ile doğrular; indexer yalnız discovery/backfill/cache yardımcısı. | Bounded RPC ingestion ve sağlayıcı tabanlı backfill ile yük bölünür; boşluklar RPC ile uzlaştırılır. | İki veri yolu ve provenance yönetimi gerekir; kapsam kademeli açılır. | Kaynak/son doğrulama/blok aralığı belirtilen güvenilir read API temeli sağlar. |

**Önerilen Phase 1 sınırı:** Hibrit mimarinin küçük çekirdeği: Arc blok/receipt işleme, bilinen CCTP V2 log decode ve iki vault için ABI/olay doğrulaması. Indexer sağlayıcısı ancak canlı coverage/latency/rate karşılaştırması sonrası seçilmeli. Eksik veya tutarsız pencere “complete” sayılmamalı; her metrik tanımı, chain ID, block range, source, sync checkpoint ve doğrulama durumu taşımalı. UI, execution veya Bridge Redis üzerinde değişiklik yok.

## 10. Proposed data domains/schema

Bu **kavramsal domain taslağıdır**; veritabanı, Railway, PostgreSQL veya Redis seçimi/kurulumu değildir.

| Domain | Ana kimlik ve gerekli alanlar |
| --- | --- |
| `blocks` | `(chain_id, number)`; hash, parent_hash, timestamp, ingestion status/source |
| `transactions` | `(chain_id, hash)`; block/tx index, from/to, raw value, input selector, receipt status, contract_address |
| `logs` | `(chain_id, tx_hash, log_index)`; block/index, emitter, topics, raw data, removed/source |
| `token_transfers` | `(chain_id, tx_hash, log_index, semantic_kind)`; token, from/to, raw amount, decimals provenance, native/USDC dedupe link |
| `contracts` | `(chain_id, address)`; first seen/deployment evidence, code hash, verified ABI/proxy provenance |
| `known_protocols` | chain/address + protocol/version/role, ABI source, effective block range, verification state |
| `bridge_flows` | chain/tx/log + message nonce/domain pair, burn/mint/fee raw amounts, crosschain match status |
| `vault_flows` | chain/vault/tx/log + event kind, owner/receiver/caller, assets/shares raw, ABI version |
| `hourly_metrics` | metric key, UTC hour, chain, definition version, source block range, completeness/provenance |
| `daily_metrics` | metric key, UTC day, chain, definition version, source block range, completeness/provenance |

Raw integer tutarlar string/decimal-safe biçimde tutulmalı; token/native decimals ve USD dönüşümü ayrı, kaynaklı semantik olmalı. Reprocessing için blok/hash ve log kimliğiyle idempotent yazım, parent-hash kontrolü, checkpoint ve eksik blok tespiti gerekir. Mevcut Bridge tracker'ın Upstash Redis şemasına bağlanmamalı.

## 11. Phase 1 implementation plan

1. **Metrik sözleşmesi:** “unique addresses”, CCTP minted/burned/net, USDC canonical transfer ve zaman sınırlarını açıkça tanımla; unsupported alanları `unavailable` tut.
2. **RPC veri bütünlüğü:** Küçük, bounded blok ilerletici; block/tx/receipt sayısı eşleşmesi, retry/backoff, 429 gözlemi, hash/checkpoint ve provenance. Tarihsel derinlik/limit testi ayrı kontrollü kapasite çalışması olsun.
3. **USDC kanonikleştirme:** Native/system ve ERC-20 log eşleştirmesini gerçek receipt örnekleriyle doğrula; eşleşmeyen log sınıfını elle incele. Toplam hacim ancak dedupe kanıtından sonra.
4. **Bilinen protokol decoder'ları:** Resmi Circle V2 ABI'leri ve Arc contract doğrulamasıyla CCTP flow; Galaxy/Gauntlet deployed ABI ve gerçek deposit/withdraw receipt'leriyle vault flow. Önce unit fixture, sonra kısa canlı reconciliation.
5. **Indexer karşılaştırması:** Arc destekli sağlayıcıların yetkili endpoint'lerinde aynı block/log aralığını RPC ile karşılaştır; fiyat, kota, backfill, gecikme ve hata davranışını ölç. Seçimi sonra yap.
6. **Ayrı read model/API tasarımı:** Tamlık, kaynak, last indexed block ve tanım sürümünü içeren read response sözleşmesini yaz; storage/servis seçimi ve production endpoint sonraki onaya bırakılır.

## 12. Risks/open questions

- Public RPC'nin gerçek rate limit, log-range ve tarihsel retention SLA'sı belgelenmiş/ölçülmüş değil. 500 blokta bir 429, tekrarında 200 görüldü; kalıcı limit sonucu çıkarılamaz.
- USDC native/ERC-20 ortak bakiye için 58 kontrat log'unun 1'i sistem akışıyla eşleşmedi. Eşleşmeyen koşullar anlaşılmadan toplam transfer/hacim yayınlanmamalı.
- Etherscan V2 yetkili canlı `txlist`/`tokentx` verisi API key bulunmadığından bu denetimde sınanmadı; Arc plan erişimi 2026-10-16 sonrası değişiyor. Source/ABI endpoint erişimi de canlı doğrulanmadı.
- Explorer'ın iki tahmini API yolu HTTP 403 verdi; resmi, dokümante public explorer/indexer API'si bulunmadı. Sağlayıcı adayları ve SLA'ları doğrulanmalı.
- CCTP V2 inbound örnek var, outbound bu 200 blokta yok. Tam crosschain completion ve net akış için diğer chain olayları, nonce eşleştirmesi, fee ve zaman politikası gerekiyor.
- Vault ABI/proxy ve gerçek deposit/withdraw event'leri canlı tx ile henüz doğrulanmadı. Morpho/Circle finansal alanları tarihsel onchain flow yerine kullanılamaz.
- DEX registry, swap semantiği ve fiyat kaynağı yok. DEX metrikleri eksik kalmalı; tahminle doldurulmamalı.
- Bu audit kısa örnektir: günlük ağ kullanımını, tüm tarihçeyi, iç çağrıları, yeni cüzdanları veya bütün token evrenini temsil etmez.

### Probe tekrar üretme sınırı

Örnek yöntem: `eth_getBlockByNumber` için yukarıdaki 50 hex blok numarası ve `true`; her blok için `eth_getBlockReceipts`; bilinen adres/topic ile `eth_getLogs` için en çok 200 veya ayrı testte 500 blok; `eth_getCode` için yalnız bilinen adresler. Çağrı sonuçları geçici bellekte işlendi; repo içine büyük JSON, script, API key veya raw yanıt eklenmedi. Canlı head değişeceğinden aynı blok aralığı tekrar okunabilir, `eth_blockNumber` değeri değişir. Bu bölüm yöntem açıklamasıdır, production ingestion talimatı değildir.
