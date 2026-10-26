import * as api from "./api.js";
import { session, persistNow } from "./session.js";
import { Buffer } from "node:buffer";

export type Recipient = { name: string; phone: string; donor_name: string; address_id: number; rider_note?: string; country_code?: string; is_default?: boolean };
const key = (name: string) => name.trim().toLocaleLowerCase();
export function recipients() { return Object.values(session.data?.recipients ?? {}) as Recipient[]; }
export async function saveRecipient(profile: Recipient) {
  const normalized = { ...profile, phone: api.normalizePhone(profile.phone), country_code: "NG" };
  const profiles = { ...(session.data?.recipients ?? {}) };
  if (profile.is_default) for (const name of Object.keys(profiles)) profiles[name] = { ...profiles[name], is_default: false };
  profiles[key(profile.name)] = normalized;
  session.data = { ...session.data, recipients: profiles };
  await persistNow();
  return { saved: true, recipient: normalized };
}
export function getRecipient(name?: string): Recipient {
  const profile = name ? session.data?.recipients?.[key(name)] : recipients().find(p => p.is_default);
  if (!profile) throw new Error("Choose and save a recipient profile with the correct phone, address and rider note first. No recipient was guessed.");
  return profile;
}
export async function saveRecipe(name: string, orderId: string, expectedTotal?: number) {
  const recipe = { name, order_id: orderId, expected_total_naira: expectedTotal };
  session.data = { ...session.data, recipes: { ...(session.data?.recipes ?? {}), [key(name)]: recipe } };
  await persistNow();return { saved: true, recipe };
}
export async function reorderGift(args: { order_id?: string; favourite_name?: string; recipient?: string; max_total_naira: number; request_id: string }) {
  const profile = getRecipient(args.recipient);
  const recipe = args.favourite_name ? session.data?.recipes?.[key(args.favourite_name)] : null;
  const orderId = args.order_id ?? recipe?.order_id;
  if (!orderId) throw new Error("Provide a previous order_id or a saved favourite_name.");
  const previousDraft = session.data?.reorderDrafts?.[args.request_id];
  if (previousDraft && (previousDraft.order_id !== orderId || previousDraft.recipient !== profile.name)) throw new Error("request_id belongs to a different draft; use a new request id.");
  let vendorId = previousDraft?.vendor_id;
  if (!previousDraft) {
    const order = (await api.getOrder(orderId))?.data;
    vendorId = order?.vendor_id ?? order?.vendor?.id;
    if (!vendorId) throw new Error("Could not identify the original vendor.");
    await api.reorder(orderId);
    session.data = { ...session.data, reorderDrafts: { ...(session.data?.reorderDrafts ?? {}), [args.request_id]: { order_id: orderId, vendor_id: vendorId, recipient: profile.name, created_at: Date.now() } } };
    await persistNow();
  }
  const preview = await api.prepareCheckout(vendorId, profile.address_id, { max_total_naira: args.max_total_naira, payment_method: "wallet" });
  const place_order_args = preview.summary.ready ? { vendor_id: vendorId, cart_id: Number(preview.cart.data.id), fee_id: preview.delivery_fee?.data?.id, address_id: profile.address_id, gift_recipient: { name: profile.name, phone: profile.phone, donor_name: profile.donor_name, country_code: "NG" }, customer_delivery_note: profile.rider_note ?? "", payment_method: "wallet", expected_total_naira: preview.summary.total_naira, max_total_naira: args.max_total_naira, idempotency_key: args.request_id } : null;
  return { recipient: profile, preview, price_changed: recipe?.expected_total_naira !== undefined && preview.summary.total_naira !== recipe.expected_total_naira, place_order_args, needs_confirmation: true, message: "Gift cart prepared. Nothing was purchased. Approve this exact live preview before passing confirm:true to place_order." };
}
export async function sessionStatus() {
  if (!session.token) return { authenticated: false, status: "reauth_required", otp_sent: false };
  try {
    await api.getMe(); // The API client silently refreshes only when necessary.
    let expires_at: string | null = null;
    try { const decoded = JSON.parse(Buffer.from(session.token.split(".")[1], "base64url").toString()); if (typeof decoded.exp === "number") expires_at = new Date(decoded.exp * 1000).toISOString(); } catch {}
    return { authenticated: true, status: "healthy", expires_at, automatic_refresh: true, otp_sent: false };
  } catch { return { authenticated: false, status: "reauth_required", automatic_refresh: true, otp_sent: false, message: "The service could not validate/renew the session. A fresh sign-in may be needed. No OTP was sent." }; }
}
export async function findItem(vendorId: number, query: string) {
  const menu = await api.getMenu(vendorId);
  const target = query.toLocaleLowerCase().trim();
  const candidates: any[] = [];
  function visit(value: any, path: string[], parent?: any, depth = 0) {
    if (depth > 14 || !value) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, path, parent, depth + 1);return; }
    if (typeof value !== "object") return;
    const name = value.name ?? value.title;
    const current = typeof name === "string" ? [...path, name] : path;
    if (typeof name === "string" && value.id !== undefined && name.toLocaleLowerCase().includes(target)) candidates.push({ id: value.id, name, path: current, parent: parent?.name, price_kobo: value.price ?? value.price_per_quantity, exact: name.toLocaleLowerCase() === target, required: value.required ?? parent?.required, in_stock: value.in_stock });
    for (const [field, child] of Object.entries(value)) if (child && typeof child === "object" && !["vendor", "images", "image", "cover_images"].includes(field)) visit(child, current, value, depth + 1);
  }
  visit(menu, []);
  candidates.sort((a, b) => Number(b.exact) - Number(a.exact));
  return { vendor_id: vendorId, query, ambiguous: candidates.length > 1, candidates: candidates.slice(0, 30), cart_changed: false };
}
export async function alternatives(query: string, vendorType?: string) {
  const result = await api.getVendors({ vendor_type: vendorType, open_now: true, sort: "distance" });
  const list = Array.isArray(result?.data) ? result.data : result?.data?.vendors ?? result?.data?.data ?? [];
  const checked = await Promise.all(list.slice(0, 8).map(async (candidate: any) => {
    try { const vendor = (await api.getVendor(candidate.id))?.data;if (vendor?.is_open !== true) return null;const items = await findItem(candidate.id, query);return items.candidates.length ? { vendor_id: candidate.id, vendor: vendor.name, distance: vendor.distance, delivery_price_kobo: vendor.delivery_price, matches: items.candidates } : null; } catch { return null; }
  }));
  return { query, alternatives: checked.filter(Boolean), checked_vendor_limit: 8, substituted: false, message: "These are live menu candidates, not guaranteed equivalent products. Choose explicitly before adding anything." };
}
export function orderLog(last: number) { return (session.data?.orderLog ?? []).slice(-last).reverse(); }
export async function checkRefund(orderId: string) {
  const [order, wallet, timeline] = await Promise.all([api.getOrder(orderId), api.getWallet(), api.getOrderTimeline(orderId)]);
  const data = order?.data ?? {};
  const previous = session.data?.refundChecks?.[orderId];
  const balance = wallet?.data?.total_balance;
  const explicitRefund = data.refund ?? data.refund_amount ?? data.refund_status;
  const result = { order_id: orderId, status: data.status, timeline, refund_state: explicitRefund === undefined ? "unverified" : explicitRefund, wallet_balance_naira: typeof balance === "number" ? balance / 100 : null, wallet_change_since_last_check_naira: typeof balance === "number" && typeof previous?.balance === "number" ? (balance - previous.balance) / 100 : null, message: "A balance change alone is not proof of this order's refund. Use explicit order/refund evidence." };
  session.data = { ...session.data, refundChecks: { ...(session.data?.refundChecks ?? {}), [orderId]: { balance, checked_at: Date.now() } } };await persistNow();return result;
}
export async function shortfall(vendorId: number, addressId?: number) {
  const preview = await api.prepareCheckout(vendorId, addressId, { payment_method: "wallet" });
  const account = preview.summary.shortfall_naira !== null && preview.summary.shortfall_naira > 0 ? await api.getVirtualAccount() : null;
  return { summary: preview.summary, topup_account_from_live_api: account, cart_preserved: true, transfer_initiated: false, message: "No funds were moved and no other bot was messaged. Any top-up needs its own explicit approval." };
}
