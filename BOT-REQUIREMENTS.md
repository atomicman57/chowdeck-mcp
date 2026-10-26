# Ordering workflow requirements

Generic requirements used to design the tools; these are not evidence of live payment success.

1. Durable idempotency and protection against repeated orders after a hung/failed placement.
2. One-call preparation of repeat gifts to an explicitly saved recipient, keeping options, packs, address, note, Wallet and budget; show current price changes.
3. Saved recipient profiles and an explicitly chosen default; echo the recipient in every gift preview.
4. Complete dry-run checkout, including open status, cart validity, stock, fees, minimums and wallet shortfalls.
5. Fresh shortfall/account details without rebuilding the cart or transferring automatically.
6. Persistent session health, silent renewal and no unapproved OTPs or token leakage.
7. Exact item/option IDs, with candidates instead of guesses for ambiguous names.
8. Open-vendor alternatives carrying the requested item, without automatic substitution.
9. Cancellation/refund evidence; polling as requested, with no assumption that a balance increase proves a particular refund.
10. A request-to-placement timing log with amount, PIN and recipient where the service returns them.

The implemented tools address these workflows. Real acceptance against a signed-in account remains pending initial sign-in and a separately approved real order. The target of a known gift order completing in under 60 seconds has not been measured. No saved recipient/phone/address values were seeded from an unverified guess.

The user's later image request is implemented through `get_food_images`; actual Chowdeck menu photos and native image content were verified from the deployed endpoint.
