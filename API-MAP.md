# Chowdeck API map

94 observed operations across 10 areas. Inspected 2026-10-26. Base: `https://api.chowdeck.com`.

Public storefront contracts. An observed path is not proof of successful authenticated execution. Uncaptured schemas and unverified methods are marked.

Gift orders are `POST /customer/order` with a `gift_recipient` object. Wallet orders use `payment_method:"wallet"`. Checkout `tip` and wallet funding amounts are kobo. The existing token can be renewed by `POST /auth/refresh-token` with `{token}`; the returned token is not shown to agents.

## Authentication

| Method | Path | Inputs / notes | MCP coverage |
|---|---|---|---|
| POST | `/auth/phone/validate` | phone, country_code | login_send_otp |
| POST | `/auth/login` | phone, country_code, role | login_send_otp |
| POST | `/auth/login/validate-otp` | phone, country_code, role, otp | login_verify_otp |
| POST | `/auth/refresh-token` | token | automatic renewal |
| POST | `/auth/resend-otp` | phone, role, country_code, type | Mapped; dedicated tool not yet implemented |
| GET | `/auth/me` | currency, country_code | get_me |
| GET | `/auth/countries` |  | Mapped; dedicated tool not yet implemented |
| POST | `/customer/register` | request body requires further field capture | Mapped; dedicated tool not yet implemented |
| POST | `/customer/register/validate-otp` | request body requires further field capture | Mapped; dedicated tool not yet implemented |
| POST | `/customer/recovery/email` | recovery fields require further capture | Mapped; dedicated tool not yet implemented |
| POST | `/customer/recovery/phone` | recovery fields require further capture | Mapped; dedicated tool not yet implemented |
| PUT | `/auth/profile?user_role=customer` | profile fields | Mapped; dedicated tool not yet implemented |
| GET | `/auth/refresh-push-token` |  | Mapped; dedicated tool not yet implemented |

## Addresses

| Method | Path | Inputs / notes | MCP coverage |
|---|---|---|---|
| GET | `/place/autocomplete/json` | input | search_places |
| GET | `/place/details/json` | placeid | place_details |
| GET | `/customer/address` |  | list_addresses |
| POST | `/customer/address` | resolved address fields | set_address |
| PUT | `/customer/address` | saved address fields | Mapped; dedicated tool not yet implemented |
| DELETE | `/customer/address/{id}` |  | Mapped; dedicated tool not yet implemented |
| POST | `/customer/address/set-active` | address_id | set_active_address |

## Discovery

| Method | Path | Inputs / notes | MCP coverage |
|---|---|---|---|
| GET | `/customer/config` | currency | get_config |
| GET | `/customer/vendor` | custom_tags, address_id | featured_vendors |
| GET | `/customer/vendor/v2` | address_id, is_favourite, vendor_type, filters | list_vendors |
| GET | `/customer/vendor/{id}` | address_id | get_vendor |
| GET | `/customer/search` | text, address_id | search |
| GET | `/customer/search/product` | query fields need further capture | Mapped; dedicated tool not yet implemented |
| GET | `/customer/vendor/{id}/menu` | return_out_of_stock, menu_category_id | get_menu |
| GET | `/customer/vendor/{id}/menu-category` |  | get_menu_categories |
| GET | `/customer/vendor/{id}/menu-category/summary` |  | Mapped; dedicated tool not yet implemented |
| GET | `/customer/vendor/{id}/menu/{item_id}` |  | get_menu_item |
| GET | `/customer/vendor/{id}/menu/search` | query params need further capture | Mapped; dedicated tool not yet implemented |
| GET | `/customer/vendor/{id}/menu-category/{category_id}/menu` | query params | Mapped; dedicated tool not yet implemented |
| GET | `/customer/vendor/{id}/menu/sections` | sections, type | Mapped; dedicated tool not yet implemented |
| GET | `/customer/menu/{id}` | query params | Mapped; dedicated tool not yet implemented |
| GET | `/customer/vendor/{id}/rating` |  | Mapped; dedicated tool not yet implemented |
| GET | `/customer/vendor/{id}/review` | pagination params | Mapped; dedicated tool not yet implemented |
| GET | `/customer/vendor/nearby` | address/filter params | Mapped; dedicated tool not yet implemented |
| GET | `/customer/vendor/frequent` | address/filter params | Mapped; dedicated tool not yet implemented |
| GET | `/customer/chowstore/products` | product filters | Mapped; dedicated tool not yet implemented |
| GET | `/customer/chowsmart/menu` | address_id | Mapped; dedicated tool not yet implemented |
| GET | `/customer/preorder-event/{vendor_type}/vendor` | campaign/address params | Mapped; dedicated tool not yet implemented |
| GET | `/customer/preorder-event/{vendor_type}/menu` | campaign/address params | Mapped; dedicated tool not yet implemented |
| GET | `/customer/home/tiles` | query params | Mapped; dedicated tool not yet implemented |
| GET | `/customer/vendor/campaign` | campaign params | Mapped; dedicated tool not yet implemented |

## Favourites

| Method | Path | Inputs / notes | MCP coverage |
|---|---|---|---|
| POST | `/customer/vendor/{id}/like/{0|1}` | empty body | add_favorite / remove_favorite |

## Cart and packs

| Method | Path | Inputs / notes | MCP coverage |
|---|---|---|---|
| GET | `/customer/cart` |  | get_carts |
| GET | `/customer/cart/vendor/{vendor_id}` |  | get_cart |
| POST | `/customer/cart` | source, app_version, vendor_id, items, class, address_id | update_cart |
| POST | `/customer/cart/vendor/{vendor_id}` | source, app_version, items, class, address_id | update_cart |
| PATCH | `/customer/cart/guest/upgrade` |  | automatic guest upgrade |
| DELETE | `/customer/cart/clear` |  | clear_carts |
| DELETE | `/customer/cart/{id}` |  | delete_cart |
| POST | `/customer/cart/{id}/pack/{reference}/duplicate` |  | duplicate_pack |
| DELETE | `/customer/cart/{id}/pack/{reference}` |  | delete_pack |

## Gifts

| Method | Path | Inputs / notes | MCP coverage |
|---|---|---|---|
| GET | `/customer/beneficiary` |  | list_beneficiaries |
| DELETE | `/customer/beneficiary/{id}` |  | Mapped; dedicated tool not yet implemented |
| POST | `/customer/order` | gift_recipient: donor_name/name/phone/country_code/email/message/save_as_beneficiary | place_order |

## Checkout and promotions

| Method | Path | Inputs / notes | MCP coverage |
|---|---|---|---|
| POST | `/customer/delivery/amount` | destination_id, source_id, vendor_id, order_class, cart_id, currency, country_code | get_delivery_fee |
| POST | `/customer/discount/apply` | promo_codes, vendor_id, address_id, fee_id, cart_id, currency, order_items, containers, delivery_fee, order_class | prepare_checkout |
| GET | `/customer/promo-code` |  | Mapped; dedicated tool not yet implemented |
| POST | `/customer/promo-code/{code}` | currency, security_answer (if required) | validate_promo |
| GET | `/customer/promo-code/{code}/security-question` | currency | Mapped; dedicated tool not yet implemented |
| GET | `/customer/discount` |  | Mapped; dedicated tool not yet implemented |

## Orders

| Method | Path | Inputs / notes | MCP coverage |
|---|---|---|---|
| POST | `/customer/order` | source, vendor_id, cart_id, class, payment_method, payment_method_id, checkout_from_cart, notes, fee_id, address_id, bag_quantity, promo_codes, requires_delivery_pin, gift_recipient, split_payment_with_wallet, tip, currency, country_code | place_order |
| GET | `/customer/order` | status; x-chowdeck-api-version:v2 | get_active_orders / get_order_history |
| GET | `/customer/order/{id}` |  | get_order |
| GET | `/customer/order/{id}/timeline` |  | get_order_timeline |
| GET | `/customer/order/{id}/live-tracking` |  | get_live_tracking |
| POST | `/customer/order/{id}/cancel` |  | cancel_order |
| POST | `/customer/order/{id}/repeat` | attribution (optional) | reorder |
| PUT | `/customer/order/{id}/delivery` | customer_delivery_note OR fee_id/payment_method/payment_method_id | update_delivery_note |
| GET | `/customer/order/{id}/delivery` |  | Mapped; dedicated tool not yet implemented |
| PUT | `/customer/order/{id}/complete` |  | Mapped; dedicated tool not yet implemented |
| PUT | `/customer/order/{id}/rate-or-review` | review payload needs further capture | Mapped; dedicated tool not yet implemented |
| POST | `/customer/order/{id}/tip` | amount in kobo, payment_method | tip_rider |
| GET | `/customer/order/{id}/bundle/vendors` |  | Mapped; dedicated tool not yet implemented |

## Payments and wallet

| Method | Path | Inputs / notes | MCP coverage |
|---|---|---|---|
| GET | `/customer/wallet` | currency, new_response=true | get_wallet |
| GET | `/customer/payment/methods` | currency | get_payment_methods |
| GET | `/customer/payment/channel` | country_identifier | get_payment_channels |
| POST | `/customer/payment/start` | amount in kobo, destination:wallet, method, currency | wallet_topup |
| POST | `/customer/payment/charge` | amount in kobo, auth_id, destination:wallet, currency | Mapped; dedicated tool not yet implemented |
| POST | `/customer/payment/start/v2` | order_id, method, split_payment_with_wallet, return_url, callback_url | start_order_payment |
| GET | `/customer/payment/verify/{transaction_id}` |  | verify_payment |
| GET | `/order/{id}/payment` |  | get_order_payment_status |
| POST | `/order/{id}/payment` | method, pocket_tag, payment_phone | Mapped; dedicated tool not yet implemented |
| GET | `/payment/channel` | country_identifier | Mapped; dedicated tool not yet implemented |
| GET | `/auth/virtual-account` | currency | wallet shortfall details |

## Other storefront capabilities

| Method | Path | Inputs / notes | MCP coverage |
|---|---|---|---|
| POST | `/customer/package/delivery/amount` | package quote payload needs capture | Mapped; dedicated tool not yet implemented |
| POST | `/customer/package/delivery` | package delivery payload needs capture | Mapped; dedicated tool not yet implemented |
| GET | `/customer/chowpass/free-trial-eligibility` |  | Mapped; dedicated tool not yet implemented |
| POST | `/customer/preferences` | preference payload | Mapped; dedicated tool not yet implemented |
| PUT | `/customer/segment/{id}` | is_active | Mapped; dedicated tool not yet implemented |
| GET | `/customer/promotion/anniversary/rewards` | query params | Mapped; dedicated tool not yet implemented |
| POST | `/customer/menu/stock/notification-request` | stock notification payload needs capture | Mapped; dedicated tool not yet implemented |

## Evidence and validation

[Public storefront asset](https://chowdeck.com/store/_next/static/chunks/3488-e1b256a91731e869.js) — SHA-256 `4d0441f975aeecbb72709e282ed6069c078e18cc1ebc4ded8576a4fe83723b0e`. The machine-readable companion has source links and a verification flag for every operation. No authenticated browser credentials were inspected.

Live account-specific wallet charges, gifts, refunds, saved profiles, cancellations and delivery have not yet been verified. Hosted public config retrieval has been verified separately.
