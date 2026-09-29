# Machina Arc Intelligence — Phase 0 Data Source Audit

Audit tarihi: 2026-09-29 UTC. Dal: `feature/arc-intelligence`. Kapsam: Arc mainnet (chain ID 5042), salt okunur ve sınırlı canlı sorgular. Bu belge ürün metriği, production API veya geçmiş zincir taraması değildir.

## 1. Executive summary

Arc JSON-RPC blokları, tam işlemleri, receipt'leri, log'ları ve kontrat kodunu döndürüyor. Yakın geçmişteki sabit 50 blokluk örneğin 646 işleminin tamamı için receipt elde edildi. Blok sayısı, zaman damgası, üst düzey işlem sayısı ve sınırlı kontrat olayları bugün zincirden doğrudan doğrulanabilir. Bu sonuç, aynı erişimin zincirin tamamı için sınırsız hızda ve eksiksiz geçmiş derinliğinde sağlandığını **kanıtlamaz**.

Arc USDC'nin native ve ERC-20 yüzleri aynı ekonomik bakiyeye bağlıdır. [Arc indexing docs](https://docs.arc.io/integrate/infrastructure/indexing-events) uyarınca explicit USDC transferleri için canonical akış, EIP-7708 system emitter `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE` `Transfer` olaylarıdır; ERC-20 arayüz olayları aynı hareketin hacmine ikinci kez eklenmez. Bu denetimde 10 blokta örtüşen işlem/log örnekleri görüldü. CCTP V2 için bilinen Arc kontratlarından inbound mint ve mesaj olayları okundu. Tam net köprü akışı için outbound burn olayları ile kaynak zincirdeki mint/burn olaylarını eşleştirmek, domain ve fee tanımlarını sabitlemek gerekir. DEX swap/hacim metrikleri için repoda doğrulanmış router/pool registry yoktur; swap sınıflandırması üretilemez.

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

Bu sayılar Arc'ın günlük/genel metriği, benzersiz cüzdan sayısı veya uzun süreli throughput garantisi değildir. Arc bloklarında aynı saniye timestamp bulunabildiğinden genel kayıt sırası `(blockNumber, transactionIndex, logIndex)`, event-only sırası `(blockNumber, logIndex)` ile kurulmalı; timestamp sıralama anahtarı olamaz. Arc deterministic finality sağladığından reorg detection, rollback, confirmation buffer/depth veya reorg watcher gerekmez. [Arc event indexing rehberi](https://docs.arc.io/integrate/infrastructure/indexing-events) log sırasını ve native/ERC-20 USDC ayrımını ele alır.

### Transfer log örneği ve USDC çift sayım riski

`Transfer(address,address,uint256)` topic `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` ile örnek son 10 blokta tüm emitter'larda 227 log/17 emitter görüldü. Arc USDC kontratı 58, sistem emitter'ı `0xfffffffffffffffffffffffffffffffffffffffe` 91 `Transfer` log üretti. 50 blokta karşılıkları 255 ve 468'di. Bunlar **toplanabilir bağımsız USDC transfer sayıları değildir**.

10 bloktaki 36 tx hash her iki akışta vardı; kontrat kaynaklı 58 USDC transfer log'unun 57'si aynı tx hash, gönderen, alıcı ve normalleştirilmiş tutarla sistem log'uyla eşleşti. Eşleşme örneğinde ERC-20 arayüzü 6 decimals, sistem/native gösterimi 18 decimals olduğundan `native_raw / 10^12 = erc20_raw`. Bir kontrat log'u eşleşmedi; bu gözlem iki akış arasında bire bir eşleşme varsayılmaması gerektiğini gösterir, canonical system akışını engellemez. [Arc indexing docs](https://docs.arc.io/integrate/infrastructure/indexing-events) EIP-7708 `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE` `Transfer` akışını explicit USDC transfers için canonical tanımlar: native sends, ERC-20 transferin native leg'i, mint ve burn kapsanır; **gas deductions event üretmez**. `0x3600000000000000000000000000000000000000` ERC-20 `Transfer` olayları arayüz aktivitesi için ayrıca saklanabilir, fakat aynı ekonomik hareket volume'a ikinci kez eklenmez. Zero5 öncesi historical backfill'de legacy `NativeCoin` olayları ayrıca işlenmelidir. [Arc resmi kontrat açıklaması](https://docs.arc.io/arc/references/contract-addresses) native ve ERC-20 USDC'nin aynı bakiye olduğunu, 18 ve 6 decimals kullandığını belirtir. Unknown token'ların `Transfer` miktarları symbol/decimals/fiyat doğrulanmadan USD hacmi diye etiketlenmemeli.

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
| 11 | ERC-20 transfers | `INDEXER_REQUIRED` | Belirli bounded pencerede `Transfer` log'u RPC'den alınır; tüm geçmiş/token evreni ve uyumsuz tokenlar için indeks + doğrulama gerekir. USDC arayüz log'ları canonical system hacmine tekrar eklenmez. |
| 12 | Token transfer volume | `INDEXER_REQUIRED` | Per-token raw miktar indekslenip token identity/decimals doğrulanmalı. USD karşılığı için ayrıca doğrulanmış fiyat ve zaman metodolojisi gerekir; bu fazda USD hacim yok. |
| 13 | Arc explicit USDC transfers | `KNOWN_CONTRACT_REQUIRED` | EIP-7708 system `Transfer` akışı canonical: native sends, ERC-20 native leg, mint/burn; gas deductions event değildir. Zero5 öncesi legacy `NativeCoin` backfill ayrıca gerekir. |
| 14 | ERC-20 Arc USDC interface activity | `KNOWN_CONTRACT_REQUIRED` | `0x3600…0000` `Transfer` log'ları arayüz aktivitesi olarak saklanır; aynı hareket canonical USDC hacmine yeniden eklenmez. |
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
| 25 | Hourly/daily time series | `INDEXER_REQUIRED` | Küçük aralık RPC ile türetilebilir, fakat sürekli API için backfill, resume/continuity checkpoint'i, eksik blok tespiti ve idempotent aggregation gerekir. |

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

Raw integer tutarlar string/decimal-safe biçimde tutulmalı; token/native decimals ve USD dönüşümü ayrı, kaynaklı semantik olmalı. Reprocessing için blok/hash ve log kimliğiyle idempotent yazım; checkpoint ile yalnız resume/continuity ve eksik blok tespiti gerekir. Arc deterministic finality nedeniyle reorg rollback veya confirmation buffer gerekmez. Mevcut Bridge tracker'ın Upstash Redis şemasına bağlanmamalı.

## 11. Phase 1 implementation plan

1. **Metrik sözleşmesi:** “unique addresses”, CCTP minted/burned/net, USDC canonical transfer ve zaman sınırlarını açıkça tanımla; unsupported alanları `unavailable` tut.
2. **RPC veri bütünlüğü:** Küçük, bounded blok ilerletici; block/tx/receipt sayısı eşleşmesi, retry/backoff, 429 gözlemi, resume/continuity ve missing block detection için checkpoint, provenance. Arc deterministic finality için reorg watcher, rollback veya confirmation depth ekleme. Tarihsel derinlik/limit testi ayrı kontrollü kapasite çalışması olsun.
3. **USDC kanonikleştirme:** Explicit USDC transfer hacmini EIP-7708 system `Transfer` akışından çıkar; ERC-20 arayüz log'unu ayrı tut ve ikinci kez toplama. Gas deductions event değildir; Zero5 öncesi historical backfill için legacy `NativeCoin` olaylarını işle.
4. **Bilinen protokol decoder'ları:** Resmi Circle V2 ABI'leri ve Arc contract doğrulamasıyla CCTP flow; Galaxy/Gauntlet deployed ABI ve gerçek deposit/withdraw receipt'leriyle vault flow. Önce unit fixture, sonra kısa canlı reconciliation.
5. **Indexer karşılaştırması:** Arc destekli sağlayıcıların yetkili endpoint'lerinde aynı block/log aralığını RPC ile karşılaştır; fiyat, kota, backfill, gecikme ve hata davranışını ölç. Seçimi sonra yap.
6. **Ayrı read model/API tasarımı:** Tamlık, kaynak, last indexed block ve tanım sürümünü içeren read response sözleşmesini yaz; storage/servis seçimi ve production endpoint sonraki onaya bırakılır.

## 12. Risks/open questions

- Public RPC'nin gerçek rate limit, log-range ve tarihsel retention SLA'sı belgelenmiş/ölçülmüş değil. 500 blokta bir 429, tekrarında 200 görüldü; kalıcı limit sonucu çıkarılamaz.
- USDC native/ERC-20 ortak bakiye için 58 kontrat log'unun 1'i sistem akışıyla eşleşmedi. Bu, iki akış arasında bire bir eşleşme varsayımını geçersiz kılar; explicit USDC hacminde canonical EIP-7708 system akışı kullanılır. Zero5 öncesi legacy `NativeCoin` geçmişi ayrı ele alınır.
- Etherscan V2 yetkili canlı `txlist`/`tokentx` verisi API key bulunmadığından bu denetimde sınanmadı; Arc plan erişimi 2026-10-16 sonrası değişiyor. Source/ABI endpoint erişimi de canlı doğrulanmadı.
- Explorer'ın iki tahmini API yolu HTTP 403 verdi; resmi, dokümante public explorer/indexer API'si bulunmadı. Sağlayıcı adayları ve SLA'ları doğrulanmalı.
- CCTP V2 inbound örnek var, outbound bu 200 blokta yok. Tam crosschain completion ve net akış için diğer chain olayları, nonce eşleştirmesi, fee ve zaman politikası gerekiyor.
- Vault ABI/proxy ve gerçek deposit/withdraw event'leri canlı tx ile henüz doğrulanmadı. Morpho/Circle finansal alanları tarihsel onchain flow yerine kullanılamaz.
- DEX registry, swap semantiği ve fiyat kaynağı yok. DEX metrikleri eksik kalmalı; tahminle doldurulmamalı.
- Bu audit kısa örnektir: günlük ağ kullanımını, tüm tarihçeyi, iç çağrıları, yeni cüzdanları veya bütün token evrenini temsil etmez.

### Probe tekrar üretme sınırı

Örnek yöntem: `eth_getBlockByNumber` için yukarıdaki 50 hex blok numarası ve `true`; her blok için `eth_getBlockReceipts`; bilinen adres/topic ile `eth_getLogs` için en çok 200 veya ayrı testte 500 blok; `eth_getCode` için yalnız bilinen adresler. Çağrı sonuçları geçici bellekte işlendi; repo içine büyük JSON, script, API key veya raw yanıt eklenmedi. Canlı head değişeceğinden aynı blok aralığı tekrar okunabilir, `eth_blockNumber` değeri değişir. Bu bölüm yöntem açıklamasıdır, production ingestion talimatı değildir.

## 13. Complete ecosystem coverage audit

Phase 0B tarihi: 2026-09-29. Bu bölüm önceki 12 bölümün **genişletmesidir**. Önceki kısa örneğin bulguları geçerlidir; ancak Bölüm 9/11'deki üçüncü taraf indexer adayı, bu görevde sabitlenen **hesap/API key/kart/trial/ücretli plan gerektirmeyen kaynak** koşulunu karşılamadıkça mimariye giremez. Phase 1'in yeni kapsam ve sırası aşağıdadır. “Arc ekosisteminde adı geçiyor” sözleşme adresi, canlı onchain olay, hesaplanabilir hacim veya ürünün bugün erişilebilir olduğu anlamına gelmez.

**Kanıt düzeyleri:** `RPC_VERIFIED` = Arc 5042'de verilen adres için `eth_getCode` boş değil; yalnız deployment kanıtı, ABI/aktivite kanıtı değil. `OFFICIAL_ADDRESS` = güncel resmi mainnet registry veya protokol address book adresi yayımlıyor. `API_OBSERVED` = anahtarsız canlı endpoint yanıtı alındı. `ECOSYSTEM_LISTED` = Arc/Circle duyurusunda adı var, protokol kontratı doğrulanmadı. `UNVERIFIED` = adres veya mainnet kanıtı eksik. `ANNOUNCED` = açıkça yakında/planlanan. Metrik `RPC derivable` olsa bile ancak adres, olay ABI'si, pencere ve kapsama doğrulandıktan sonra yayımlanabilir. Bu audit bütün zincir geçmişini taramadı.

Başlıca kaynaklar: [Arc mainnet launch](https://www.arc.io/blog/arc-economic-os-internet), [Circle launch release](https://www.circle.com/pressroom/circle-launches-arc-mainnet-an-economic-operating-system-for-the-internet), [güncel Arc mainnet adresleri](https://docs.arc.io/arc/references/contract-addresses), [Arc interop duyurusu](https://www.arc.io/blog/introducing-interop-on-arc-crosschain-liquidity-without-the-complexity), [Uniswap V4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments), [Aave V4 changelog](https://www.aave.com/docs/resources/changelog), [Morpho API](https://docs.morpho.org/developers/api/get-started/). Arc'ın eski [event indexing rehberindeki](https://docs.arc.io/integrate/infrastructure/indexing-events) bazı örnek adresler testnet'e aittir; adres için güncel mainnet registry ve canlı RPC önceliklidir.

### 13.1 Network ve genel ölçüm çekirdeği

`eth_getBlockByNumber`, receipt ve log'lar ile blok/işlem/tx başına blok, zaman penceresi işlem oranı, success/fail, `gasUsed × effectiveGasPrice` ile ödenen işlem ücreti, toplam gas, üst düzey `from ∪ to` aktif adresleri ve üst düzey contract creation doğrudan veya bounded RPC türetimidir. Ücret Arc native USDC birimindedir; diğer asset veya protokol geliri diye sunulmaz. EOA/contract ayrımı için adresin **ilgili bloktaki** kodu gerekir; proxy, smart wallet ve counterfactual wallet yüzünden bu da insan/cüzdan sayısı değildir. Üst düzey contract interaction için hedef kodu ve receipt kontrol edilir; iç çağrılar trace olmadan yoktur. `contractAddress` başarılı üst düzey deployment'ı verir, iç CREATE/CREATE2'yi vermez. “Yeni görülen adres/kontrat” ancak genesis'ten ilgili bloğa eksiksiz tarama varsa ilk görülme olarak tanımlanır. Hourly/daily seri için UTC sınırları, resume/continuity checkpoint'i, eksik blok tespiti ve kapsam bayrağı gerekir; deterministic finality için reorg detection veya rollback gerekmez. Event sırası `(blockNumber, logIndex)` ile kurulur, timestamp ile değil. Önceki 50 blok örneği ağın günlük ortalaması değildir.

### 13.2 Genel token motoru ve doğrulanmış önemli varlıklar

Genel keşif, tüm emitter'lar için `Transfer(address,address,uint256)` log'unu bounded blok aralıklarında tarar; emitter'ı otomatik ERC-20 saymaz. Kod, `symbol()`, `name()`, `decimals()`, `totalSupply()` için `eth_call`, ERC-165/ABI/proxy kanıtı ve gerçek receipt örnekleriyle kimliklendirilir. Metadata çağrısı başarısızsa `unknown/unverified` kalır; veri tipi/string dönüşleri ve değişken proxy implementation geçmiş bloğa göre saklanır. Token başına ilk görülen blok, raw transfer sayısı/miktarı, farklı gönderen/alıcı, `0x0` mint/burn, yeni aktif/trending token ve pencereli aktif adres sayısı RPC indeksinden türetilebilir. “Holder count” son bakiyeye ulaşan **tam ve güvenilir geçmiş** veya sözleşme enumerable view olmadan güvenilir değildir; transfer sayısı holder sayısı değildir. USD fiyatı, USD hacmi veya piyasa değeri fiyat kaynağı ve zaman eşlemesi olmadan yayımlanmaz. Arc USDC'nin native 18 / ERC-20 6 decimals **aynı bakiye** olması genel token motorunun üstünde ayrı canonicalization kuralıdır: explicit transfer hacmi EIP-7708 system `Transfer` akışından gelir, ERC-20 arayüz akışı ikinci kez eklenmez; Zero5 öncesi legacy `NativeCoin` olayları tarihsel kapsam için ayrıca işlenir.

Güncel [Arc adres listesinde](https://docs.arc.io/arc/references/contract-addresses) doğrulanan varlıklar (aşağıdaki 5 adres için canlı `eth_getCode` boş değildi):

| Asset | Arc 5042 adresi | Decimals | Issuer / kategori | Kanıt ve sınır |
| --- | --- | ---: | --- | --- |
| USDC | `0x3600000000000000000000000000000000000000` | ERC-20 6; native 18 | Circle, dolar stablecoin / gas | `OFFICIAL_ADDRESS`, `RPC_VERIFIED`; çift yüz canonicalization zorunlu. |
| EURC | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` | 6 | Circle, euro stablecoin | `OFFICIAL_ADDRESS`, `RPC_VERIFIED`. |
| cirBTC | `0x171A4217b86A807A64eB94757Db6849fb4bDbAA0` | 8 | Circle, tokenized BTC | `OFFICIAL_ADDRESS`, `RPC_VERIFIED`; BTC fiyatı varsayılmaz. |
| WETH | `0x128cC466B61f542da60c70e3aA11c10e19B84EDB` | 18 | Wrapped/bridged ETH; operatör bu denetimde teyit edilmedi | `OFFICIAL_ADDRESS`, `RPC_VERIFIED`; redeem/bridge semantiği ayrıca doğrulanmalı. |
| USYC | `0x8a5D989Bbb96929F689B0200f435f53dA42bF490` | 6 | Circle International Bermuda, tokenized fund/RWA | `OFFICIAL_ADDRESS`, `RPC_VERIFIED`; transfer kısıtları/entitlement AUM tanımını etkiler. |

Arc [launch yazısı](https://www.arc.io/blog/arc-economic-os-internet) USDC/EURC yanında AUDD, AUDF, BRLA, CADD, CHFAU, EURAU, GBPA, JPYC, KRW1, MXNB, QCAD, SEKAU, TRYB, wARS, wBRL, wCLP, wCOP, wMXN, wPEN, ZARU olmak üzere **22 fiat/stablecoin adını**; ayrıca BUIDL, JAAA, JTRSY, USYC ve cirBTC'yi sayar. İlk 22'den yalnız USDC/EURC için bu audit Arc token adresi doğruladı. Diğerleri StableFX/onboarding ekosisteminde geçiyor diye Arc ERC-20 sözleşmesi veya canlı transfer metriği varsayılmaz. USYC, BUIDL, JAAA, JTRSY ayrı RWA bölümünde; cirBTC/WETH ile birlikte bu raporda **28 farklı adlandırılmış asset** incelendi (22 fiat/stable + cirBTC + WETH + 4 fon/RWA; USYC iki kez sayılmadı).

### 13.3 DEX, AMM, spot ve türev venue'ları

Resmi duyurularda 20 trading/DEX/aggregator adı incelendi: **Uniswap, Aero, Curve, 1inch, 0x, KyberSwap, Doppler, Bankr, Swapper, LI.FI, Alph, Definitive, Aster, edgeX, Extended, Hibachi, o1.Exchange, pools.trade, Pump.fun, fomo.** Bu bir işlem hacmi lig tablosu değildir. Uniswap için [resmi V4 Arc deployment](https://developers.uniswap.org/docs/protocols/v4/deployments) PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`, PositionManager `0x6049c9a0e26405C0985f9E3685C87d0aE917f82B`, UniversalRouter `0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1`; [Uniswap SDK address book](https://github.com/Uniswap/sdks/blob/main/sdks/sdk-core/src/addresses.ts) V3 factory `0xf0db7b58379503491d857db50ac9ece64c653918` adresini yayımlar. PoolManager ve V3 factory'de `eth_getCode` boş değildi. V3 için factory `PoolCreated` → doğrulanmış pool adresi → pool `Swap`/`Mint`/`Burn`; V4 için tek PoolManager'da `Initialize`/`Swap`/`ModifyLiquidity` + `PoolId` izlenir. ABI, token sırası, hook ve fee ayrımı gerekir. Swap sayısı/quote-token raw hacim ve likidite **doğrulanmış** havuzlardan türetilebilir; USD hacmi için tarihsel fiyat gerekir. Pool event sender/router her zaman nihai trader değildir; unique trader, fee ve protokol pazar payı tam kapsam/tanım olmadan verilmez.

Diğer 19 ad resmi ekosistem listesinde olsa da bu audit onların Arc factory/router/pool manager adresi ve swap ABI'sini **doğrulamadı**. `0x` ve 1inch gibi aggregator route'ları underlying DEX swap'larıyla çift sayılmamalı. [0x API](https://docs.0x.org/docs/upgrading/upgrading-to-swap-v2) key istediğinden veri kaynağı değildir. Aero/Curve/KyberSwap/Doppler/Bankr/Swapper/LI.FI ve diğerleri için factory ve event registry doğrulanana kadar swap count, pair, liquidity, volume, user ve market share `unavailable`.

Aster, edgeX, Extended, Hibachi, o1.Exchange, pools.trade ve Definitive için Arc duyurusundaki entegrasyon adı, orderbook/perp işleminin zincir üstünde olduğu anlamına gelmez. Depozito, çekim veya settlement yalnız doğrulanmış Arc kontratı ve event'i varsa sayılır; **pozisyon, açık faiz, likidasyon, işlem hacmi veya kullanıcı** verisi offchain matching/başka zincir nedeniyle Arc RPC'den çıkarılamayabilir. Bu 7 ad yukarıdaki 20'nin alt kümesidir, ayrıca sayılmadı. Bir venue için settlement event doğrulansa bile orderbook volume'u değildir.

### 13.4 Aave V4, Morpho ve vault/curator keşfi

[Aave V4 changelog](https://www.aave.com/docs/resources/changelog) Arc mainnet'in **V4** olduğunu ve Core Hub, Main Spoke, Forex Spoke ile USDC/EURC/cirBTC/WETH varlıklarını açıklar; V3 Pool/aToken adresleri varsayılmamalı. Anahtarsız `https://api.v4.aave.com/graphql` canlı `chains` sorgusu Arc 5042'yi, `hubs` Core Hub `0x17288dfc86205301064577b98B02b81017e6F79C` ve `spokes` Main `0xB843bdC3a87A05E77E07Df9FE48928b3A34b134d`, Forex `0x4164EBCAF74670aa74C8D4F59de6157c0780F1bB` adreslerini döndürdü; üçünde de RPC kodu vardı. V4 Hub/Spoke reserve view'ları ve doğrulanmış supply/borrow/repay/liquidation event'leriyle asset bazında supplied, borrowed, available liquidity, utilization, rate, collateral ve flows potansiyel olarak RPC'den çıkarılabilir. Rate/TVL için V4 accounting, scaled balance ve snapshot bloğu gereklidir; bu fazda sayısal metrik üretilmedi. GraphQL discovery/reconciliation yardımcısıdır, mutlak doğruluk veya kalıcı servis garantisi değildir.

[Morpho public GraphQL](https://docs.morpho.org/developers/api/get-started/) `https://api.morpho.org/graphql` Arc 5042'yi destekler. Anahtarsız canlı `vaults(first:1000,where:{chainId_in:[5042]})` **0 V1**; `vaultV2s(first:1000,where:{chainId_in:[5042]})` **31 V2 kaydı** döndürdü. Bu sayı **aktif veya üretim vault sayısı değildir**; unlisted/test/tekrarlanan adlar içerir. [Morpho vault API](https://docs.morpho.org/developers/api/morpho-vaults/) REST listeleme filtrelerinin unlisted vault'ları dışlayabildiğini gösterir; GraphQL adres + chain ile keşif, `eth_getCode`, vault factory/event ve underlying market/allocator sorgularıyla doğrulanmalıdır. Public API hesap/API key istemez, fakat resmi docs'a göre SLA yoktur ve standard rate limit 750 requests/minute'tır; cache/fallback gerekir. RPC/onchain canonical kaynaktır; API yoksa tüm veri `complete` sayılamaz. Supply/borrow, allocations ve market risk verisi vault TVL ile aynı şey değildir; APY API'nin güncel/yıllıklaştırılmış türevidir, tarihsel realized yield değildir.

İncelenen **9 lending/vault aktörü**: Aave, Morpho ve 7 curator/ekosistem adı Galaxy, Gauntlet, Keyrock, Steakhouse, Bitwise, Cumberland, Dialectic. Morpho'nun canlı listesinde adres bazında Galaxy USDC `0x8E357432CC12ff425c36432F312968aEb16112AF`, Galaxy EURC `0x389abDf4355e0cF4f19298179991705a98f21c18`, Gauntlet USDC Prime `0xdECcd53BE5453215821184824B519E04C7e00bC7`, USDC Balanced `0x10AF7238C6355Aa8dDB5eD60E2e9b55a72827B51`, EURC Prime `0x05863F54B05e96092069eF30c9Ca6060336e50B9`, Keyrock Prime USDC `0x5bEfAb92a5A3D60F578Cb51EEb4e4FD50a1e3123`, Dialectic RWA USDC `0x6bdfE1165D5165808d02dE05969c9a19e9b7cf30`, Bitwise Premium RWA USDC `0x7610094B846657dCF166D59e42973db52c7015F9`, Steakhouse Prime USDC `0xbeef0016cb2Fd5C352ea7CA08a9f54739DFa7298` ve EURC `0xbeef00be37BdE921BAE06fad223125BAB16c41D1` görüldü. Bu API kimliği + onchain kod/event/underlying doğrulaması olmadan “verified active vault flow” değildir. Cumberland adına özgü Arc vault adresi bu audit'te teyit edilmedi. Pangolins, KPK ve Flowmark gibi başka API listelenmiş vault'lar da keşif adaylarıdır. **Earn UI'ın iki selected vault allowlist'i değiştirilmez**; Intelligence daha geniş vault evrenini ayrı read model'de izler. Deposit/withdraw/net flow, unique depositor ve share/underlying `Deposit`/`Withdraw`/allocation event'leri gerçek deployed ABI + receipt ile doğrulanır; available liquidity pozisyona özel çekim limiti değildir.

### 13.5 Launchpad, meme ve token creation

İncelenen **12 launchpad/factory adayı**: Pump.fun, Argus, RadarDEX, Tolly, Warp, Archemist, PEGD, Minara, ArcPad, Load.fun, Parabola, Openlaunch. Bitquery'nin [Arc launchpad sözleşme/event kataloğu](https://docs.bitquery.io/docs/blockchain/arc-mainnet/arc-mainnet-launchpads-api/) yalnız **adres keşif ipucudur**; Bitquery API production kaynağı olarak reddedilir. Aşağıdaki adreslerde canlı `eth_getCode` boş değildi; bu tek başına launch veya swap olayının canlı doğrulaması değildir:

| Platform | Factory / launcher Arc adresi | Kanıt durumu ve keşif sınırı |
| --- | --- | --- |
| Argus | `0xb021be536808f551b31789422fd28a6c9c6e97da` | `RPC_VERIFIED`; [Argus repo](https://github.com/arguspad/argus-world/blob/main/README.md) da adresi yayımlar. |
| RadarDEX Classic / Reflection | `0x4b638c1502a07a8e1a26112ee98f51a3f34bc93a` / `0x2d933ce4bde6f3d99540b5d7886b383e59b2b2f8` | `RPC_VERIFIED` iki fabrika; farklı event semantiği ayrı doğrulanmalı. |
| Tolly | `0xcad7ee36ac193bf2eddb7b3e2736c5bdb8269c8b` | `RPC_VERIFIED`; [Tolly contracts](https://github.com/TollyLabs/v3-contracts) adres doğrulama kaynağı. |
| Warp | `0x0dcad158e98bc24455f9e94f46709d8a5f6d1255` | `RPC_VERIFIED`; [Warp](https://circlewarp.fun/) proje kaynağı. |
| Archemist V2 | `0x297cebc4de347347205cd08667b56ee951dd8810` | `RPC_VERIFIED`; [protokol dokümanı](https://archemist.fun/docs) ABI doğrulaması için. |
| PEGD V4 | `0xd0aa679ec263e8f9bc929426eb9eab2e061d2c5f` | `RPC_VERIFIED`; factory/event ABI için bağımsız protokol doğrulaması bekliyor. |
| Minara | `0xb6c6f77ee74af874a183bfd77dd0176d1ac91de6` | `RPC_VERIFIED`; [adres keşif kaynağı](https://docs.bitquery.io/docs/blockchain/arc-mainnet/minara-launchpad-api/), ABI/olay ayrıca doğrulanmalı. |
| Openlaunch | `0x815542E8b392389A1389E22E588E4B62A67Ade72` | `RPC_VERIFIED`; [proje deployment dokümanı](https://github.com/Gitlawb/openlaunch/blob/main/contracts/docs/LAUNCHPAD.md). |
| Pump.fun / ArcPad / Load.fun / Parabola | Doğrulanmış factory adresi yok | Pump.fun `ECOSYSTEM_LISTED`; [ArcPad](https://arcpad.meme/docs) mainnet iddiası ayrı RPC kanıtı ister; Load.fun `UNVERIFIED`; [Parabola](https://parabola.meme/) “coming soon” = `ANNOUNCED`. |

Genel yöntem: doğrulanmış **factory + versioned launch event** ile token/creator/launch zamanı; yaratılan token kodu ve metadata; sonra doğrulanmış pool/factory üzerinden ilk gerçek trade, quote-asset raw volume, trader ve likidite. Graduation/migration ancak sözleşmenin gerçek event/ABI'siyle sayılır. 1h/24h/7d launch sayısı ve pazar payı yalnız kapsanan factory set'i ve tam blok aralığıyla verilebilir; “tüm Arc launchpad pazarı” ifadesi bu listeden çıkmaz. Token survival/activity zaman penceresi açık tanımlanır. Rastgele token girişi+çıkışı swap/launch değildir.

### 13.6 Bridge, crosschain ve StableFX

İncelenen **12 entegrasyon ailesi**: Circle CCTP V2, Circle Gateway, LI.FI, RhinoFi, Socket/Bungee, Stargate, LayerZero, Across, Eco, Fast, Relay, Aleo/xReserve. Arc [interop yazısı](https://www.arc.io/blog/introducing-interop-on-arc-crosschain-liquidity-without-the-complexity) CCTP, Gateway ve Forwarding Service'i ayrı ürünler olarak açıklar. [Resmi Arc kontrat listesi](https://docs.arc.io/arc/references/contract-addresses) CCTP TokenMessenger `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`, MessageTransmitter `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`, GatewayWallet `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`, GatewayMinter `0x2222222d7164433c4C09B0b0D809a9b52C04C205` ve Arc CCTP domain 26'yı verir. CCTP'nin Arc inbound/outbound sinyali Bölüm 4/6'da canlı örneklendi; crosschain tamamlanma için karşı zincir olayları ve message eşleştirme gerekir. Gateway tek CCTP burn/mint sayacı değildir; Gateway destekli asset/zincir kapsamı route bazında doğrulanır. Forwarding Service'in özel routing semantiği ayrıca incelenir.

[Across chain listesi](https://docs.across.to/chains-and-contracts) Arc 5042'yi desteklenen chain olarak listeler; tam SpokePool adresi/ABI bu audit'te doğrulanmadığından flow yok. Arc resmi ekosistem yazısı diğer entegrasyonları sayar ama **Arc settlement kontratı** adresini vermez. LI.FI/Socket/Bungee aggregator olarak alttaki CCTP/Across/Stargate'i yönlendirebilir; bunları ayrı ekonomik transfer diye tekrar saymak hatadır. Protocol-specific emitter, asset, source/destination domain, fee ve mesaj kimliği doğrulanmadan inflow/outflow/net/users/fees `unavailable`. RhinoFi, LayerZero ve Aleo/xReserve için offchain/başka chain bacağı Arc RPC'de görünmeyebilir.

Arc [resmi adres listesinde](https://docs.arc.io/arc/references/contract-addresses) StableFX `FxEscrow` `0xe2E5F173576B513d994073CCbDaCBE027d43DFe6` adresi vardır ve RPC kodu boş değildi. Bu settlement kontratı, RFQ teklifleri veya tüm FX işlem hacminin public olduğu anlamına gelmez. Verified event/ABI ve token adresleri olmadan pairs, currencies, trades, settlement volume, unique participants yayımlanmaz. Fiat/stablecoin isimlerini Arc'da aktif FX çifti kabul etmeyin; özel/offchain fiyat pazarlığı ve gizlilik mümkün.

### 13.7 CEX, RWA ve Arc'a özgü activity

[Arc mainnet launch](https://www.arc.io/blog/arc-economic-os-internet) içinde incelenen **20 CEX adı**: Binance, Bitrue, Bitso, Bitvavo, Bybit, Coins.ph, Gate, Kraken, KuCoin, LBank, MEXC, Mobee, OKX, OSL, Paribu, PDAX, SwissBorg, Tokocrypto, Upbit, Wenia. Coinbase “soon” olarak geçer; canlı 20'ye eklenmedi. Duyuru “Arc CEX hot/deposit wallet adresi” vermez. Adres ownership'i tahmin etmeyin; doğrulanmış exchange adres listesi olmadan Arc onchain CEX giriş/çıkış/netflow `unavailable`. Offchain market verisi ayrı domain'dir: anahtarsız [Kraken public ticker](https://docs.kraken.com/api-reference/market-data/get-ticker-information) `GET https://api.kraken.com/0/public/Ticker?pair=USDCUSD` canlı HTTP 200 ve `USDCUSD` sonucu verdi; fiyat/spot veri bu endpoint ve pair kapsamıyla sınırlıdır, Arc deposit veya Arc USDC fiyatı kanıtı değildir. Diğer 19 borsanın public endpoint şartları bu audit'te tek tek canlı doğrulanmadı; veri motoruna otomatik eklenmez.

**4 tokenized fund/RWA adı:** USYC, BUIDL, JAAA, JTRSY. USYC'nin yukarıdaki resmi Arc adresi ve kodu var; transfer/mint/burn ve doğrulanmış entitlement/teller sözleşmesi üzerinden onchain supply hareketi potansiyel olarak ölçülür. `totalSupply` doğrudan fon AUM/USD değeri değildir; transfer kısıtları ve entitlement semantiği gerekir. BUIDL/JAAA/JTRSY [resmi launch yazısında](https://www.arc.io/blog/arc-economic-os-internet) anılır fakat bu audit Arc mainnet token adreslerini doğrulamadı; onchain supply/holder/flow `unavailable`. Private RWA kayıtları public RPC'de görünmeyebilir.

**6 Arc-specific sinyal alanı:** (1) StableFX settlement; (2) ERC-8004 agent identity/reputation/validation; (3) x402 tarzı HTTP ödemeleri; (4) sponsored transactions; (5) transaction memos; (6) Gateway/ödemeler. [Resmi Arc adreslerinde](https://docs.arc.io/arc/references/contract-addresses) ERC-8004 IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, ReputationRegistry `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, ValidationRegistry `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58`, Memo `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` yayımlanır. IdentityRegistry'de RPC kodu boş değildi. Registry event'leri doğrulanırsa registration/attestation sayılır; tüm “agentic activity”ye eşit değildir. x402 HTTP request/response çoğu kez offchain'dir; public settlement yalnız alt sınır verir. Sponsored tx için gerçek sponsor/paymaster sözleşmesi ve fee payer semantiği gerekir; gas payer'dan özne tahmini yapılmaz. Memo event'i varsa kodlanmış memo varlığı ölçülür; private içerik veya ödeme amacı varsayılmaz.

### 13.8 Harici ücretsiz veri kaynağı denetimi

`ACCEPT_OPTIONAL` yalnız canlı anahtarsız endpoint'in bugün erişildiği ve kullanım koşullarının uygun olduğu anlamına gelir; SLA/sonsuz rate garantisi değildir. Bu kaynaklar Arc RPC + doğrulanmış kontratların yerine geçmez. Hesap/API key/kart/trial/ücretli plana zorlayan kaynaklar `REJECTED_PAID_OR_SIGNUP`; ticari/rekabetçi kullanım veya yeniden yayımlama koşulları uygun olmayan kaynaklar `REJECTED_LICENSE_OR_TERMS`. Kaynak koşulu değişirse otomatik `unavailable`, kullanıcıya key/plan talebi yok.

| Source | No signup? | No API key? | Free production use? | Arc supported? | Useful metrics | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| [Arc public RPC](https://docs.arc.io/arc/references/connect-to-arc) | Evet | Evet | Public, kota/SLA garantisiz | Evet, canlı 5042 | Canonical block, receipt, log, contract view | `ACCEPT_CORE` |
| [Morpho public GraphQL](https://docs.morpho.org/developers/api/get-started/) | Evet | Evet | Public; SLA yok, standard limit 750 requests/minute; cache/fallback gerekir | Evet, canlı 31 V2 kayıt | Vault discovery, anlık APY/asset/allocation; canonical Arc RPC | `ACCEPT_OPTIONAL` |
| [Aave V4 GraphQL](https://www.aave.com/docs/aave-v4/getting-started/graphql) | Evet | Evet | Public docs/endpoint; kullanım koşulu değişebilir | Evet, canlı 5042 | Hub/Spoke discovery, reserve/rate reconciliation | `ACCEPT_OPTIONAL` |
| [DefiLlama public API](https://api-docs.defillama.com/) `api.llama.fi/chains` | Evet | Evet | Public HTTP yanıtı görülse de mevcut Terms ticari/rekabetçi kullanım ve yeniden yayımlamayı kısıtlıyor | Evet, canlı Arc row | Production veri kaynağı olarak kullanılmaz; subscription/API plan istenmez | `REJECTED_LICENSE_OR_TERMS` |
| [Kraken public market data](https://docs.kraken.com/api-reference/market-data/get-ticker-information) | Evet | Evet | Public ticker, rate/policy değişebilir | Arc değil; USDCUSD pair | Offchain ticker/spot bağlamı | `ACCEPT_OPTIONAL_OFFCHAIN` |
| [Bitquery](https://docs.bitquery.io/docs/authorization/how-to-generate/) | Hayır | Hayır | Points/plan gerekir | Arc API var | Launchpad/DEX hazır sorgu | `REJECTED_PAID_OR_SIGNUP` |
| [The Graph Gateway](https://thegraph.com/subgraphs/) | Hayır | Hayır | Key/account ve paid kullanım riski | Subgraph'a bağlı | Event index | `REJECTED_PAID_OR_SIGNUP` |
| Dune, Alchemy, QuickNode, Goldsky, Envio, Pinax ve benzeri hosted indexer | Hesap gerektirir veya bu audit'te aksine kanıt yok | Key/endpoint credential gerekir veya doğrulanmadı | Ücretsiz, kayıtsız production garantisi yok | Ürüne göre | Hosted index/backfill | `REJECTED_PAID_OR_SIGNUP` |
| [0x Swap API](https://docs.0x.org/docs/upgrading/upgrading-to-swap-v2) | Key akışı | Hayır | Kayıtsız core kaynak değil | Venue integrasyonu ayrı konu | Quote/route | `REJECTED_PAID_OR_SIGNUP` |
| [Etherscan V2 Arc](https://docs.etherscan.io/supported-chains) | Hayır | Hayır | Arc planı değişiyor; mevcut Wallet Activity ayrı | Evet, credential ile | Tek adres txlist/tokentx | `REJECTED_PAID_OR_SIGNUP` core için |
| Explorer HTML / tahmini undocumented API | Belirsiz | Belirsiz | Doğrulanmadı | Sayfa var | Güvenilir API yok | `REJECTED_UNVERIFIED` |

### 13.9 Coverage matrix

Tablo **envanter ve uygulanabilirlik** gösterir, metric shipment veya canlı hacim iddiası değildir. `RPC?` = doğrulanmış ABI/contract ve tam aralık sonrası türetilebilir; `—` = bugün güvenilir değil. `Historical?` = self-indexer ile public RPC tarihsel derinliği ayrıca doğrulanır; “koşullu” tam genesis kanıtı değildir. `No auth/Free` primary source içindir. `P0/P1/P2` uygulama sırası, kapsamdan çıkarma değildir.

| Category | Protocol / Asset | Live on Arc? | Verified contracts? | Discovery source | Primary data source | No auth? | Free? | RPC derivable? | Metrics available | Historical possible? | Confidence | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Network | Blocks/tx/receipts/gas | Evet | RPC native | Arc RPC | Arc RPC | Evet | Evet | Evet | Block/tx/success/fee/top-level address | Koşullu | Yüksek, bounded | P0 |
| Network | Internal calls/new wallets | Belirsiz | Trace capability bilinmiyor | RPC/trace araştırması | Arc RPC | Evet | Evet | Kısmi | Top-level first seen; true wallet/internal unavailable | Koşullu | Düşük | P2 |
| Token engine | All ERC-20 candidates | Emitter'lar var | Her token ayrı | `Transfer` logs + code | Arc RPC | Evet | Evet | Evet, doğrulamadan sonra | Raw count/flow/mint/burn, verified metadata | Koşullu | Orta | P0 |
| Asset | USDC | Evet | Resmi adres + kod | Arc indexing docs + contracts | Arc RPC | Evet | Evet | Evet; EIP-7708 system stream | Canonical explicit transfers; ERC-20 arayüz ayrı; gas event değil | Koşullu; Zero5 legacy gerekli | Yüksek | P0 |
| Asset | EURC | Evet | Resmi adres + kod | Arc contracts | Arc RPC | Evet | Evet | Evet | Raw transfer/mint/burn | Koşullu | Yüksek | P0 |
| Asset | cirBTC | Evet | Resmi adres + kod | Arc contracts | Arc RPC | Evet | Evet | Evet | Raw transfer/supply | Koşullu | Yüksek | P0 |
| Asset | WETH | Evet | Resmi adres + kod | Arc contracts | Arc RPC | Evet | Evet | Evet | Raw transfer/supply | Koşullu | Yüksek | P0 |
| Asset | USYC | Evet | Resmi adres + kod | Arc contracts | Arc RPC | Evet | Evet | Evet, entitlement sonrası | Raw transfer/supply/mint/burn | Koşullu | Yüksek adres; AUM bekliyor | P1 |
| Asset | 20 other named fiat/stables | Ecosystem/onboarding | Hayır | Arc launch | Verified registry bekliyor | Evet | Evet | Bugün hayır | `unavailable` | Hayır | Düşük | P1 |
| RWA | BUIDL/JAAA/JTRSY | Resmi launch adı | Arc adresi yok | Arc launch | Verified registry bekliyor | Evet | Evet | Bugün hayır | `unavailable` | Hayır | Düşük | P1 |
| DEX/AMM | Uniswap V3/V4 | Evet | Resmi address book + kod | Factory/PoolManager | Arc RPC | Evet | Evet | Evet, ABI sonrası | Pool/swap/raw quote volume/liquidity | Koşullu | Yüksek adres; event audit bekliyor | P0 |
| DEX/spot | Aero/Curve/KyberSwap | Ecosystem listed | Arc registry yok | Arc launch | Registry + Arc RPC | Evet | Evet | Bugün hayır | `unavailable` | Hayır | Düşük | P1 |
| DEX/aggregator | 1inch/0x/LI.FI/Swapper | Ecosystem listed | Arc registry yok | Arc launch | Arc RPC; key'li API reddedildi | Evet | Evet | Bugün hayır | Underlying swaps ile çift sayım riski | Hayır | Düşük | P1 |
| DEX/launch trading | Doppler/Bankr/Alph/fomo/Pump.fun | Ecosystem listed | Arc swap registry yok | Arc launch | Registry + Arc RPC | Evet | Evet | Bugün hayır | `unavailable` | Hayır | Düşük | P1 |
| Perps/trading | Aster/edgeX/Extended/Hibachi/o1.Exchange/pools.trade/Definitive | Ecosystem listed | Arc settlement adresi yok | Arc launch | Verified Arc settlement bekliyor | Evet | Evet | Kısmi/belirsiz | Offchain OI/volume unavailable | Hayır | Düşük | P2 |
| Lending | Aave V4 | Evet | Hub + iki Spoke kodu | Official V4 + public GraphQL | Arc RPC; GraphQL yardımcı | Evet | Evet | Evet, V4 ABI sonrası | Supply/borrow/rates/flows/liquidation | Koşullu | Yüksek deployment | P0 |
| Lending/vault | Morpho V2 | Evet | Galaxy/Gauntlet bilinen kod; tüm 31 değil | Public GraphQL + factory | Arc RPC; GraphQL yardımcı | Evet | Evet | Evet, per vault | Shares/assets/flows; API APY | Koşullu | Orta/yüksek | P0 |
| Vault | Galaxy/Gauntlet | Evet | İki Earn adresinde kod | Earn config + Morpho | Arc RPC; Morpho API | Evet | Evet | Evet, ABI sonrası | Deposits/withdrawals; current APY via API | Koşullu | Yüksek kimlik | P1 |
| Vault | Keyrock/Steakhouse/Bitwise/Dialectic | Morpho API'de adresler | API adresi; kod/ABI tümünde test edilmedi | Morpho GraphQL | Arc RPC; Morpho API | Evet | Evet | Koşullu | Per-vault flow/rate ancak doğrulanınca | Koşullu | Orta | P1 |
| Vault | Cumberland | Ecosystem listed | Vault adresi yok | Arc launch | Verified registry bekliyor | Evet | Evet | Bugün hayır | `unavailable` | Hayır | Düşük | P1 |
| Launchpad | Argus/RadarDEX/Tolly | Deployed | Factory kodu var | Project repos + address clues | Arc RPC | Evet | Evet | ABI sonrası | Launch count/token/creator | Koşullu | Orta | P1 |
| Launchpad | Warp/Archemist/PEGD/Minara/Openlaunch | Deployed | Factory kodu var | Project docs + address clues | Arc RPC | Evet | Evet | ABI sonrası | Launch count/token/creator | Koşullu | Orta | P1 |
| Launchpad | Pump.fun/ArcPad/Load.fun/Parabola | Listed/claim/unknown/announced | Factory doğrulanmadı | Arc + project sites | Verified registry bekliyor | Evet | Evet | Bugün hayır | `unavailable` | Hayır | Düşük | P1 |
| Bridge | Circle CCTP V2 | Evet | Resmi kontratlar + örnek log | Arc contracts | Arc RPC | Evet | Evet | Evet, Arc leg | Burn/mint/domain/fee; crosschain finality ayrı | Koşullu | Yüksek | P0 |
| Bridge | Circle Gateway | Evet | Resmi wallet/minter | Arc contracts | Arc RPC | Evet | Evet | ABI sonrası | Gateway settlement; CCTP'den ayrı | Koşullu | Orta/yüksek | P0 |
| Bridge | Across | Official chain list | Tam SpokePool adresi doğrulanmadı | Across docs | Registry + Arc RPC | Evet | Evet | Bugün hayır | `unavailable` | Hayır | Orta entegrasyon | P1 |
| Bridge | LI.FI/RhinoFi/Socket-Bungee/Stargate/LayerZero/Eco/Fast/Relay/Aleo-xReserve | Ecosystem listed | Arc settlement registry yok | Arc launch | Verified contracts bekliyor | Evet | Evet | Bugün hayır | `unavailable`; aggregator double-count riski | Hayır | Düşük | P1 |
| FX | StableFX | Resmi kontrat | FxEscrow kodu var | Arc contracts | Arc RPC | Evet | Evet | ABI sonrası, settlement only | Public settlement; RFQ/pairs belirsiz | Koşullu | Orta | P1 |
| CEX flow | 20 named exchanges | Ecosystem listed | Owned Arc wallet yok | Arc launch | Verified address registry bekliyor | Evet | Evet | Bugün hayır | Arc inflow/outflow unavailable | Hayır | Düşük | P2 |
| CEX market | Kraken USDCUSD | Offchain public | Arc kontratı ilgili değil | Kraken public docs | Public ticker API | Evet | Evet | Hayır | Offchain ticker; Arc flow değil | API history ayrı | Yüksek endpoint | P2 |
| Agent | ERC-8004 | Resmi registry | Adresler; Identity kodu var | Arc contracts | Arc RPC | Evet | Evet | ABI sonrası | Registration/reputation/validation | Koşullu | Orta | P2 |
| Payment | x402/sponsored/memo | Kısmi | Memo resmi; diğerleri belirsiz | Arc contracts + integration docs | Arc RPC | Evet | Evet | Kısmi | Memo event; x402 HTTP offchain | Koşullu | Düşük/orta | P2 |

### 13.10 Phase 1'in güncellenmiş sırası ve sınırları

**P0:** Generic Arc block/receipt/log ilerletici + provenance/completeness; generic token emitter keşfi/metadata doğrulaması ve USDC için canonical EIP-7708 system akışı (Zero5 öncesi legacy `NativeCoin` dahil); resmi büyük asset registry; Uniswap V3/V4 factory/pool registry decoder; Aave **V4** Hub/Spoke ve Morpho V2 vault/market registry; CCTP ve Gateway'i ayrı flow modelleri. Önce kısa gerçek receipt/event fixture'ları, sonra bounded backfill ve saatlik/günlük tanım. Hiçbir metrik eksik blok veya eksik protokol listesiyle “Arc toplamı” sunulmaz.

**P1:** Yeni vault'lar ve curator registry, diğer DEX/aggregator adresleri, doğrulanmış launchpad factory/event keşfi, diğer bridge settlement'ları, StableFX ve USYC/diğer RWA. Her protokol decoder'ı versioned ABI/address/effective block range ve kaynak kanıtı taşır. Yeni kaynak yalnız ücretsiz, anahtarsız public erişime uygunsa eklenir.

**P2:** Perp settlement ile offchain orderbook ayrımı, doğrulanmış CEX-owned Arc adresleri varsa flow, public offchain market endpoint'leri, ERC-8004/x402/sponsored/memo ve long tail. Bu kategori kapsamdan çıkarılmış değildir; bugünkü güvenilir ölçüm boşlukları `unavailable` gösterilir.

Önerilen generic read model: `chain_blocks`, `transactions`, `logs`, `token_contracts`, `token_metadata_versions`, `protocol_contracts` (protocol/version/role/effective block), `protocol_events`, `markets/pools`, `vaults`, `asset_balances_or_snapshots`, `metric_series` (unit, denominator, source, block range, complete flag). Mevcut Bölüm 10 şemasının genişletmesidir; veritabanı/hosting kararı veya implementasyon değildir. Asset ve protokol modülleri aynı block/log çekirdeğini paylaşır; Bridge tracker Redis'i, Earn execution, Wallet Activity ve iki vault allowlist'i ayrı kalır. Morpho/Aave/Kraken gibi uygun anahtarsız API'ler yalnız discovery, reconciliation veya açıkça kaynaklı offchain bağlam için; canonical chain gerçeği RPC'dir. DefiLlama production/Phase 1 veri kaynağı değildir. Public RPC'nin backfill kotası/tarihsel bütünlüğü henüz ispatlanmadığından, eksik dönemleri otomatik tamamlanmış saymak veya kullanıcıdan ücretli provider istemek yasaktır.

`Machina Arc Intelligence must remain functional without any newly purchased, signup gated, trial gated, or API key gated data provider. Unsupported metrics remain unavailable rather than requiring the operator to buy or register for a data service.`
