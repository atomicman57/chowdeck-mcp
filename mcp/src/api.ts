/*!
 * Chowdeck MCP · API client
 * Author: Hendrix Nwaokolo (@thathman) <hello@airixmedia.com>
 * License: MIT. © 2026 Hendrix Nwaokolo.
 * Watermark: THATHMAN·CHOWDECK·MCP
 */
import axios, { type AxiosInstance, type AxiosRequestConfig } from "axios";
import { Buffer } from "node:buffer";
import { session, persistNow } from "./session.js";
import { createHash } from "node:crypto";

const BASE = process.env.CHOWDECK_API_BASE ?? "https://api.chowdeck.com";
const APP_VERSION = process.env.CHOWDECK_APP_VERSION ?? "2.0.0";
const TIMEOUT_MS = Number(process.env.CHOWDECK_TIMEOUT_MS ?? 15000);
const MAX_RETRIES = Number(process.env.CHOWDECK_MAX_RETRIES ?? 2);
if (process.env.CHOWDECK_HTTP_ADAPTER === "fetch") {
  axios.defaults.adapter = "fetch";
  axios.defaults.fetchOptions = { cache: "no-store" };
}

let refreshInFlight: Promise<void> | null = null;

/** Storefront-confirmed token renewal; no browser session extraction. */
export async function refreshSessionToken(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  const previous = session.token;
  if (!previous) throw new Error("Sign in to Chowdeck before refreshing the session.");
  refreshInFlight = (async () => {
    try {
      const response = await axios.post(`${BASE}/auth/refresh-token`, { token: previous }, {
        timeout: TIMEOUT_MS,
        headers: { "x-app-name": "storefront", "x-app-os": "web", "Authorization": `Bearer ${previous}` },
      });
      const token = response.data?.token ?? response.data?.data?.token;
      if (typeof token !== "string" || !token) throw new Error("Missing refreshed token");
      session.token = token;
    } catch {
      throw new Error("Chowdeck could not renew this session. Sign in again if it has been revoked; no order was automatically repeated after an ambiguous failure.");
    }
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}
function tokenNeedsRefresh(token: string): boolean {
  try {
    const value = token.split(".")[1];
    const payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return typeof payload.exp === "number" && payload.exp * 1000 <= Date.now() + 60000;
  } catch { return false; }
}

function client(): AxiosInstance {
  const headers: Record<string, string> = {
    "x-app-name": "storefront",
    "x-app-os": "web",
    "accept": "application/json",
    "content-type": "application/json",
  };
  if (session.token) headers["Authorization"] = `Bearer ${session.token}`;
  if (session.guestId) headers["x-guest-id"] = session.guestId;
  const instance = axios.create({ baseURL: BASE, headers, timeout: TIMEOUT_MS, ...(process.env.CHOWDECK_HTTP_ADAPTER === "fetch" ? { adapter: "fetch" } : {}) });
  instance.interceptors.request.use(async (cfg) => {
    if (session.token && !cfg.url?.startsWith("/auth/login") && tokenNeedsRefresh(session.token)) await refreshSessionToken();
    if (session.token) cfg.headers.set("Authorization", `Bearer ${session.token}`);
    return cfg;
  });
  // Retry only transient failures (network errors / 5xx) with linear backoff.
  // Never retries 4xx; order placement opts out via _noRetry to avoid dupes.
  instance.interceptors.response.use(undefined, async (error) => {
    const cfg = error.config as (AxiosRequestConfig & { _retry?: number; _noRetry?: boolean; _authRetried?: boolean }) | undefined;
    const authMessage = error.response?.data?.message;
    if (cfg && session.token && !cfg._authRetried && error.response?.status === 401 && ["Token expired", "Invalid token"].includes(authMessage)) {
      cfg._authRetried = true;
      const rejectedToken = (cfg.headers as any)?.Authorization;
      if (rejectedToken === `Bearer ${session.token}`) await refreshSessionToken();
      cfg.headers = { ...cfg.headers, Authorization: `Bearer ${session.token}` };
      // An explicit authentication rejection is safe to replay once; never
      // replay a timeout, network error, 5xx, or ambiguous purchase outcome.
      return instance(cfg);
    }
    if (!cfg || cfg._noRetry || !["get", "head", "options"].includes((cfg.method ?? "get").toLowerCase())) throw error;
    const status = error.response?.status;
    const transient = status === undefined || status >= 500;
    cfg._retry = (cfg._retry ?? 0) + 1;
    if (!transient || cfg._retry > MAX_RETRIES) throw error;
    await new Promise((r) => setTimeout(r, 400 * cfg._retry!));
    return instance(cfg);
  });
  return instance;
}

// ── Location / geocoding ───────────────────────────────────────────────────────
// Chowdeck proxies Google Places autocomplete + details through its own API.
// Reverse geocoding (current coords -> address) needs a Google Maps key. Supply
// your OWN key via CHOWDECK_MAPS_KEY — never embed a third party's key.
const MAPS_KEY = process.env.CHOWDECK_MAPS_KEY ?? "";

export async function searchPlaces(input: string) {
  return (await client().get("/place/autocomplete/json", { params: { input } })).data;
}

export async function placeDetails(placeId: string) {
  return (await client().get("/place/details/json", { params: { placeid: placeId } })).data;
}

export async function reverseGeocode(lat: number, lng: number) {
  if (!MAPS_KEY) {
    throw new Error(
      "Reverse geocoding needs your own Google Maps key (set CHOWDECK_MAPS_KEY). Use search_places to resolve the address instead.",
    );
  }
  const url = "https://maps.googleapis.com/maps/api/geocode/json";
  return (await axios.get(url, { params: { latlng: `${lat},${lng}`, key: MAPS_KEY }, timeout: TIMEOUT_MS })).data;
}

// Rough current location from IP — for SUGGESTION ONLY; never order against it
// without the user confirming the precise address. Uses an HTTPS provider.
export async function ipLocation() {
  const r = (await axios.get("https://ipapi.co/json/", { timeout: TIMEOUT_MS })).data;
  return {
    status: r?.error ? "fail" : "success",
    city: r?.city,
    regionName: r?.region,
    country: r?.country_name,
    lat: r?.latitude,
    lon: r?.longitude,
    query: r?.ip,
  };
}

function componentsToAddress(result: any, houseNo?: string) {
  const comps: any[] = result.address_components ?? [];
  const pick = (type: string) => comps.find((c) => c.types?.includes(type))?.long_name;
  const loc = result.geometry?.location ?? {};
  return {
    place_id: String(result.place_id ?? ""),
    house_no: houseNo,
    street: pick("route") ?? result.name ?? result.formatted_address ?? "",
    pretty_name: result.formatted_address ?? result.name ?? "",
    longitude: loc.lng,
    latitude: loc.lat,
    city: pick("locality") ?? pick("administrative_area_level_2") ?? "",
    state: pick("administrative_area_level_1") ?? "",
    country: pick("country") ?? "Nigeria",
    area: pick("sublocality") ?? pick("neighborhood"),
  };
}

// Resolve a place_id to exact coordinates and create the delivery address.
export async function setAddressFromPlace(placeId: string, houseNo?: string) {
  const details = await placeDetails(placeId);
  const result = details?.result ?? details?.data?.result ?? details?.data;
  if (!result?.geometry?.location) throw new Error("Could not resolve coordinates for that place.");
  const body = componentsToAddress(result, houseNo);
  return createAddress(body as any);
}

// ── Discovery ─────────────────────────────────────────────────────────────────

export async function getConfig() {
  return (await client().get("/customer/config?currency=NGN")).data;
}

export async function createAddress(body: {
  place_id?: string;
  house_no?: string;
  street: string;
  pretty_name: string;
  longitude: number;
  latitude: number;
  city: string;
  state: string;
  country: string;
  area?: string;
}) {
  const res = (await client().post("/customer/address", body)).data;
  if (res?.data?.id) session.addressId = res.data.id;
  return res;
}

export async function getVendors(params: {
  address_id?: number;
  vendor_type?: string;
  tag?: string;
  q?: string;
  // Filters — passed through to Chowdeck; unknown values are ignored server-side.
  sort?: string; // e.g. "rating" | "delivery_time" | "distance"
  open_now?: boolean;
  min_rating?: number;
  max_delivery_fee?: number;
  free_delivery?: boolean;
  page?: number;
}) {
  const id = params.address_id ?? session.addressId;
  if (!id) throw new Error("No address set. Call set_address first.");
  return (await client().get("/customer/vendor/v2", { params: { address_id: id, ...params } })).data;
}

export async function getFeaturedVendors(tag: "featured" | "handpicked" | "explore") {
  if (!session.addressId) throw new Error("No address set. Call set_address first.");
  return (await client().get("/customer/vendor/special/v2", {
    params: { tag, address_id: session.addressId },
  })).data;
}

export async function getMenuCategories(vendorId: number) {
  return (await client().get(`/customer/vendor/${vendorId}/menu-category`)).data;
}

export async function getMenu(vendorId: number, category?: string) {
  const res = (await client().get(`/customer/vendor/${vendorId}/menu`, {
    params: { return_out_of_stock: 1 },
  })).data;
  // Optional client-side category filter so large menus stay small enough to
  // avoid response truncation (e.g. items in smaller categories getting cut off).
  if (category && Array.isArray(res?.data)) {
    const needle = category.trim().toLowerCase();
    if (needle) {
      res.data = res.data.filter((item: any) => item?.category?.name?.toLowerCase().includes(needle));
    }
  }
  return res;
}

export async function getMenuItem(vendorId: number, menuId: number) {
  return (await client().get(`/customer/vendor/${vendorId}/menu/${menuId}`)).data;
}

export async function searchVendors(
  q: string,
  filters: { sort?: string; open_now?: boolean; min_rating?: number } = {},
) {
  if (!session.addressId) throw new Error("No address set. Call set_address first.");
  return (await client().get("/customer/search", {
    params: { text: q, address_id: session.addressId, ...filters },
  })).data;
}

// ── Favourites / saved vendors ──────────────────────────────────────────────
// Best-effort: endpoint paths inferred from Chowdeck's REST conventions and may
// need adjusting. Each returns the API response (or error) verbatim.

export async function listFavorites() {
  return (await client().get("/customer/vendor/v2", { params: { is_favourite: true, address_id: session.addressId } })).data;
}
export async function addFavorite(vendorId: number) {
  return (await client().post(`/customer/vendor/${vendorId}/like/1`, {})).data;
}
export async function removeFavorite(vendorId: number) {
  return (await client().post(`/customer/vendor/${vendorId}/like/0`, {})).data;
}
// Native repeat endpoint preserves the original order's options and packs.
export async function reorder(orderId: string) {
  return (await client().post(`/customer/order/${encodeURIComponent(orderId)}/repeat`, {})).data;
}

// ── Cart ──────────────────────────────────────────────────────────────────────

export async function getCarts() {
  return (await client().get("/customer/cart")).data;
}

export async function clearCarts() {
  return (await client().delete("/customer/cart/clear")).data;
}

export async function deleteCart(cartId: number) {
  return (await client().delete(`/customer/cart/${cartId}`)).data;
}

export async function getCartByVendor(vendorId: number) {
  return (await client().get(`/customer/cart/vendor/${vendorId}`)).data;
}

export async function createOrUpdateCart(body: {
  vendor_id: number;
  items: { item_id: number; quantity: number; type?: string; pack_reference?: string }[];
  address_id?: number;
  class?: string;
}) {
  const payload = {
    source: "web",
    app_version: APP_VERSION,
    class: "delivery",
    address_id: session.addressId,
    ...body,
  };
  // If a cart already exists for this vendor, update it via the vendor endpoint;
  // otherwise create a fresh cart. POST /customer/cart only creates.
  let existing: any = null;
  try {
    existing = (await getCartByVendor(body.vendor_id))?.data;
  } catch {
    existing = null;
  }
  const res = existing?.id
    ? (await client().post(`/customer/cart/vendor/${body.vendor_id}`, payload)).data
    : (await client().post("/customer/cart", payload)).data;
  if (res?.data?.guest_id) session.guestId = res.data.guest_id;
  return res;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

// Chowdeck's login/validate-otp endpoints reject E.164 (+234...) but accept the
// local Nigerian format. Normalize to 0XXXXXXXXXX.
export function normalizePhone(phone: string): string {
  let p = phone.replace(/[^\d]/g, "");
  if (p.startsWith("234")) p = p.slice(3);
  if (p.length === 10) p = "0" + p; // missing leading zero
  if (!p.startsWith("0")) p = "0" + p;
  // A Nigerian mobile number is 11 digits (0 + 10). Reject anything else so we
  // never fire an OTP at a malformed number.
  if (!/^0\d{10}$/.test(p)) {
    throw new Error(`"${phone}" is not a valid Nigerian phone number (expected 11 digits, e.g. 08012345678).`);
  }
  return p;
}

export async function validatePhone(phone: string, country_code = "NG") {
  return (await client().post("/auth/phone/validate", { phone: normalizePhone(phone), country_code })).data;
}

export async function sendLoginOtp(phone: string, country_code = "NG") {
  return (await client().post("/auth/login", { phone: normalizePhone(phone), country_code, role: "customer" })).data;
}

export async function verifyOtp(phone: string, otp: string, country_code = "NG") {
  const res = (await client().post("/auth/login/validate-otp", {
    otp, phone: normalizePhone(phone), country_code, role: "customer",
  })).data;
  const token = res?.data?.token ?? res?.data?.access_token;
  if (token) {
    session.token = token;
    // upgrade guest cart if we had one
    if (session.guestId) {
      await client().patch("/customer/cart/guest/upgrade").catch(() => null);
    }
  }
  return { ...res, data: { ...res?.data, token: undefined, access_token: undefined } };
}

export async function getMe() {
  return (await client().get("/auth/me?currency=NGN")).data;
}

// ── Account (authenticated) ─────────────────────────────────────────────────────

export async function listAddresses() {
  return (await client().get("/customer/address")).data;
}

export async function getActiveAddress() {
  const res: any = await listAddresses();
  const list: any[] = res?.data ?? [];
  const active =
    list.find((a) => a.is_current) ??
    list.find((a) => a.is_active) ??
    [...list].sort((a, b) => +new Date(b.last_used ?? 0) - +new Date(a.last_used ?? 0))[0] ??
    null;
  return active;
}

export async function setActiveAddress(addressId: number) {
  // Tells Chowdeck which saved address is active; also used by us to set session.
  return (await client().post("/customer/address/set-active", { address_id: addressId })).data;
}

export async function getWallet() {
  return (await client().get("/customer/wallet", {
    params: { currency: "NGN", new_response: true },
  })).data;
}

export async function getOrderHistory(status?: string) {
  return (await client().get("/customer/order", {
    params: status ? { status } : {},
    headers: { "x-chowdeck-api-version": "v2" },
  })).data;
}

// ── Orders ────────────────────────────────────────────────────────────────────

export async function getActiveOrders() {
  return (await client().get("/customer/order", {
    params: { status: "active" },
    headers: { "x-chowdeck-api-version": "v2" },
  })).data;
}

export async function getOrder(orderId: string) {
  return (await client().get(`/customer/order/${orderId}`)).data;
}

// Compact live-tracking view of an order: status, ETA, rider, delivery PIN, and
// tracking link — shaped from the full order so the agent gets just what matters.
export async function trackOrder(orderId: string) {
  const raw: any = await getOrder(orderId);
  const o = raw?.data ?? raw;
  if (!o) return raw;
  const driver = o.driver ?? o.rider ?? {};
  return {
    order_id: o.id ?? o.reference ?? orderId,
    status: o.status ?? o.state,
    status_label: o.status_label ?? o.tracking_status,
    placed_at: o.created_at,
    eta: o.estimated_delivery_time ?? o.eta ?? o.delivery_eta,
    scheduled_for: o.scheduled_for ?? null,
    delivery_pin: o.delivery_pin ?? o.pin ?? null,
    rider: driver?.rider_name || driver?.name || driver?.phone
      ? { name: driver.rider_name ?? driver.name, phone: driver.phone, lat: driver.latitude, lng: driver.longitude }
      : null,
    payment_status: o.payment_status ?? o.payment?.status,
    total: o.total ?? o.amount ?? o.order_total,
    vendor: o.vendor?.name ?? o.vendor_name,
    tracking_url: o.tracking_url ?? (o.id ? `https://chowdeck.com/store/track/${o.id}` : undefined),
  };
}

// ── Cancel order ─────────────────────────────────────────────────────────────
// Cancel a placed, not-yet-fulfilled order. Any refund goes to the Chowdeck
// wallet.
export async function cancelOrder(orderId: string, reason = "") {
  return (await client().post(`/customer/order/${orderId}/cancel`, { reason })).data;
}

// ── Tip rider ────────────────────────────────────────────────────────────────
// Tip the rider for an order. Amount is in KOBO (50000 = ₦500), matching the
// value the storefront sends to this endpoint; paid from the wallet by default.
// NOTE: this differs from place_order's rider_tip, which is in naira.
export async function tipRider(orderId: string, amountKobo: number, paymentMethod = "wallet") {
  return (await client().post(`/customer/order/${orderId}/tip`, { amount: amountKobo, payment_method: paymentMethod })).data;
}

// ── Notifications ─────────────────────────────────────────────────────────────
export async function getNotifications() {
  return (await client().get("/customer/notification")).data;
}

// ── Promo / voucher ─────────────────────────────────────────────────────────
// Best-effort: validate a promo code (optionally scoped to a vendor/cart). The
// confirmed code can then be passed to place_order via promo_codes.
export async function validatePromo(code: string, opts: { vendor_id?: number; cart_id?: number } = {}) {
  return (await client().post(`/customer/promo-code/${encodeURIComponent(code)}`, { currency: "NGN" })).data;
}

// The storefront converts entered naira to kobo before funding a wallet.
export async function walletTopup(amount: number, channel = "card") {
  return (await client().post("/customer/payment/start", {
    amount: Math.round(amount * 100), destination: "wallet", method: channel, currency: "NGN",
  })).data;
}

// Initialize a Paystack payment for an unpaid (online_payment) order. Returns
// access_code + authorization_url (the Paystack checkout link). method is the
// payment channel name from get_payment_channels, e.g. "card" or "bank_transfer".
// Must be called promptly after placing the order — unpaid orders are abandoned
// within a few minutes.
export async function startOrderPayment(orderId: number, method: string, callbackUrl?: string) {
  return (await client().post(`/order/${orderId}/payment`, {
    method,
    callback_url: callbackUrl ?? "https://chowdeck.com/store/track",
  })).data;
}

// ── Checkout ──────────────────────────────────────────────────────────────────

export async function getPaymentMethods() {
  return (await client().get("/customer/payment/methods", { params: { currency: "NGN" } })).data;
}

export async function getPaymentChannels(country_identifier = "NG") {
  return (await client().get("/customer/payment/channel", {
    params: { country_identifier },
  })).data;
}

export async function getVendor(vendorId: number) {
  return (await client().get(`/customer/vendor/${vendorId}`, {
    params: { address_id: session.addressId },
  })).data;
}

// Delivery fee. Chowdeck wants destination_id (customer address), source_id
// (vendor address), vendor_id, order_class, and cart_id. We auto-resolve the
// vendor's address_id if not supplied.
export async function getDeliveryFee(body: {
  address_id?: number;
  vendor_id: number;
  cart_id?: number;
  destination_id?: number;
  source_id?: number;
  order_class?: string;
}) {
  let sourceId = body.source_id;
  if (!sourceId) {
    const v: any = await getVendor(body.vendor_id);
    sourceId = v?.data?.address_id;
  }
  const payload: Record<string, unknown> = {
    destination_id: body.destination_id ?? body.address_id ?? session.addressId,
    order_class: body.order_class ?? "delivery",
    source_id: sourceId,
    vendor_id: body.vendor_id,
  };
  if (body.cart_id) payload.cart_id = body.cart_id;
  return (await client().post("/customer/delivery/amount", payload)).data;
}

export type GiftRecipient = {
  donor_name: string;
  name: string;
  phone: string;
  country_code: string;
  email?: string;
  message?: string;
  save_as_beneficiary?: boolean;
};

export type OrderInput = {
  vendor_id: number;
  cart_id: number;
  idempotency_key?: string;
  allow_repeat?: boolean;
  max_total_naira?: number;
  expected_total_naira?: number;
  fee_id?: number;
  payment_method: "card" | "wallet" | "online_payment" | "pay_for_me";
  payment_method_id?: number;
  online_channel?: string;
  address_id?: number;
  promo_codes?: string[];
  customer_vendor_note?: string;
  customer_delivery_note?: string;
  split_payment_with_wallet?: boolean;
  gift_recipient?: GiftRecipient;
  order_class?: "delivery" | "pickup" | "vendor_delivery" | "preorder_delivery";
  delivery_date?: string;
  earliest_delivery_time?: string;
  latest_delivery_time?: string;
  scheduled_for?: string;
  rider_tip?: number;
};

/** Pure payload builder, independently testable without charging an account. */
export function buildOrderPayload(body: OrderInput, cart: any) {
  if (!cart?.id || Number(cart.id) !== body.cart_id) throw new Error("Cart changed: refresh checkout before ordering.");
  if (!cart.cart_items?.length) throw new Error("Cart is empty.");
  const orderClass = body.order_class ?? cart.class ?? "delivery";
  if (!["delivery", "pickup", "vendor_delivery", "preorder_delivery"].includes(orderClass)) throw new Error("Unsupported order class.");
  if (body.scheduled_for) throw new Error("Use preorder_delivery with delivery_date and the vendor's earliest/latest_delivery_time; arbitrary scheduling is unsupported.");
  if (body.payment_method === "card" && !body.payment_method_id) throw new Error("Saved card payment requires payment_method_id.");
  if (body.payment_method === "wallet" && body.split_payment_with_wallet) throw new Error("Wallet splitting requires a second payment method.");
  if (orderClass === "pickup" && body.gift_recipient) throw new Error("Gift delivery is unavailable for pickup orders.");
  if (orderClass !== "pickup" && (!body.fee_id || !(body.address_id ?? session.addressId))) throw new Error("Delivery requires a quoted fee_id and address_id.");
  if (orderClass === "preorder_delivery" && (!body.delivery_date || !body.earliest_delivery_time || !body.latest_delivery_time)) throw new Error("Select a vendor preorder delivery date and time window.");
  // Checkout from cart preserves the server's packs, containers and modifiers.
  // Reconstructing all items as pack_id:1 silently merges separate meal packs.
  const payload: Record<string, unknown> = {
    source: "web", app_version: APP_VERSION, vendor_id: body.vendor_id,
    cart_id: body.cart_id, class: orderClass, checkout_from_cart: true,
    requires_delivery_pin: orderClass !== "pickup", payment_method: body.payment_method,
    bag_quantity: cart.bag_quantity ?? 0, promo_codes: body.promo_codes ?? [],
    currency: "NGN", country_code: "NG",
    customer_vendor_note: body.customer_vendor_note ?? cart.customer_vendor_note ?? "",
    customer_delivery_note: body.customer_delivery_note ?? cart.customer_delivery_note ?? "",
    gift_recipient: body.gift_recipient ? { ...body.gift_recipient, phone: normalizePhone(body.gift_recipient.phone), save_as_beneficiary: body.gift_recipient.save_as_beneficiary ?? false } : null,
    split_payment_with_wallet: body.split_payment_with_wallet ?? false,
  };
  if (body.payment_method === "pay_for_me") payload.has_external_payment = true;
  if (body.payment_method === "card") payload.payment_method_id = body.payment_method_id;
  if (orderClass !== "pickup") Object.assign(payload, { fee_id: body.fee_id, address_id: body.address_id ?? session.addressId });
  if (orderClass === "preorder_delivery") Object.assign(payload, { delivery_date: body.delivery_date, earliest_delivery_time: body.earliest_delivery_time, latest_delivery_time: body.latest_delivery_time });
  if (body.rider_tip) payload.tip = Math.round(body.rider_tip * 100);
  return payload;
}

function stableStringify(value: any): string {
  const normalize = (v: any): any => Array.isArray(v) ? v.map(normalize) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])])) : v;
  return JSON.stringify(normalize(value));
}
function orderFingerprint(body: OrderInput, cart: any) {
  const items = (cart.cart_items ?? []).map((item: any) => ({ id: item.item_id, quantity: item.quantity, type: item.type, pack: item.pack_reference, group: item.menu_group_id })).sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify({ vendor: body.vendor_id, items, address: body.address_id ?? session.addressId, recipient: body.gift_recipient ? normalizePhone(body.gift_recipient.phone) : null })).digest("hex");
}
function saveAttempt(key: string, attempt: any) {
  const attempts = { ...(session.data?.orderAttempts ?? {}), [key]: attempt };
  const entries = Object.entries(attempts).sort((a: any, b: any) => b[1].at - a[1].at).slice(0, 100);
  session.data = { ...session.data, orderAttempts: Object.fromEntries(entries) };
}
export async function placeOrder(body: OrderInput) {
  const requestedAt = Date.now();
  if (!session.token) throw new Error("Sign in to Chowdeck before ordering.");
  const requestSignature = createHash("sha256").update(stableStringify({ ...body, allow_repeat: undefined })).digest("hex");
  const existingRequest = body.idempotency_key ? session.data?.orderAttempts?.[body.idempotency_key] : null;
  if (existingRequest && existingRequest.status !== "rejected") {
    if (existingRequest.request_signature && existingRequest.request_signature !== requestSignature) throw new Error("Idempotency key was already used for a different order.");
    if (existingRequest.status === "completed") return { ...existingRequest.result, idempotent_replay: true };
    let active = null; try { active = await getActiveOrders(); } catch {}
    return { status: "unknown", idempotency_key: body.idempotency_key, matching_active_orders: active, message: "A previous placement may have succeeded. Do not place another order; reconcile the existing attempt first." };
  }
  if (body.max_total_naira !== undefined || body.expected_total_naira !== undefined) {
    const preview = await prepareCheckout(body.vendor_id, body.address_id, { promo_codes: body.promo_codes, rider_tip: body.rider_tip, max_total_naira: body.max_total_naira, payment_method: body.payment_method });
    if (!preview.summary.ready) throw new Error(`Checkout blocked: ${JSON.stringify(preview.summary.issues)}`);
    if (body.expected_total_naira !== undefined && preview.summary.total_kobo !== Math.round(body.expected_total_naira * 100)) throw new Error("The live total changed. Show the new preview and obtain approval again.");
    if (preview.delivery_fee?.data?.id) body = { ...body, fee_id: preview.delivery_fee.data.id };
  }
  const cart = (await getCartByVendor(body.vendor_id))?.data;
  const payload = buildOrderPayload(body, cart);
  const fingerprint = orderFingerprint(body, cart);
  const key = body.idempotency_key ?? `cart-${body.cart_id}-${fingerprint}`;
  const previous = session.data?.orderAttempts?.[key];
  if (previous && previous.status !== "rejected") {
    if (previous.fingerprint !== fingerprint) throw new Error("Idempotency key was already used for a different order.");
    if (previous.status === "completed") return { ...previous.result, idempotent_replay: true };
    let active = null; try { active = await getActiveOrders(); } catch {}
    return { status: "unknown", idempotency_key: key, matching_active_orders: active, message: "A previous placement may have succeeded. Do not place another order; reconcile the existing attempt first." };
  }
  const duplicate: any = Object.values(session.data?.orderAttempts ?? {}).find((a: any) => a.fingerprint === fingerprint && Date.now() - a.at < 600000 && a.status !== "rejected");
  if (duplicate && !body.allow_repeat) return { duplicate_order_blocked: true, previous_order_id: duplicate.result?.data?.id, message: "A matching order was attempted within ten minutes. Inspect it before a new order. allow_repeat requires fresh explicit approval for an intentional second order." };
  const attempt = { at: requestedAt, fingerprint, request_signature: requestSignature, status: "pending", cart_id: body.cart_id, vendor_id: body.vendor_id };
  saveAttempt(key, attempt);
  await persistNow(); // Durable reservation BEFORE the charge, including on hosted restarts.
  let result: any;
  try {
    result = (await client().post("/customer/order", payload)).data;
  } catch (error: any) {
    const status = error.response?.status;
    saveAttempt(key, { ...attempt, status: status && status >= 400 && status < 500 && status !== 408 ? "rejected" : "unknown" });
    await persistNow();
    if (!status || status >= 500 || status === 408) {
      let active = null; try { active = await getActiveOrders(); } catch {}
      return { status: "unknown", idempotency_key: key, matching_active_orders: active, message: "Order placement outcome is unknown. No retry was made. Check active orders/history before any further placement." };
    }
    throw error;
  }
  if (body.payment_method === "online_payment" && result?.data?.id) {
    try {
      const payment = await startPayment({ order_id: result.data.id, method: body.online_channel ?? "card", split_payment_with_wallet: body.split_payment_with_wallet });
      result.data.payment = payment?.data ?? payment;
    } catch {
      result.data.payment_error = "Order created; payment initialization failed. Check get_order_payment_status before retrying payment. Do not place another order.";
    }
  }
  saveAttempt(key, { ...attempt, status: result?.data?.id ? "completed" : "unknown", result });
  const orderLog = [...(session.data?.orderLog ?? []), { order_id: result?.data?.id, requested_at: new Date(attempt.at).toISOString(), placed_at: new Date().toISOString(), seconds_to_place: (Date.now() - attempt.at) / 1000, vendor_id: body.vendor_id, recipient: body.gift_recipient?.name ?? "self", payment_method: body.payment_method, total: result?.data?.total ?? result?.data?.amount, total_naira: body.expected_total_naira ?? (typeof result?.data?.total === "number" ? result.data.total / 100 : undefined), delivery_pin: result?.data?.delivery_pin ?? result?.data?.pin, idempotency_key: key }].slice(-100);
  session.data = { ...session.data, orderLog };
  await persistNow();
  return result;
}

// Endpoints observed in the public Chowdeck storefront on 2026-10-26.
export async function listBeneficiaries() {
  return (await client().get("/customer/beneficiary")).data;
}
export async function getOrderTimeline(orderId: string) {
  return (await client().get(`/customer/order/${encodeURIComponent(orderId)}/timeline`)).data;
}
export async function getLiveTracking(orderId: string) {
  return (await client().get(`/customer/order/${encodeURIComponent(orderId)}/live-tracking`)).data;
}
export async function updateDeliveryNote(orderId: string, note: string) {
  return (await client().put(`/customer/order/${encodeURIComponent(orderId)}/delivery`, { customer_delivery_note: note })).data;
}
export async function duplicatePack(cartId: number, packRef: string) {
  return (await client().post(`/customer/cart/${cartId}/pack/${encodeURIComponent(packRef)}/duplicate`)).data;
}
export async function deletePack(cartId: number, packRef: string) {
  return (await client().delete(`/customer/cart/${cartId}/pack/${encodeURIComponent(packRef)}`)).data;
}

export type CheckoutOptions = { promo_codes?: string[]; rider_tip?: number; max_total_naira?: number; payment_method?: string };

export function checkoutItems(cart: any) {
  const packs = new Map<string, number>();
  const items: any[] = [], containers: any[] = [];
  for (const item of cart.cart_items ?? []) {
    const reference = String(item.pack_reference ?? "default");
    if (!packs.has(reference)) packs.set(reference, packs.size + 1);
    const pack_id = packs.get(reference);
    if (item.type === "container") containers.push({ id: item.item_id, quantity: item.quantity, name: item.name, price: item.price_per_quantity, type: "container", pack_id });
    else items.push({ item_id: item.item_id, quantity: item.quantity, type: item.type ?? "menu", pack_id, pack_unique_id: reference, ...(item.menu_group_id ? { group_id: item.menu_group_id } : {}) });
  }
  return { items, containers };
}
export async function getVirtualAccount() {
  return (await client().get("/auth/virtual-account", { params: { currency: "NGN" } })).data;
}
export function summarizeCheckout(cart: any, vendor: any, wallet: any, fee: any, config: any, discounts: any[], opts: CheckoutOptions = {}) {
  const issues: any[] = [];
  const entries = cart.cart_items ?? [];
  const finite = (n: any) => typeof n === "number" && Number.isFinite(n);
  if (!entries.length) issues.push({ code: "empty_cart" });
  if (vendor.is_open === false && cart.class !== "preorder_delivery") issues.push({ code: "vendor_closed" });
  if (cart.is_valid === false) issues.push({ code: "cart_invalid", items: cart.validation_result ?? [] });
  const out = entries.filter((item: any) => item.in_stock === false || item.is_available === false);
  if (out.length) issues.push({ code: "out_of_stock", items: out.map((item: any) => ({ id: item.item_id, name: item.name })) });
  const priced = entries.length > 0 && entries.every((item: any) => finite(item.price_per_quantity) && finite(item.quantity));
  const subtotal = priced ? entries.reduce((sum: number, item: any) => sum + item.price_per_quantity * item.quantity, 0) : cart.total_price;
  const bagQuantity = Number(cart.bag_quantity ?? 0);
  const bagPrice = config.bag_information?.amount;
  const complete = finite(subtotal) && (bagQuantity === 0 || finite(bagPrice)) && (cart.class === "pickup" || (finite(fee?.final_delivery_amount) && finite(fee?.final_service_amount)));
  const discount = discounts.reduce((sum, item) => sum + Number(item.amount_off ?? 0) + Number(item.bogof_amount_off ?? 0), 0);
  const bogof = discounts.filter(item => item.target === "bogof").reduce((sum, item) => sum + Number(item.bogof_amount_off ?? 0), 0);
  const total = complete ? Math.max(0, Math.round(subtotal + bogof + Number(fee?.final_delivery_amount ?? 0) + Number(fee?.final_service_amount ?? 0) + bagQuantity * Number(bagPrice ?? 0) - discount + Math.round((opts.rider_tip ?? 0) * 100))) : null;
  if (!complete) issues.push({ code: "quote_incomplete", message: "Missing price/fee/bag fields: do not place until a full live total is available." });
  const minimum = vendor.minimum_order_amount;
  if (finite(minimum) && finite(subtotal) && subtotal < minimum) issues.push({ code: "below_minimum_order", minimum_naira: minimum / 100, shortfall_naira: (minimum - subtotal) / 100 });
  const balance = wallet.total_balance;
  const shortfall = total !== null && finite(balance) ? Math.max(0, total - balance) : null;
  if ((opts.payment_method ?? "wallet") === "wallet" && shortfall !== null && shortfall > 0) issues.push({ code: "wallet_shortfall", shortfall_naira: shortfall / 100 });
  if (total !== null && opts.max_total_naira !== undefined && total > Math.round(opts.max_total_naira * 100)) issues.push({ code: "over_budget", max_total_naira: opts.max_total_naira, total_naira: total / 100 });
  return { complete, total_kobo: total, total_naira: total === null ? null : total / 100, subtotal_naira: finite(subtotal) ? subtotal / 100 : null, delivery_naira: Number(fee?.final_delivery_amount ?? 0) / 100, service_naira: Number(fee?.final_service_amount ?? 0) / 100, bags_naira: bagQuantity * Number(bagPrice ?? 0) / 100, discount_naira: discount / 100, wallet_balance_naira: finite(balance) ? balance / 100 : null, shortfall_naira: shortfall === null ? null : shortfall / 100, issues, ready: complete && issues.length === 0 };
}
/** One round trip from the agent; independent API reads execute together. */
export async function prepareCheckout(vendorId: number, addressId?: number, opts: CheckoutOptions = {}) {
  const [cart, vendor, wallet, methods, beneficiaries, config] = await Promise.all([
    getCartByVendor(vendorId), getVendor(vendorId), getWallet(), getPaymentMethods(), listBeneficiaries(), getConfig(),
  ]);
  if (!cart?.data?.id) throw new Error("Build a cart before preparing checkout.");
  const fee = cart.data.class === "pickup" ? null : await getDeliveryFee({ vendor_id: vendorId, cart_id: Number(cart.data.id), address_id: addressId, source_id: vendor?.data?.address_id, order_class: cart.data.class });
  const { items, containers } = checkoutItems(cart.data);
  const applied: any = (await client().post("/customer/discount/apply", { promo_codes: opts.promo_codes ?? [], vendor_id: vendorId, address_id: addressId ?? session.addressId, fee_id: fee?.data?.id ?? 0, cart_id: cart.data.id, currency: "NGN", order_items: items, containers, delivery_fee: fee?.data?.final_delivery_amount ?? 0, order_class: cart.data.class === "vendor_delivery" ? "delivery" : cart.data.class ?? "delivery" })).data;
  if (!Array.isArray(applied?.data)) throw new Error("Could not obtain a complete discount quote; do not place this order.");
  const summary = summarizeCheckout(cart.data, vendor?.data ?? {}, wallet?.data ?? {}, fee?.data, config?.data ?? {}, applied.data, opts);
  return { monetary_units: "Raw Chowdeck monetary values are kobo (100 kobo = 1 NGN). Fields ending _naira are NGN.", summary, cart, vendor, wallet, payment_methods: methods, beneficiaries, delivery_fee: fee, discounts: applied.data, address_id: addressId ?? session.addressId, needs_confirmation: true, message: "Review the live total, items, address, recipient and payment method before placement. This call did not place an order." };
}

export async function startPayment(body: {
  order_id: number;
  method: string;
  pocket_tag?: string;
  split_payment_with_wallet?: boolean;
  return_url?: string;
}) {
  return (await client().post("/customer/payment/start/v2", body)).data;
}

export async function verifyPayment(transactionId: string) {
  return (await client().get(`/customer/payment/verify/${transactionId}`)).data;
}

export async function getOrderPaymentStatus(orderId: string) {
  return (await client().get(`/order/${orderId}/payment`)).data;
}
