# Fast tools and cache behavior

All 68 existing tools remain available. Five new tools bring the total to 73. Every tool result includes timing in `_meta.elapsed_ms`; JSON object results also include `elapsed_ms` in their text/structured payload. Existing array and image content shapes remain intact.

## Search, menus and photos

- `search_items_everywhere(queries, vendor_type?, open_now=true, in_stock_only=false, max_distance_km?, max_vendors=60)` pages the vendor cursor internally and checks menus with concurrency twelve. It normalizes 3-in-1 / 3 in 1 / 3in1 and compact synonyms, ranks names above categories and option-group names, and returns main menu items only. Short HIV matching uses tokens to avoid unrelated names. `vendors_checked`, `vendors_skipped`, `cache_hits` and `coverage_complete` make partial coverage explicit. Pagination is bounded to twenty pages and the requested vendor cap; timeouts or failed menus make coverage incomplete.
- `get_menu_slim(vendor_ids, category?, in_stock_only=true, include_images=true)` returns complete matching item lists with IDs, names, prices in naira, stock, descriptions capped at eighty characters, first image URLs and required option groups. Each vendor has independent failure handling and `option_groups_complete`; never infer missing options from incomplete data.
- `get_food_images_batch(items, limit_per_item=1)` returns URLs only. Supported encoded Chowdeck transformations are decoded to validated public object URLs. Existing image-download safeguards remain in the original `get_food_images` tool.

Menu reads share a three-second upstream deadline per vendor, including option detail calls, and a global concurrency limit of twelve. Waiting for a concurrency slot or KV storage can add time to a whole batch. Failures are isolated and successful vendors are retained.

## Cache and consistency

Cloudflare Workers KV stores normalized menus for ten minutes under vendor ID plus latest observed item `updated_at` and a content hash. A head index selects the current version; replaced versions are removed. Warm-isolate memory caches and single-flight requests reduce repeat reads. Open vendor lists are cached for two minutes, scoped to address and filters.

An observed vendor menu revision invalidates its cached menu. Menus older than sixty seconds are revalidated in the background when a Worker context is available. There is no upstream change subscription: a change is detected on a revision observation, background check or expiry, not instantly when Chowdeck changes it. Checkout always fetches fresh item, option and vendor data. Favourite menus are prewarmed in the background whenever the hosted account session is successfully refreshed; cache failures do not block renewal.

Deploy with a dedicated `CHOWDECK_CACHE` KV binding. Local stdio operation uses memory caching when KV is absent.

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

No live order, OTP or payment was performed. All 41 automated tests pass, including synthetic confirmation/idempotency, unknown-outcome reconciliation, immutable dry runs, timeout isolation, concurrency, cache restoration/invalidation, image URLs and original safeguard tests.
