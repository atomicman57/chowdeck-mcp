# Changelog

## Unreleased — resumable search coverage

- Share a configurable invocation request budget across vendor listing, menu/detail reads and authentication retries; return partial matches and a scoped continuation cursor before exhausting it.
- Accept up to 200 vendors per call, explain skipped vendors, validate vendor types and map `shop` to Chowdeck's `supermarket` category.
- Reuse menus across all query synonyms, batch cache reads, cache first result pages and reduce redundant option-detail requests.
- Resolve retired root option-group references from authoritative item details while preserving failures as incomplete coverage.
- Use D1 storage with indexed batch menu reads and batched menu/head writes with atomic cache limits, keeping both external and database invocation budgets below free-plan ceilings.
- Match cable/cord/CHORD and USB-C/type-C wording, combine item/category tokens, and support focused known-vendor comparisons.
- Add fourteen regression tests; all 55 tests pass without real orders, payments or OTPs.

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased speed improvements] — 2026-10-27

- Follow-up GrokBot dry-run validation: apply the current configured default recipient’s rider note on fast reorders, with an explicit rider_note override. Preserve historical notes for other recipients.

- Preserve all 68 existing tools and add five: cross-vendor search, slim multi-menu reads, batch photo URLs, quick ordering and fast reorder.
- Add versioned KV caching, bounded concurrency of twelve, a shared three-second upstream menu deadline per vendor, background revalidation and favourite prewarming on session refresh.
- Add elapsed_ms to every tool response; reduce JSON formatting overhead and decode encoded menu photos to validated direct image URLs.
- Preserve exact-total approval and durable idempotency; dry runs never mutate carts or place/pay orders. Unknown placement outcomes reconcile without automatic retry.
- 41 tests pass. See SPEED.md for measured read-only latency, raw JSON size limits and upstream availability caveats.

## [0.7.0-rc.1] — 2026-10-26

### Added
- Gift recipients, saved recipient profiles, repeat-gift previews, wallet selection and splitting, exact checkout previews and shortfall reporting.
- Durable placement idempotency, duplicate protection, order timing logs and refund snapshots.
- Real menu images as MCP image content, an evidence-backed map of 94 observed storefront operations, and automatic session renewal.
- Optional Cloudflare Worker hosting with encrypted persistent account state, OAuth/PKCE and owner-protected browser sign-in; authenticated loopback HTTP and stdio bridge alternatives.
- 30 tests covering synthetic checkout, renewal, encryption, OAuth and image handling. Live account-specific payment and delivery remain unverified.

### Fixed
- Handle Chowdeck browser security verification through an owner-protected external-code handoff; report security-required OTP errors clearly and never claim login success without a token. Authentication tokens are kept out of verification responses.
- Favourites routes, native reorder pack preservation, wallet-funding units and endpoint, tip conversion and vendor preorder windows.

## [Unreleased]

### In progress
- Online payment (Paystack) checkout: bank transfer / card-less / new-customer
  flow. The order is created unpaid and a hosted `pay_for_me` link reaches
  Paystack, but full programmatic completion is not yet wired.

## [0.6.1] — 2026-06-14

### Fixed
- **`tip_rider` amount is back to KOBO** (50000 = ₦500), matching the value the
  `/tip` endpoint actually accepts (verified against the live API). v0.6.0 had
  changed it to naira for consistency, which would have under-tipped 100×. The
  confirmation prompt now shows both (`₦500.00 (50000 kobo)`) as a sanity check.
  (`place_order.rider_tip` remains naira; the difference is documented in both.)

### Changed
- Dropped the "best-effort / inferred endpoint" caveats on `cancel_order`,
  `tip_rider`, and `get_notifications` now that they're confirmed against the
  live API.

## [0.6.0] — 2026-06-14

Batch of agent-contributed features (originally PRs #12–#15 by @claw-son),
integrated with safety fixes.

### Added
- **`get_menu` category filter** — optional `category` (case-insensitive partial
  match) trims large menus to avoid response truncation. (#12)
- **`update_cart` pack support** — optional `pack_reference` groups items into
  separate packs within one cart. (#13)
- **`cancel_order`** — cancel a not-yet-fulfilled order; refund to wallet. (#14)
- **`tip_rider`** — tip the rider for an order. (#15)
- **`get_notifications`** — fetch order/promo notifications. (#15)

### Fixed
- **`online_payment` fallback** — if the Paystack link fails, retry via
  `startPayment` (v2) so the order still gets a checkout URL. (#13)

### Safety fixes applied during integration
- `cancel_order` and `tip_rider` are marked **destructive** and **confirmation-
  gated** (`confirm:true`), consistent with `place_order` / `wallet_topup`.
- `tip_rider` takes its amount in **NGN (naira)**, not kobo — matching
  `place_order.rider_tip` and `wallet_topup` so the agent can't tip 100× by
  mistake.
- Also refreshed the stale `package-lock.json` (was `chowdeck-mcp@0.1.0`).

> Note: `cancel_order`, `tip_rider`, and `get_notifications` use inferred
> (best-effort) endpoints and may need adjustment against the live API.

## [0.5.1] — 2026-06-13

### Changed
- **Published to npm as the scoped package `@thathman/chowdeck-mcp`** (`publishConfig.access: public`).
- Description now leads with **"Unofficial … Not affiliated with Chowdeck."**
- `prepack` copies `README.md` + `LICENSE` into the package so they ship in the
  npm tarball (the package root is `mcp/`).
- README `npx` instructions updated to the scoped name.

## [0.5.0] — 2026-06-13

### Added
- **MCP prompts** — pickable, reusable flows that drive the tools while keeping
  the SKILL's safety rules (confirm address + total before ordering):
  `order_food`, `find_food_near_me`, `track_my_order`, `reorder_my_usual`.

## [0.4.0] — 2026-06-13

### Added
- **`track_order`** — compact live status (status, ETA, delivery PIN, rider
  name/phone, payment status, tracking link) for following a delivery.
- **Scheduled delivery & tipping** — `place_order` accepts `scheduled_for`
  (ISO 8601) and `rider_tip` (NGN); both surface in the confirmation prompt.
- **`validate_promo`** — check a promo/voucher code before checkout; valid codes
  go to `place_order` via `promo_codes`.
- **`wallet_topup`** — initialise a wallet top-up (returns a Paystack link);
  destructive + confirmation-gated.

> Note: scheduled-delivery / tip fields and the promo & wallet-topup endpoints
> are best-effort (inferred) and may need adjustment against the live API.

## [0.3.0] — 2026-06-13

### Added
- **Discovery filters** on `list_vendors` (sort, open_now, min_rating,
  max_delivery_fee, free_delivery, page) and `search` (sort, open_now,
  min_rating).
- **Favourites** — `list_favorites`, `add_favorite`, `remove_favorite` for saved
  vendors.
- **`reorder`** — rebuild a cart from a past order id, ready to confirm and
  check out.

> Note: favourites endpoints are best-effort (inferred paths) and may need
> adjustment against the live API.

## [0.2.0] — 2026-06-13

### Added
- **Tool annotations** — every tool is now hinted `readOnlyHint` or
  `destructiveHint` so hosts can gate the dangerous ones.
- **Confirmation gate** on destructive / money-moving tools (`place_order`,
  `clear_carts`, `delete_cart`, `logout`). They stay callable but only execute
  with `confirm: true`, which the agent should set only after the user approves;
  otherwise they return a "confirm first" no-op.
- **Structured output** (`outputSchema` + `structuredContent`) on `get_session`
  and `get_setup_status` for machine-readable results.

### Changed
- Migrated all 38 tools to the modern `registerTool` API.
- **Response slimming** — discovery/list/menu responses are recursively trimmed
  (heavy media keys dropped, long strings truncated, arrays capped at 60) to cut
  token usage without losing the fields agents reason over.
- `update_cart` quantities are validated (`1..99`, integer).

## [0.1.2] — 2026-06-13

### Changed
- **License changed from CC-BY-4.0 to MIT** — Creative Commons is not intended
  for software; MIT is the right fit for a code library. `LICENSE`, badges, and
  source headers updated.

### Fixed
- **CLI shebang** — `dist/index.js` now starts with `#!/usr/bin/env node` and is
  marked executable, so `npx chowdeck-mcp` / the `bin` entry actually runs.
- Corrected the author contact email typo (`airixmmedia` → `airixmedia`).

### Added
- `engines.node >= 18` in `package.json`.

## [0.1.1] — 2026-06-13

### Security
- **Session file hardened** — `~/.chowdeck-mcp/session.json` (holds the bearer
  token) is now written with `0600` perms inside a `0700` directory.
- **No third-party keys embedded** — the Google Maps key is read from
  `CHOWDECK_MAPS_KEY`; reverse-geocoding errors clearly if it's unset. The
  previously embedded key was purged from git history.
- **Unofficial / unaffiliated disclaimer** added to the README, emphasising
  self-authentication, ToS respect, and no bundled credentials.

### Changed
- HTTP client now sets a request **timeout** (`CHOWDECK_TIMEOUT_MS`, default 15s)
  and **retries only transient failures** (network / 5xx) with bounded backoff
  (`CHOWDECK_MAX_RETRIES`); order placement opts out to avoid duplicate orders.
- `ip-api` IP-location lookup moved to an **HTTPS** provider.
- Phone numbers are **validated** (11-digit Nigerian format) before any OTP is
  sent.
- Base URL and app version are configurable via `CHOWDECK_API_BASE` /
  `CHOWDECK_APP_VERSION`.

## [0.1.0] — 2026-06-11

### Added
- Initial MCP server for Chowdeck with 38 tools across:
  - **Setup & session** — persistent login + delivery address, new-vs-returning
    detection, payment preference.
  - **Location** — address search, place details, reverse geocode, set address
    from a resolved place.
  - **Discovery** — config, vendors, featured vendors, search, menus, menu items.
  - **Cart** — create/update, list, per-vendor, clear, delete.
  - **Auth** — phone OTP login, profile.
  - **Account** — saved addresses, wallet, order history, payment methods.
  - **Orders** — place order, active orders, order detail, delivery fee quote,
    payment channels, payment start, verify payment.
- Disk-persisted session (`~/.chowdeck-mcp/session.json`).
- CI workflow, CC BY 4.0 license, author watermark.

### Status
- ✅ **Stable:** returning customers paying with a **saved card** — order is
  placed and charged inline, with delivery PIN and rider details.
- 🚧 **In progress:** online payment / bank transfer for card-less and new
  customers.
