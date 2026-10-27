# Fast tools and cache behavior

All 68 existing tools remain available. Five new tools bring the total to 73. Every tool result includes timing in `_meta.elapsed_ms`; JSON object results also include `elapsed_ms` in their text/structured payload. Existing array and image content shapes remain intact.

## Search, menus and photos

- `search_items_everywhere(queries, vendor_type?, open_now=true, in_stock_only=false, max_distance_km?, max_vendors=60, cursor?, vendor_ids?)` matches every synonym locally against each fetched menu. It normalizes 3-in-1 / 3 in 1 / 3in1, cable/cord/catalogue CHORD spelling and USB-C/type-C, ranks names above categories and option-group names, and returns main menu items only. `max_vendors` accepts 1–200 per call. Optional `vendor_ids` selects up to twenty known vendors, avoiding unrelated menu reads for repeat searches or focused comparisons. Coverage is then explicitly scoped to those IDs. Supply the returned `next_cursor` with the same queries, address and filters until it is null. A call can finish early when its request budget is low; it retains successful matches and reports `coverage_complete:false` and pending vendors. Unknown types return `invalid_vendor_type` plus valid values; `shop` explicitly aliases `supermarket`.
- `get_menu_slim(vendor_ids, category?, in_stock_only=true, include_images=true)` returns complete matching item lists with IDs, names, prices in naira, stock, descriptions capped at eighty characters, first image URLs and required option groups. Each vendor has independent failure handling and `option_groups_complete`; never infer missing options from incomplete data.
- `get_food_images_batch(items, limit_per_item=1)` returns URLs only. Supported encoded Chowdeck transformations are decoded to validated public object URLs. Existing image-download safeguards remain in the original `get_food_images` tool.

Search uses six concurrent vendor loads to avoid starving the Worker's six outbound connection slots. Each first attempt has a three-second upstream menu/detail deadline. A transient failure can be retried on a later cursor page with an eight-second deadline, up to three attempts; searches do not hide automatic network retries inside a single API call. Normal slim-menu reads retain concurrency twelve and the three-second deadline. Failures are isolated and successful matches are retained.

Search returns per-page `vendors_checked`, `vendor_ids_checked`, `vendors_skipped`, `vendors_incomplete`, `skip_reasons` (`closed`, `distance`, `cap_reached`, `budget`, `error`), `subrequests` and `elapsed_ms`. Cumulative `vendors_checked_total` and `eligible_vendors_discovered` expose traversal progress. `undiscovered_vendors_remaining` means upstream listing still has pages, so pending counts are lower bounds. Skip-reason counts describe this page; pending vendors can appear again on another page. `errors` identifies unresolved failures; these prevent complete-coverage claims even when no cursor remains.

Cursors expire after fifteen minutes and are scoped to the queries, normalized type, location and filters. The per-call vendor cap can change between cursor pages. Merge and deduplicate returned matches by `(vendor_id, item_id, matched_query)` because partially inspected vendors may be revisited. Reusing a cursor safely replays its read-only page; it never changes a cart.

`CHOWDECK_WORKERS_PLAN` selects a conservative ceiling (`free`: 50, `paid`: 1000), and `CHOWDECK_SUBREQUEST_LIMIT` can lower it. Eight external requests are reserved for runtime overhead. API retries/auth refresh share the invocation counter, and search rejects redirects instead of following uncounted hops. Cache operations use a separately counted internal-service budget. With D1 this budget is also 42 on Free, below the separate 50-query invocation ceiling. Bulk SQL operations are counted once; ordinary reads, writes and deletes are counted individually.

A two-minute result-page cache accelerates repeated identical first-page searches; `result_cache_hit` and `vendors_from_result_cache` distinguish this from actual `cache_hits` on menu reads. Active background menu revalidation and favourite prewarming are suppressed during a budgeted search so they cannot outlive its budget. Normal refresh/read paths retain background cache warming.

Some root menus refer to retired option groups. A successful item-detail response with an explicit modifier list establishes active membership; retired references do not force endless incomplete results. Failed or malformed detail responses never establish absence.

## Cache and consistency

Cloudflare D1 stores normalized menus for ten minutes under vendor ID plus latest observed item `updated_at` and a content hash. A head index selects the current version; replaced versions are removed. Warm-isolate memory caches and single-flight requests reduce repeat reads. Open vendor lists are cached for two minutes, scoped to address and filters.

An observed vendor menu revision invalidates its cached menu. Menus older than sixty seconds are revalidated in the background when a Worker context is available. There is no upstream change subscription: a change is detected on a revision observation, background check or expiry, not instantly when Chowdeck changes it. Checkout always fetches fresh item, option and vendor data. Favourite menus are prewarmed in the background whenever the hosted account session is successfully refreshed; cache failures do not block renewal.

Deploy with the `MCP_STORAGE` D1 binding and initialize `hosting/d1-schema.sql`. `CHOWDECK_CACHE` is the adapter object used by the cache code, not a Workers KV namespace. The SQL adapter bulk-loads keys with one indexed query and batches each menu with its version head. A separate D1 query budget reserves capacity for the continuation checkpoint. Local stdio operation uses memory caching when no persistent adapter is configured. See [persistent storage setup](mcp/D1-STORAGE.md).

## Fast checkout

`quick_order` accepts vendor, items (`menu_id`, `qty`, optional choices), address label, optional gift recipient and rider note, payment method (wallet by default), spending cap and a stable idempotency key. `confirm` defaults to false. A dry run obtains a live fee/discount quote without creating, deleting or updating a cart. It never places or pays an order.

To purchase, obtain explicit approval of the returned address, recipient, items, method and exact total, then supply `confirm:true` and `expected_total_naira`. Closed vendors, missing/out-of-stock items or options, invalid required options, incomplete fees, wallet shortfalls, changed totals and over-budget totals block placement. Only the selected vendor cart is replaced. Fresh real-cart checkout is revalidated again before the existing guarded placement implementation runs.

Attempt reservations persist before cart mutation. Completed keys replay the saved result before touching a cart. Different inputs cannot reuse a key. Unknown outcomes return `placed:null`, active-order/order-log reconciliation evidence and `retry_allowed:false`; they are never blindly retried. Successful responses contain order number, returned PIN, total, payment status, fresh wallet balance when readable and elapsed time. Synthetic tests cover placement paths; real charging is not established by the benchmarks below.

`reorder_fast` accepts a past order ID or saved favourite recipe name, cap and stable key. It preserves original packs, options, recipient and saved delivery address. For the configured default recipient, its current saved rider note takes precedence over a historical note; other recipients retain their original notes. An explicit `rider_note` overrides either. Ambiguous original options require review. It uses the same confirmation, budget and idempotency safeguards; `confirm:false` never invokes the native cart-rebuilding endpoint.

Operators may set `QUICK_ORDER_DEFAULTS` as a Worker secret JSON with `gift_recipient` and `rider_note`. No personal contact details are shipped in source. Explicit `gift_recipient:null` selects a self order; an omitted recipient uses the configured default.

## Read-only performance evidence — 2026-10-27

Measured through an MCP SDK client and an existing stdio-to-hosted bridge, with one initialized connection. Cold means menu/vendor KV entries were removed and the Worker redeployed to clear memory; authentication/account state was retained. Times include bridge/network overhead, excluding client initialization. These are individual observations, not latency guarantees.

| Call | Cold | Warm | Tool execution, cold |
| --- | ---: | ---: | ---: |
| Open-pharmacy search, four synonyms | 4.390 s | 0.660 s | 3.829 s |
| Six complete slim restaurant menus | 1.601 s | 0.528 s | 1.165 s |
| Live quick-order dry run | 1.215 s | — | 0.895 s |
| Past-order dry run | 1.598 s | — | 1.233 s |

The six menus contained 388 in-stock items, all with image URLs and complete required-option details. Complete minified JSON was 93,740 bytes: **the requested 60 KB uncompressed total and 10 KB for each large vendor were not achieved**. HTTP gzip transfer was about 20 KB. No items, full URLs or required options were silently removed to meet a byte target; category filtering is available when a smaller response is needed.

At test time only five pharmacies were open; all five were checked, 176 closed entries were skipped and coverage was complete. A roughly twenty-open-vendor cold performance claim remains unverified. Closed-vendor diagnostic search separately found all three named test products, including the out-of-stock 3H-Viralcheck. Open-only search correctly excluded the two closed pharmacies. A sixty-vendor diagnostic took longer than five seconds and had partial coverage because some menus failed/timed out; consult the coverage flags rather than assuming completeness.

No live order, OTP or payment was performed. That benchmark build passed its 41 automated tests, including synthetic confirmation/idempotency, unknown-outcome reconciliation, immutable dry runs, timeout isolation, concurrency, cache restoration/invalidation, image URLs and original safeguard tests.

The subsequent resumable-search build passes 55 tests, including free/paid request limits, cursor restoration after memory eviction, searches beyond 200 vendors, actual SQLite query accounting, invalid vendor types, retired-group handling and the original safeguards. New live timings are recorded separately rather than relabelling the earlier benchmark. The final observed fully warmed 60-shop first page took 442 ms through the bridge (after two cache-priming calls); this is a measured warm result, not a cold latency guarantee.

## Focused website comparisons — 2026-10-27

At the same saved delivery address, all nine website `jollof rice` dishes at Gulliver Kitchen matched names, effective discounted prices and stock. The MCP additionally found two dishes containing both jollof and fried rice, consistent with token matching. The shorter `jollof` query matched all 21 website items. `pounded yam` and `pounded` each matched the same one prepared dish at Pounded Yam 247 - Jakande. These are scoped comparisons at the named vendors, not a claim that every listing on the website was inspected.

The catalogue spells the Apple USB-C item `APPLE TYPE C TO TYPE C CHORD (2M)`. A search for `Apple type c cord` now retrieves that exact item while retaining its listed price and out-of-stock status. Connector variants remain separate item IDs; a match never chooses or orders a substitute.

The earlier full traversal checked 1,637 eligible open vendors and explained 1,644 closed vendors without request-limit failures. That full-scan evidence predates the subsequent bounded-cache adapter deployment; final-build checks used focused comparisons and one 60-shop warm benchmark. No real order, payment, OTP or cart mutation was performed.

The cache is gzip-compressed and bounded by SQL triggers, with a reserved continuation pool and five-minute expiry cleanup. Admission and UTC daily budgets persist across deploys; see [cache limits](mcp/D1-STORAGE.md). Runtime is compatible with Node 18+, while the actual SQLite tests require Node 22+ and are skipped on older Node versions.
