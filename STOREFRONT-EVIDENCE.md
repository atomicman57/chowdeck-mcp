# Public contract evidence — 2026-10-26

Source: https://chowdeck.com/store and its public JavaScript asset `/store/_next/static/chunks/3488-e1b256a91731e869.js`. No authenticated browser cookies, local storage or bearer tokens were read.

Observed checkout contracts:

- Gift form fields: `phone`, `donor_name`, `name`, optional `email` and `message`, `country_code`; submission adds `save_as_beneficiary` and sends the result as `gift_recipient`. Ordinary checkout sends null; pickup excludes gift delivery.
- The custom-tip form multiplies entered naira by 100 before storing it; checkout sends this kobo value as `tip`. This build keeps `rider_tip` input in NGN and converts it to kobo.
- Order submission sends `checkout_from_cart: true`, `cart_id`, actual cart class, notes, bag quantity, payment method/id, destination address and fee for delivery, currency/country, wallet split flag and optional `tip`. Standard cart checkout does not flatten packs into order items.
- Pickup uses class `pickup`, omits destination address/fee, disables the delivery PIN. Vendor preorders use class `preorder_delivery` and `delivery_date`, `earliest_delivery_time`, `latest_delivery_time`.
- Payment initialization uses POST `/customer/payment/start/v2`, with `method`, `order_id` and optional `split_payment_with_wallet`.
- Saved recipients: GET `/customer/beneficiary`.
- Order progress: GET `/customer/order/{id}/timeline` and `/customer/order/{id}/live-tracking`.
- Rider note: PUT `/customer/order/{id}/delivery`, body `customer_delivery_note`.
- Packs: POST `/customer/cart/{id}/pack/{reference}/duplicate`; DELETE `/customer/cart/{id}/pack/{reference}`.

These observations support request shapes, not successful execution against a signed-in account. Real wallet payment and gift delivery remain unverified.
