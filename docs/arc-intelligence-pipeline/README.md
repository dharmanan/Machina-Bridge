# Independent Arc Intelligence implementation status

This is an **uncommitted, opt-in laboratory implementation**, based on
`4804ef7acc8bcb58dc4d9e3c785af0ae392a2b18`. It is not imported by the live service,
does not open production paths and does not activate recovery, indexing, archive
or backup jobs. Existing production source files and APIs remain unchanged.

The product scope is the immutable 84-field matrix in `product-scope.json`, SHA256
`644a73006433b128e79697d7346e43e2f9cc138147c5a52c740891e9caab9170`.
All eight pending fields remain required. `dependencies.json` records their source,
implementation work and unresolved dependency separately. DEX rankings must use
DEX USD volume; lending and bridge financial actions remain separate tables.

## Implemented, independently tested components

- Versioned source/range jobs, leases, durable piece results, exact checksums,
  transactional acceptance, restart/idempotency and corruption detection/repair.
- Network reduction from transient bodies into exact membership and sparse
  deployment attempts. A shared immutable address dictionary and compact hour
  membership replace permanently duplicated transaction spines. Temporary pieces
  can be removed only after independently checked committed hour evidence.
- Network 24H/7D/30D read model: exact distinct membership, no summed hourly unique
  counts, explicit partial coverage and null incomplete daily buckets. These are
  isolated component tests, not a replacement for existing Dashboard APIs.
- Creation receipts from verified sparse attempts; no full-body RPC re-download.
  Each receipt group commits before another read. Null historical individual
  receipts are not interpreted as absence: the tested block-receipt source is an
  explicit, separately versioned source method.
- V3/V4 bounded log reduction and reproducible derived family metrics. When an
  exported historical registry omits same-hour pools, new official factory events
  and only those pools' logs supplement preserved base evidence. Base and
  supplemental populations must be proven disjoint; missing source scopes or
  failed verification prevent completion. No amount is called USD or verified
  token identity without the still-required valuation/metadata source.
- Local consistent checksummed backups, empty restore, interruption retry and
  reconstruction of deliberately deleted derived DEX results from surviving
  verified children without RPC. No remote backup or off-volume durability claim.

## Real dense-hour measurements

Target: **2026-09-16 12:00 UTC**. Attached export SHA256 was rechecked:
`162159c877bdece326c1341e5b08784d9b783edb0389805ecb46985a7bb8ef67`.
Imported canonical evidence is opened read-only with `query_only=ON`.

Network: 7,107 blocks, 409,086 transactions, 61,325 active addresses and 432
deployment attempts match all stored canonical network fields. Latest v2 replay:
57 bounded pieces, 61,813-byte compressed final hour, 3,932,160 live page bytes.
Actual SQLite file is 15,130,624 bytes: 11,198,464 free-page bytes remain physically
allocated and reusable, **not** subtracted from disk use. Managed peak was
25,714,688 bytes. Sampled heap was 27,025,400 bytes; RSS 87,543,808 bytes.
This replay reused previously verified real RPC proof offline; it made no new RPC.

Creations: all 432 receipts completed; **431 successful, one failed deployment**.
The Arc block-receipt source returns a predicted address even for the failed
`status=0x0` deployment. That address is retained only as reported failure
provenance; the deployed address stays null and token identity stays unverified.
Six measured worker invocations (including interruption and a conservative
validator failure) consumed 400 HTTP/RPC requests, 174,225,334 response bytes in
total. Each invocation respected the original limits; largest invocation was
50,706,145 bytes / 119 requests / 118.114 seconds. Final invocation resumed 385
saved receipts, read 41 new blocks and completed all 432 without rereading those
accepted receipts. Final sampled heap 21,076,072 bytes. Separate small source
availability/validation probes are not included in that worker-only total.

V3/V4 initial log ingestion: 127 HTTP/RPC calls, 238,688,243 response bytes across
bounded invocations; largest invocation was 54,063,830 bytes. V4 used separate
runs of 18.210, 17.690, 16.612 and 10.142 seconds after an accepted-piece
interruption. Historical V3 export contains 15,521 pre-hour pools and **no**
same-hour pool rows; matching requires 320 factory-created pools during the hour.
Incremental supplementation consumed 21 HTTP/RPC calls / 9,533,131 bytes for
those pool groups, plus the separately measured factory proof. All eight V3 and
all five V4 family metrics match the exported canonical family values:

- V3: 47,334 swaps, 876 mints, 769 burns, 320 pool creations, 10,673 traders,
  847 pools with swaps, 28 foreign emitters and 3,415 foreign events.
- V4: 187,580 swaps, 4,901 initializes, 9,736 liquidity modifications,
  19,559 traders and 4,021 pools with swaps.

Maximum observed supplemental response was 6,292,059 bytes (<8 MiB), sampled
heap 35,492,480 bytes. RSS was 146,632,704 bytes (initial DEX run peaked at
153,579,520). Heap and process memory must not be conflated. A completed restart
then requested **zero log or factory-event responses**; six chain/code/header
preflight calls revalidated sources. Original records were preserved.

## Memory and resource enforcement

Run workers/tests with Node 24:

```sh
node --max-old-space-size=48 --max-semi-space-size=2 scripts/verify-arc-intelligence-pipeline.mjs
node --max-old-space-size=48 --max-semi-space-size=2 scripts/verify-arc-intelligence-network-window.mjs
node --max-old-space-size=48 --max-semi-space-size=2 scripts/verify-arc-intelligence-creation-reuse.mjs
node --max-old-space-size=48 --max-semi-space-size=2 scripts/verify-arc-intelligence-dex-reduction.mjs
node --max-old-space-size=48 --max-semi-space-size=2 scripts/verify-arc-intelligence-dex-family.mjs
```

Actual V8 hard heap limit is 56,623,104 bytes (54 MiB). Entry points refuse a
configured total heap >64 MiB before opening/creating files. The rejected earlier
whole-hour JS-set sealing prototype exceeded heap; it is not a passing result.
SQL-backed membership replaced it. Native SQLite/buffers/RSS remain separately
measured. Provider limits remain 64 MiB/run, 8 MiB/response, 512 HTTP requests,
20,000 RPC items and ten minutes. No limit was increased.

Real-data measurement commands require the independently imported `/tmp` proof
and laboratory databases, not production. In this Cloud environment retain the
inherited proxy/CA and set `NODE_USE_ENV_PROXY=1` for RPC scripts. Do not substitute
Railway volume paths. `measure-arc-intelligence-dex-reduction.mjs` accepts an
optional existing isolated DEX directory so successful units are reused. Its
`complete` field describes these raw source units, **not** all 84 product fields.

Latest directly relevant checks: **74 passing component checks** (29 kernel,
eight network windows, nine creation, six DEX reducer, five DEX derivation and
17 compact-storage scenarios). The actual dense-hour compaction adds 95 checks,
including an independent per-pool oracle comparing every amount, count, null,
status, earliest observed proof and latest state against original range results.
Local compact backup/empty restore adds 28 real-evidence checks. The definition
export validates 25,060 copied identities/rows; that is an assertion count, not
25,060 distinct tests or all-product acceptance. Node v24.19.0 and TypeScript/Vite
build passed. No new RPC was needed for these storage tests.

## Storage implementation and measured remaining blocker

Use `production-capacity.json`, preserving **all** currently used 1,978,695,680
bytes against the observed 4,838,498,304-byte ceiling. Main DB + WAL + SHM total
927,115,472 bytes; **1,051,580,208 bytes remain unattributed**. No production file
was deleted or presumed disposable. After a 536,870,912-byte safety reserve,
**2,322,931,712 bytes** remain for every new field, index, live growth, WAL and work
file. Read-only metadata inventory was prepared for the owner separately; this
agent did not access production.

Original dense-hour DEX file: 12,562,432 bytes; 11,681,792 page bytes belong to
range-result objects. Its 34,712 repeated pool rows contain 52,468,433 JSON bytes;
134 trader membership lists contain 3,186,316 JSON bytes. Keeping that file shape
for 720 dense hours would require 9,044,951,040 bytes before existing production,
other fields, WAL or reserve. **That permanent format remains rejected.**

`dex-hour-store.js` instead publishes checksummed hourly per-pool action counts
and exact raw amounts, earliest OBSERVED activity, latest pool states, verified
initialization records and exact trader/foreign-emitter membership. It retains
original source/definition/registry identities, canonical anchors and every
accepted segment input/result digest. This is not full transaction/event storage.
Intermediate per-range observations are not permanent historical output; the
retained first-observed/latest states and exact hourly aggregates were compared
with all original real pool rows before transient copies were removed.

Pool shards contain at most 128 rows. A bounded immutable symbol dictionary
shares addresses/hashes; a versioned binary JSON subset preserves number/string
identity, exact nulls and missing fields. Every object has an independently checked
SHA256 and a one-MiB decoded limit. Unknown fields require a new definition;
they cannot be dropped silently. The rowid BLOB layout reduces SQLite overflow
page waste. Compression alone was not the storage design or capacity proof.

Publication commits verified permanent shards and a seal before a separate
transaction can remove transient range objects. Failure, locks, low space or
crashes retain originals. A corrupt compact object makes coverage partial while
audit preserves the completed range/checksum ledger; it does not replay the whole
hour. Exact expected objects can be restored narrowly from a checked local copy.
Without an available valid object or authenticated seal, automatic repair still
needs a verified backup or targeted canonical RPC input; this dependency is not
claimed complete. No automatic archival/repair job is enabled.

An opt-in source-definition envelope preserves exact original JSON and hashes
while reducing repeated source/unit metadata. Old plaintext definitions remain
supported. A fresh disposable export verifies original identities before writing
this representation; no existing production record is rewritten. Factory fact
rows are a rebuildable index: they can expire only after their exact immutable
facts are verified in durable results; bounded audit reconstructs the cache with
zero RPC. Accepted factory proof remains permanently stored.

Actual final dense-hour DEX live pages, including the shared address dictionary:
**4,120,576 bytes**. These are live pages, NOT the physically allocated high-water
file size. Cleanup does not shrink a production SQLite file; all allocated pages,
WAL and work space remain capacity costs. The measured compact backup snapshot is
4,063,232 bytes, compressed parts 3,366,050 bytes. Empty restore and narrow shard
repair pass; neither proves independent remote backup durability.

### Physical 720-copy capacity workload

The test writes 720 physical copies of real dense-hour DEX shards, seals, retained
factory result, source/unit definitions and job metadata. No object deduplication
or estimated compression ratio is used. Its capacity container is NOT canonical
history and never feeds an API. Actual different 720-hour blockchain data, pool
novelty or all 84 fields have NOT been produced by this test.

- Physical SQLite file: **1,767,297,024 bytes**; 720/720 writes completed.
- Sampled first/middle/last object checksums: **1,323**; SQLite integrity passes.
- Measured shared address table/index: **1,458,176 bytes**, counted once only under
  the explicitly conditional identical-address-union scenario.
- Explicit reservations: 256 MiB live growth, 128 MiB additional WAL,
  128 MiB temporary work and 512 MiB safety reserve. These are operational budgets,
  not a measured twelve-month growth guarantee.
- Existing use + measured container + dictionary + those reservations:
  **4,821,192,704 bytes**. Remaining for ALL other unmeasured fields: **17,305,600**.
- If each hour introduces the measured hour's addresses anew, extrapolation from
  the measured dictionary/index cost yields **5,869,621,248 bytes** before other
  fields. This is an explicit novelty scenario estimate, not measured mainnet
  30D address growth or a proof that every compact architecture is impossible.

Even the previously measured 61,813-byte network seal repeated 720 times would
add 44,505,360 bytes, exceeding that 17,305,600-byte remainder before extra network
address novelty, creation evidence, valuations or other protocols. Therefore the
constant dense-hour full-product scenario DOES NOT meet capacity. Actual normal
versus dense-hour frequency, cross-hour address/pool novelty, remaining metric
storage and future growth still need measured bounds; none is silently excluded
from the 84-field scope. Earlier capacity containers stopped safely at 665 and
674 hours. Only those generated repetitive benchmark databases were removed after
recording results to reclaim local test space; original real RPC inputs and all
measurement reports remain preserved.

Reproduce storage checks (Node 24, disposable /tmp paths only):

```sh
node --max-old-space-size=48 --max-semi-space-size=2 scripts/verify-arc-intelligence-dex-storage.mjs
node --max-old-space-size=48 --max-semi-space-size=2 scripts/measure-arc-intelligence-dex-storage.mjs /tmp/machina-inventory/real-dex-final-restart-verification.json /tmp/machina-inventory/real-dex-final-storage-integrity.json
node --max-old-space-size=48 --max-semi-space-size=2 scripts/verify-arc-intelligence-compact-definitions.mjs /tmp/machina-inventory/real-dex-symbol-storage.json /tmp/machina-inventory/real-dex-rowid-storage.json
node --max-old-space-size=48 --max-semi-space-size=2 scripts/measure-arc-intelligence-storage-capacity.mjs /tmp/machina-inventory/real-dex-rowid-storage.json /tmp/machina-inventory/720-dex-rowid-capacity.json
node --max-old-space-size=48 --max-semi-space-size=2 scripts/verify-arc-intelligence-compact-backup.mjs /tmp/machina-inventory/real-dex-rowid-storage.json /tmp/machina-inventory/real-compact-backup.json
```

Actual dense-hour compaction sampled heap: **32,238,576 bytes**; configured V8
hard limit remains 54 MiB within the required 64 MiB maximum. RSS/native buffers
are separate and exceed 64 MiB; this is not a 64-MiB whole-process claim.

**Full-product/storage acceptance remains NO_GO.** The current compact candidate
improves storage and survives tested integrity/restart/local repair cases, but
cannot be declared a permanent five-GB solution for all 84 fields. Required API,
valuation, launch-source, complete real 24H/7D/30D acceptance, bounded future
storage and an approved independent durable backup remain incomplete. No paid
service, capacity upgrade, production access, new production database, commit,
push or deploy was performed.


# Independent backup dependency (no remote activation)

The user has no prepared independent durable target. `/tmp`, Codespaces and a
second directory on the same Railway volume are **not** independent production
backups. The implemented filesystem adapter verifies consistent snapshots,
checksummed compressed parts, empty-database restores and interrupted restores
locally only. No account, OAuth client, subscription or remote upload was created.

## Free options, checked against provider documentation on 2026-10-10

| Option | Free allowance | Automated operation | Capacity / durability limitation |
| --- | --- | --- | --- |
| Personal Google Drive | Up to 15 GB shared with Gmail/Photos | Drive API resumable uploads and offline OAuth are possible after user approval, client setup and actual quota verification | Best capacity candidate, not yet approved or tested. Shared usage, API quotas, authorization revocation and account availability must be monitored. |
| Dropbox Basic | 2 GB | API with app registration, scoped permissions and offline OAuth can automate uploads | Two accepted versions plus an in-flight current-sized uncompressed snapshot already exceed 2 GB. Actual full-DB compression is unmeasured; cannot qualify it yet. |
| GitHub Free Actions artifacts | 500 MB shared allowance | Scheduled workflows are possible | Current main SQLite alone is 817,713,152 bytes; compressed full-product size is unmeasured. Artifacts expire (90 days by default); cache can be evicted. Neither is currently a qualified durable complete backup target. |
| User-owned independent persistent disk | Capacity depends on hardware | A separately approved reachable host can receive scheduled copies | No ready target exists per the user. Do not assume access, availability or spare capacity. |

Google documents standard Drive API use as available at no additional cost;
increases beyond standard quotas are not part of this proposal. No paid quota or
billing activation is authorized. Use a narrow `drive.file` grant if an adapter
is approved. A testing-mode external OAuth application generally issues refresh
tokens expiring in seven days (Drive scopes do not get the basic-identity
exception). Sustainable unattended operation needs an appropriately published
OAuth client and expiration/revocation handling; a temporary test token is not an
operational backup design.

## Capacity is not established by the network-only compression result

Measured local one-hour network snapshot: 3,727,360 bytes before compression,
3,147,585 stored compressed bytes. This ratio does **not** describe the existing
production DB or all 84 fields. Its dictionary contains 61,325 addresses; future
novel addresses are not represented by a constant marginal-hour estimate.

User-reported production SQLite page footprint is 817,786,880 bytes. A capacity
planning envelope of two verified versions plus one new in-flight version is
3 × 817,786,880 = **2,453,360,640 bytes** before compression, manifests and margin.
This is arithmetic, not a measured future backup size. Actual consistent backup
size must be measured without modifying production and later with the complete
independent dataset.

At the observed volume ceiling, the deliberately pessimistic 3-copy envelope is
3 × 4,838,498,304 = **14,515,494,912 bytes**. An otherwise empty 15 GB Drive account
would leave only 484,505,088 decimal bytes before overhead; therefore no future
capacity guarantee follows. Existing account usage must be subtracted. A smaller
database and approved version-retention policy may fit, but must be measured.

Before any automatic remote backup: user approval of target, actual available
quota, complete-database size including indexes, verified remote download and
restore into an empty database, credential lifecycle and alerts. Retire an old
backup only after a new independent version is verified; never erase accepted
production history to make a backup fit. Finite free quota is not a guarantee of
unlimited permanent growth.

## Authoritative references

- [Google free storage allowance](https://support.google.com/drive/answer/2375123)
- [Drive API standard usage and quotas](https://developers.google.com/workspace/drive/api/guides/limits)
- [Drive resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Drive authorization scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [OAuth refresh-token expiration](https://developers.google.com/identity/protocols/oauth2)
- [Dropbox Basic allowance](https://help.dropbox.com/plans/dropbox-basic-faq)
- [Dropbox offline OAuth](https://developers.dropbox.com/oauth-guide)
- [GitHub Actions included limits](https://docs.github.com/en/actions/reference/limits)
- [GitHub artifact expiration](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/remove-workflow-artifacts)
