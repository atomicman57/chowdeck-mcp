#!/usr/bin/env node
/*!
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  Chowdeck MCP — Model Context Protocol server for Chowdeck food delivery    │
 * │                                                                            │
 * │  Author : Hendrix Nwaokolo  (@thathman)                                    │
 * │  Contact: hello@airixmedia.com                                             │
 * │  Source : https://github.com/thathman/chowdeck-mcp                         │
 * │  License: MIT — see LICENSE.                                                │
 * │                                                                            │
 * │  © 2026 Hendrix Nwaokolo.  Unofficial; not affiliated with Chowdeck.        │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as api from "./api.js";
import * as workflows from "./workflows.js";
import * as media from "./media.js";
import * as fast from "./fast.js";
import * as quick from "./quick.js";
import { API_MAP } from "./api-map.js";
import { session, clearSession } from "./session.js";

export function createServer() {
const server = new McpServer({ name: "chowdeck", version: "0.7.0-rc.1" });
// Time every tool, including confirmation no-ops and failures, without changing images.
const registerTool=server.registerTool.bind(server) as any;
(server as any).registerTool=(name:string,config:any,handler:any)=>registerTool(name,{...config,...(config.outputSchema?{outputSchema:{...config.outputSchema,elapsed_ms:z.number()}}:{})},async(...args:any[])=>{
 const started=performance.now();let result:any;
 try{result=await handler(...args);}catch(error:any){result={isError:true,content:[{type:'text',text:JSON.stringify({error:error?.message??'Tool failed'})}]};}
 const elapsed_ms=Math.round(performance.now()-started);
 result.content=(result.content??[]).map((part:any)=>{if(part.type!=='text')return part;try{const data=JSON.parse(part.text);if(data&&typeof data==='object'&&!Array.isArray(data))return {...part,text:JSON.stringify({...data,elapsed_ms})};}catch{}return part;});
 if(result.structuredContent)result.structuredContent={...result.structuredContent,elapsed_ms};
 result._meta={...result._meta,elapsed_ms};return result;
});


// ── Result helpers ──────────────────────────────────────────────────────────

function res(data: unknown): { content: { type: "text"; text: string }[]; structuredContent?: any } {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

/**
 * Recursively drop bulky/irrelevant fields and cap array sizes so large API
 * responses (menus, vendor lists) don't flood the model context. Shape-agnostic
 * and lossless for the fields an agent actually reasons over.
 */
const HEAVY_KEYS = new Set([
  "image", "images", "image_url", "banner", "banner_url", "photo", "photos",
  "thumbnail", "cover", "cover_image", "logo", "icon", "media", "html",
]);
function slim(value: any, depth = 0): any {
  if (Array.isArray(value)) {
    return value.slice(0, 60).map((v) => slim(v, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (HEAVY_KEYS.has(k)) continue;
      if (typeof v === "string" && v.length > 400) {
        out[k] = v.slice(0, 400) + "…";
      } else {
        out[k] = slim(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

async function run(fn: () => Promise<unknown>, opts: { slim?: boolean } = {}) {
  try {
    const data = await fn();
    return res(opts.slim ? slim(data) : data);
  } catch (err: any) {
    const detail = err?.response?.data ?? err?.message ?? String(err);
    return { ...res({ error: detail }), isError: true };
  }
}

/**
 * Confirmation gate for destructive / money-moving tools. They remain fully
 * callable by the agent, but only execute once `confirm:true` is passed — which
 * the agent should set ONLY after the user has explicitly approved.
 */
const CONFIRM = {
  confirm: z
    .boolean()
    .default(false)
    .describe("Set true ONLY after the user has explicitly approved this action. Without it, the call is a no-op that asks you to confirm first."),
};
function needConfirm(action: string) {
  return res({
    needs_confirmation: true,
    message: `This will ${action}. Confirm the details with the user first, then call again with confirm: true.`,
  });
}

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

// ── Session / address ─────────────────────────────────────────────────────────

server.registerTool(
  "set_address",
  {
    description: "Create a delivery address (works as guest). Stores the address id for later calls.",
    inputSchema: {
      street: z.string(),
      pretty_name: z.string(),
      latitude: z.number(),
      longitude: z.number(),
      city: z.string(),
      state: z.string(),
      country: z.string().default("Nigeria"),
      house_no: z.string().optional(),
      area: z.string().optional(),
    },
    annotations: WRITE,
  },
  async (args) => run(() => api.createAddress(args)),
);

server.registerTool(
  "get_session",
  {
    description: "Show current session state. Call this FIRST: if setup_complete is false, run the first-time setup flow (login + address).",
    inputSchema: {},
    outputSchema: {
      authenticated: z.boolean(),
      phone: z.string().nullable().optional(),
      guest_id: z.string().nullable().optional(),
      address_id: z.number().nullable().optional(),
      payment_pref: z.any().optional(),
      setup_complete: z.boolean(),
    },
    annotations: READ,
  },
  async () => {
    const data = {
      authenticated: !!session.token,
      phone: session.phone,
      guest_id: session.guestId,
      address_id: session.addressId,
      payment_pref: session.paymentPref,
      setup_complete: !!session.token && !!session.addressId,
    };
    return { ...res(data), structuredContent: data };
  },
);

server.registerTool(
  "logout",
  {
    description: "Clear the saved session (token, address, guest id) from disk. Requires confirm:true.",
    inputSchema: { ...CONFIRM },
    annotations: DESTRUCTIVE,
  },
  async ({ confirm }) => {
    if (!confirm) return needConfirm("log out and erase the saved session (you'll need to log in again)");
    clearSession();
    return res({ ok: true });
  },
);

// ── Location / geocoding ───────────────────────────────────────────────────────

server.registerTool(
  "search_places",
  {
    description: "Search delivery addresses by text (Chowdeck place autocomplete). Returns predictions with place_id and description. Show these to the user and let THEM pick the correct one.",
    inputSchema: { input: z.string() },
    annotations: READ,
  },
  async ({ input }) => run(() => api.searchPlaces(input)),
);

server.registerTool(
  "place_details",
  {
    description: "Get the exact coordinates and formatted address for a place_id from search_places.",
    inputSchema: { place_id: z.string() },
    annotations: READ,
  },
  async ({ place_id }) => run(() => api.placeDetails(place_id)),
);

server.registerTool(
  "reverse_geocode",
  {
    description: "Turn precise device coordinates (lat/lng) into address candidates. Needs CHOWDECK_MAPS_KEY. Use when the host can provide the user's current GPS location.",
    inputSchema: { latitude: z.number(), longitude: z.number() },
    annotations: READ,
  },
  async ({ latitude, longitude }) => run(() => api.reverseGeocode(latitude, longitude)),
);

server.registerTool(
  "suggest_current_location",
  {
    description: "Rough current city from IP — SUGGESTION ONLY, not delivery-accurate. Use it to seed a search_places query, then have the user confirm the precise address.",
    inputSchema: {},
    annotations: READ,
  },
  async () => run(() => api.ipLocation()),
);

server.registerTool(
  "set_address_from_place",
  {
    description: "Resolve a place_id to exact coordinates and save it as the delivery address. Preferred over set_address — guarantees real coordinates for delivery.",
    inputSchema: { place_id: z.string(), house_no: z.string().optional() },
    annotations: WRITE,
  },
  async ({ place_id, house_no }) => run(() => api.setAddressFromPlace(place_id, house_no)),
);

// ── Discovery ─────────────────────────────────────────────────────────────────

server.registerTool(
  "get_config",
  { description: "Fetch storefront config (verticals, currencies, feature flags).", inputSchema: {}, annotations: READ },
  async () => run(() => api.getConfig(), { slim: true }),
);

server.registerTool(
  "list_vendors",
  {
    description: "List vendors (restaurants, shops, pharmacies...) near the current address, with optional filters.",
    inputSchema: {
      vendor_type: z.string().optional(),
      tag: z.string().optional(),
      q: z.string().optional(),
      address_id: z.number().optional(),
      sort: z.enum(["rating", "delivery_time", "distance"]).optional().describe("Sort order"),
      open_now: z.boolean().optional().describe("Only vendors open right now"),
      min_rating: z.number().min(0).max(5).optional(),
      max_delivery_fee: z.number().optional().describe("Cap the delivery fee (NGN)"),
      free_delivery: z.boolean().optional(),
      page: z.number().int().min(1).optional(),
    },
    annotations: READ,
  },
  async (args) => run(() => api.getVendors(args), { slim: true }),
);

server.registerTool(
  "featured_vendors",
  {
    description: "List featured/handpicked/explore vendors near the current address.",
    inputSchema: { tag: z.enum(["featured", "handpicked", "explore"]) },
    annotations: READ,
  },
  async ({ tag }) => run(() => api.getFeaturedVendors(tag), { slim: true }),
);

server.registerTool(
  "search",
  {
    description: "Search vendors and meals near the current address, with optional filters.",
    inputSchema: {
      q: z.string(),
      sort: z.enum(["rating", "delivery_time", "distance"]).optional(),
      open_now: z.boolean().optional(),
      min_rating: z.number().min(0).max(5).optional(),
    },
    annotations: READ,
  },
  async ({ q, ...filters }) => run(() => api.searchVendors(q, filters), { slim: true }),
);

server.registerTool(
  "get_menu_categories",
  { description: "List menu categories for a vendor.", inputSchema: { vendor_id: z.number() }, annotations: READ },
  async ({ vendor_id }) => run(() => api.getMenuCategories(vendor_id), { slim: true }),
);

server.registerTool(
  "get_menu",
  {
    description: "List a vendor's menu. Optionally filter by category name (e.g. 'Small Chops', 'Rice') to avoid truncation on large menus.",
    inputSchema: {
      vendor_id: z.number(),
      category: z.string().optional().describe("Filter by category name (case-insensitive partial match)"),
    },
    annotations: READ,
  },
  async ({ vendor_id, category }) => run(() => api.getMenu(vendor_id, category), { slim: true }),
);

server.registerTool(
  "get_menu_item",
  {
    description: "Get full details for one menu item (options, add-ons, price).",
    inputSchema: { vendor_id: z.number(), menu_id: z.number() },
    annotations: READ,
  },
  async ({ vendor_id, menu_id }) => run(() => api.getMenuItem(vendor_id, menu_id), { slim: true }),
);

// ── Favourites ──────────────────────────────────────────────────────────────

server.registerTool(
  "list_favorites",
  { description: "List the user's saved/favourite vendors (requires login).", inputSchema: {}, annotations: READ },
  async () => run(() => api.listFavorites(), { slim: true }),
);

server.registerTool(
  "add_favorite",
  { description: "Save a vendor to the user's favourites (requires login).", inputSchema: { vendor_id: z.number() }, annotations: WRITE },
  async ({ vendor_id }) => run(() => api.addFavorite(vendor_id)),
);

server.registerTool(
  "remove_favorite",
  { description: "Remove a vendor from the user's favourites (requires login).", inputSchema: { vendor_id: z.number() }, annotations: WRITE },
  async ({ vendor_id }) => run(() => api.removeFavorite(vendor_id)),
);

// ── Cart ──────────────────────────────────────────────────────────────────────

server.registerTool(
  "reorder",
  {
    description: "Rebuild a cart from a past order so the user can place it again. Pass a past order_id (from get_order_history). Returns the new cart; confirm and checkout as usual.",
    inputSchema: { order_id: z.string() },
    annotations: WRITE,
  },
  async ({ order_id }) => run(() => api.reorder(order_id)),
);

server.registerTool("get_carts", { description: "List all carts for the current session.", inputSchema: {}, annotations: READ }, async () =>
  run(() => api.getCarts(), { slim: true }),
);

server.registerTool(
  "clear_carts",
  { description: "Delete ALL carts for the current session. Requires confirm:true.", inputSchema: { ...CONFIRM }, annotations: DESTRUCTIVE },
  async ({ confirm }) => {
    if (!confirm) return needConfirm("delete every cart in the current session");
    return run(() => api.clearCarts());
  },
);

server.registerTool(
  "delete_cart",
  { description: "Delete one cart by id. Requires confirm:true.", inputSchema: { cart_id: z.number(), ...CONFIRM }, annotations: DESTRUCTIVE },
  async ({ cart_id, confirm }) => {
    if (!confirm) return needConfirm(`delete cart ${cart_id}`);
    return run(() => api.deleteCart(cart_id));
  },
);

server.registerTool(
  "get_vendor_cart",
  { description: "Get the cart for one vendor.", inputSchema: { vendor_id: z.number() }, annotations: READ },
  async ({ vendor_id }) => run(() => api.getCartByVendor(vendor_id), { slim: true }),
);

server.registerTool(
  "update_cart",
  {
    description: "Create or update a cart with items for a vendor. Works as guest after set_address. Use pack_reference to group items into separate packs within one cart.",
    inputSchema: {
      vendor_id: z.number(),
      items: z.array(
        z.object({
          item_id: z.number(),
          quantity: z.number().int().min(1).max(99),
          type: z.string().default("menu"),
          pack_reference: z.string().optional().describe("Group items into packs by matching pack_reference values"),
        }),
      ),
      address_id: z.number().optional(),
    },
    annotations: WRITE,
  },
  async (args) => run(() => api.createOrUpdateCart(args)),
);

// ── Auth ──────────────────────────────────────────────────────────────────────

server.registerTool(
  "login_send_otp",
  {
    description: "Start phone login after approval. Chowdeck may require browser verification: use its official sign-in page to request a code, then the hosted /setup form to connect the shared account. Never extract browser tokens.",
    inputSchema: { phone: z.string(), country_code: z.string().default("NG"), ...CONFIRM },
    annotations: WRITE,
  },
  async ({ phone, country_code, confirm }) =>
    !confirm ? needConfirm("send a Chowdeck login OTP") : run(async () => {
      await api.validatePhone(phone, country_code);
      return api.sendLoginOtp(phone, country_code);
    }),
);

server.registerTool(
  "login_verify_otp",
  {
    description: "Complete login with the OTP the user received. Stores the bearer token in session.",
    inputSchema: { phone: z.string(), otp: z.string(), country_code: z.string().default("NG") },
    annotations: WRITE,
  },
  async ({ phone, otp, country_code }) =>
    run(async () => {
      const result = await api.verifyOtp(phone, otp, country_code);
      if (session.token) session.phone = phone;
      return result;
    }),
);

server.registerTool("get_me", { description: "Get the authenticated user's profile.", inputSchema: {}, annotations: READ }, async () =>
  run(() => api.getMe(), { slim: true }),
);

// ── Account / setup ─────────────────────────────────────────────────────────────

server.registerTool(
  "get_setup_status",
  {
    description:
      "Call this FIRST every conversation. Aggregates auth, address, saved payment, wallet, order count, and payment preference. If not authenticated or no address, run first-time setup. After login it also tells you whether the user is NEW (empty account) or RETURNING (has saved data).",
    inputSchema: {},
    outputSchema: {
      authenticated: z.boolean(),
      phone: z.string().nullable().optional(),
      address_id: z.number().nullable().optional(),
      payment_pref: z.any().optional(),
      setup_complete: z.boolean(),
      user_type: z.enum(["new", "returning"]).optional(),
      address_count: z.number().optional(),
      saved_payment_count: z.number().optional(),
      wallet_balance: z.any().optional(),
      order_count: z.number().optional(),
      next: z.string().optional(),
      warning: z.string().optional(),
    },
    annotations: READ,
  },
  async () => {
    const out: any = {
      authenticated: !!session.token,
      phone: session.phone,
      address_id: session.addressId,
      payment_pref: session.paymentPref,
      setup_complete: !!session.token && !!session.addressId,
    };
    if (!session.token) {
      out.next = "Not logged in. Open your hosted /setup page. If Chowdeck requires verification, request a code on its official sign-in page and enter it in the hosted setup form.";
      return { ...res(out), structuredContent: out };
    }
    try {
      const [addrRes, payRes, walletRes, ordersRes] = await Promise.allSettled([
        api.listAddresses(),
        api.getPaymentMethods(),
        api.getWallet(),
        api.getOrderHistory(),
      ]);
      const addresses = (addrRes.status === "fulfilled" && (addrRes.value as any)?.data) || [];
      const methods = (payRes.status === "fulfilled" && ((payRes.value as any)?.data ?? [])) || [];
      const wallet = walletRes.status === "fulfilled" ? (walletRes.value as any)?.data : null;
      const orders = (ordersRes.status === "fulfilled" && ((ordersRes.value as any)?.data ?? [])) || [];
      out.address_count = addresses.length;
      out.saved_payment_count = Array.isArray(methods) ? methods.length : 0;
      out.wallet_balance = wallet ? { total: wallet.total_balance, ...wallet.balances, currency: wallet.currency } : null;
      out.order_count = Array.isArray(orders) ? orders.length : 0;
      out.user_type = addresses.length > 0 || out.saved_payment_count > 0 || out.order_count > 0 ? "returning" : "new";
      out.next =
        out.user_type === "returning"
          ? "Returning user. Confirm the active address (get_active_address) and, if payment_pref is null, ask once and call set_payment_pref."
          : "New user. Resolve a delivery address (search_places -> set_address_from_place) and confirm it.";
    } catch (err: any) {
      out.warning = "Could not load full account profile: " + (err?.message ?? String(err));
    }
    return { ...res(out), structuredContent: out };
  },
);

server.registerTool("list_addresses", { description: "List the user's saved addresses (requires login).", inputSchema: {}, annotations: READ }, async () =>
  run(() => api.listAddresses(), { slim: true }),
);

server.registerTool(
  "get_active_address",
  {
    description: "Get the account's active/last-used address — the default delivery target. Confirm it with the user before ordering.",
    inputSchema: {},
    annotations: READ,
  },
  async () => run(() => api.getActiveAddress()),
);

server.registerTool(
  "use_address",
  {
    description: "Select a saved address as the active delivery address for this session (sets session.addressId and marks it active on Chowdeck). Use for returning users instead of creating a new address.",
    inputSchema: { address_id: z.number() },
    annotations: WRITE,
  },
  async ({ address_id }) =>
    run(async () => {
      const r = await api.setActiveAddress(address_id).catch(() => null);
      session.addressId = address_id;
      return { ok: true, address_id, set_active: r ?? "skipped" };
    }),
);

server.registerTool("get_wallet", { description: "Get the user's wallet balance (requires login).", inputSchema: {}, annotations: READ }, async () =>
  run(() => api.getWallet()),
);

server.registerTool(
  "get_order_history",
  { description: "List past orders (requires login). Optional status filter, e.g. 'completed'.", inputSchema: { status: z.string().optional() }, annotations: READ },
  async ({ status }) => run(() => api.getOrderHistory(status), { slim: true }),
);

server.registerTool(
  "set_payment_pref",
  {
    description: "Save the user's payment preference. mode 'default' = auto-use the chosen saved method (still confirm total); mode 'ask' = pick a method every order.",
    inputSchema: { mode: z.enum(["default", "ask"]), payment_method: z.enum(["wallet", "card", "online_payment", "pay_for_me"]).optional(), method_id: z.number().int().positive().optional(), method_label: z.string().optional() },
    annotations: WRITE,
  },
  async ({ mode, payment_method, method_id, method_label }) => {
    if (mode === "default" && (!payment_method || (payment_method === "card" && !method_id))) return res({ error: "Choose a payment method; saved cards also require method_id." });
    session.paymentPref = { mode, paymentMethod: payment_method, methodId: method_id, methodLabel: method_label };
    return res({ ok: true, payment_pref: session.paymentPref });
  },
);

// ── Orders / checkout ─────────────────────────────────────────────────────────

server.registerTool("get_active_orders", { description: "List the user's active orders (requires login).", inputSchema: {}, annotations: READ }, async () =>
  run(() => api.getActiveOrders(), { slim: true }),
);

server.registerTool("get_order", { description: "Get one order by id.", inputSchema: { order_id: z.string() }, annotations: READ }, async ({ order_id }) =>
  run(() => api.getOrder(order_id), { slim: true }),
);

server.registerTool("get_payment_methods", { description: "List saved payment methods (requires login).", inputSchema: {}, annotations: READ }, async () =>
  run(() => api.getPaymentMethods()),
);

server.registerTool(
  "get_delivery_fee",
  {
    description: "Quote the delivery fee for a vendor to the current address. Pass cart_id from the cart. Returns a fee object whose id is the fee_id needed for place_order.",
    inputSchema: { vendor_id: z.number(), cart_id: z.number().optional(), source_id: z.number().optional(), address_id: z.number().int().positive().optional(), order_class: z.enum(["delivery", "vendor_delivery", "preorder_delivery"]).optional() },
    annotations: READ,
  },
  async (args) => run(() => api.getDeliveryFee(args)),
);

server.registerTool(
  "place_order",
  {
    description:
      "Place an order from a cart (requires login). DESTRUCTIVE — charges money. Requires confirm:true, which you should set ONLY after confirming items, vendor, delivery fee, and total with the user. Supports wallet, saved card, gifts, split wallet, pickup and vendor preorder windows. Use online_payment plus online_channel for hosted payment. Never retry an ambiguous placement: check active orders first. Live charging of this build is not yet verified.",
    inputSchema: {
      vendor_id: z.number(),
      cart_id: z.number(),
      idempotency_key: z.string().min(8).max(200).describe("Stable key for this exact approved order. Reuse it after a timeout; never invent a new key to bypass an unknown outcome."),
      max_total_naira: z.number().positive().optional(),
      expected_total_naira: z.number().positive().optional().describe("Approved total from the live preview; a changed total stops placement."),
      allow_repeat: z.boolean().optional().describe("Only for an intentionally repeated matching order after fresh explicit user approval."),
      fee_id: z.number().int().positive().optional(),
      payment_method: z.enum(["wallet", "card", "online_payment", "pay_for_me"]),
      payment_method_id: z.number().optional(),
      online_channel: z.string().optional(),
      address_id: z.number().optional(),
      promo_codes: z.array(z.string()).optional(),
      customer_vendor_note: z.string().optional(),
      customer_delivery_note: z.string().optional(),
      split_payment_with_wallet: z.boolean().optional(),
      gift_recipient: z.object({
        donor_name: z.string().trim().min(1), name: z.string().trim().min(1),
        phone: z.string().regex(/^(?:\+?234|0)?[0-9]{10}$/),
        country_code: z.literal("NG").default("NG"),
        email: z.email().optional(), message: z.string().max(1000).optional(),
        save_as_beneficiary: z.boolean().default(false),
      }).optional().describe("Gift recipient details. Confirm recipient, phone, message and delivery address with user. Omit for a regular order."),
      order_class: z.enum(["delivery", "pickup", "vendor_delivery", "preorder_delivery"]).optional(),
      delivery_date: z.string().optional(),
      earliest_delivery_time: z.string().optional(),
      latest_delivery_time: z.string().optional(),
      scheduled_for: z.string().optional().describe("Deprecated: rejected to prevent an unintended ASAP order. Use preorder_delivery with the vendor time window."),
      rider_tip: z.number().min(0).optional().describe("Optional tip for the rider, in NGN"),
      ...CONFIRM,
    },
    annotations: DESTRUCTIVE,
  },
  async (args) => {
    if (!args.confirm) {
      const extra = args.scheduled_for ? ` (scheduled for ${args.scheduled_for})` : "";
      const tip = args.rider_tip ? ` with a ₦${args.rider_tip} tip` : "";
      return needConfirm(`place this order and charge the selected payment method${tip}${extra}`);
    }
    return run(() => api.placeOrder(args));
  },
);

server.registerTool(
  "track_order",
  {
    description: "Compact live status of an order: status, ETA, delivery PIN, rider name/phone, payment status, and tracking link. Poll this to follow a delivery.",
    inputSchema: { order_id: z.string() },
    annotations: READ,
  },
  async ({ order_id }) => run(() => api.trackOrder(order_id)),
);

server.registerTool(
  "cancel_order",
  {
    description: "Cancel a placed, not-yet-fulfilled order. DESTRUCTIVE — requires confirm:true after the user agrees; any refund goes to the Chowdeck wallet.",
    inputSchema: { order_id: z.string().describe("Order ID to cancel"), reason: z.string().describe("Reason for cancellation"), ...CONFIRM },
    annotations: DESTRUCTIVE,
  },
  async ({ order_id, reason, confirm }) => {
    if (!confirm) return needConfirm(`cancel order ${order_id} (reason: ${reason})`);
    return run(() => api.cancelOrder(order_id, reason));
  },
);

server.registerTool(
  "tip_rider",
  {
    description: "Tip the rider for an order. DESTRUCTIVE — moves money; requires confirm:true after the user approves. Amount is in KOBO (50000 = ₦500), paid from the Chowdeck wallet by default. (Note: place_order's rider_tip is in naira; this endpoint uses kobo.)",
    inputSchema: {
      order_id: z.string().describe("Order ID to tip for"),
      amount: z.number().int().min(100).describe("Tip amount in KOBO (e.g. 50000 = ₦500)"),
      payment_method: z.string().default("wallet").describe("wallet, card, etc."),
      ...CONFIRM,
    },
    annotations: DESTRUCTIVE,
  },
  async ({ order_id, amount, payment_method, confirm }) => {
    if (!confirm) return needConfirm(`tip the rider ₦${(amount / 100).toFixed(2)} (${amount} kobo) for order ${order_id}`);
    return run(() => api.tipRider(order_id, amount, payment_method));
  },
);

server.registerTool(
  "get_notifications",
  {
    description: "Fetch the user's notifications (order updates, promos). Requires login.",
    inputSchema: {},
    annotations: READ,
  },
  async () => run(() => api.getNotifications(), { slim: true }),
);

server.registerTool(
  "validate_promo",
  {
    description: "Submit a promo/voucher code to Chowdeck's current promo-code endpoint. May apply a benefit; requires confirmation. Security-answer vouchers need the website. Live semantics are not yet verified.",
    inputSchema: { code: z.string().min(1), ...CONFIRM }, annotations: WRITE,
  },
  async ({ code, confirm }) => confirm ? run(() => api.validatePromo(code)) : needConfirm("submit this promo/voucher code"),
);

server.registerTool(
  "wallet_topup",
  {
    description: "Initialise a wallet top-up — returns a Paystack link the user completes to add money. DESTRUCTIVE (moves money); requires confirm:true after the user approves the amount. Uses the storefront funding endpoint; amount input is NGN, converted to kobo. Live funding remains unverified.",
    inputSchema: { amount: z.number().positive().describe("Amount to add, in NGN"), channel: z.string().default("card"), ...CONFIRM },
    annotations: DESTRUCTIVE,
  },
  async ({ amount, channel, confirm }) => {
    if (!confirm) return needConfirm(`start a ₦${amount} wallet top-up via ${channel}`);
    return run(() => api.walletTopup(amount, channel));
  },
);

server.registerTool(
  "get_payment_channels",
  {
    description: "List available payment channels (card, bank_transfer, ussd, opay...). Each name is a valid `method` for start_order_payment.",
    inputSchema: {},
    annotations: READ,
  },
  async () => run(() => api.getPaymentChannels()),
);

server.registerTool(
  "start_order_payment",
  {
    description: "Start payment for an existing unpaid order after the user approves the method and amount. Returns a hosted checkout link; the user completes bank/card authorization. Check payment status before retrying.",
    inputSchema: { order_id: z.number().int().positive(), method: z.string().min(1), split_payment_with_wallet: z.boolean().optional(), ...CONFIRM },
    annotations: DESTRUCTIVE,
  },
  async ({ confirm, ...args }) => {
    if (!confirm) return needConfirm("initialize payment for this existing order");
    return run(() => api.startPayment(args));
  },
);

server.registerTool(
  "verify_payment",
  { description: "Verify a payment transaction status.", inputSchema: { transaction_id: z.string() }, annotations: READ },
  async ({ transaction_id }) => run(() => api.verifyPayment(transaction_id)),
);


server.registerTool("prepare_checkout", {
  description: "Fast checkout review: fetch the current cart, vendor, wallet, saved payment methods, gift beneficiaries and delivery quote together. Does not place or pay for an order. Show the live final total, address, recipient and payment method to user before place_order.",
  inputSchema: { vendor_id: z.number().int().positive(), address_id: z.number().int().positive().optional(), max_total_naira: z.number().positive().optional(), rider_tip: z.number().min(0).optional(), promo_codes: z.array(z.string()).optional(), payment_method: z.string().optional() }, annotations: READ,
}, async ({ vendor_id, address_id, ...opts }) => run(() => api.prepareCheckout(vendor_id, address_id, opts), { slim: true }));
server.registerTool("list_beneficiaries", { description: "List saved gift recipients for repeat gift orders. Verify the intended recipient before use.", inputSchema: {}, annotations: READ }, async () => run(api.listBeneficiaries, { slim: true }));
server.registerTool("get_order_timeline", { description: "Get timestamped order progress.", inputSchema: { order_id: z.string() }, annotations: READ }, async ({ order_id }) => run(() => api.getOrderTimeline(order_id), { slim: true }));
server.registerTool("get_live_tracking", { description: "Get live delivery tracking from Chowdeck.", inputSchema: { order_id: z.string() }, annotations: READ }, async ({ order_id }) => run(() => api.getLiveTracking(order_id), { slim: true }));
server.registerTool("get_order_payment_status", { description: "Read payment state for an existing order before any payment retry.", inputSchema: { order_id: z.string() }, annotations: READ }, async ({ order_id }) => run(() => api.getOrderPaymentStatus(order_id)));
server.registerTool("update_delivery_note", { description: "Change the rider note on an existing order, after the user approves its contents.", inputSchema: { order_id: z.string(), note: z.string().max(1000), ...CONFIRM }, annotations: WRITE }, async ({ order_id, note, confirm }) => confirm ? run(() => api.updateDeliveryNote(order_id, note)) : needConfirm("change the delivery note"));
server.registerTool("duplicate_pack", { description: "Duplicate a meal pack in the cart. Does not place an order.", inputSchema: { cart_id: z.number().int().positive(), pack_reference: z.string().min(1), ...CONFIRM }, annotations: WRITE }, async ({ cart_id, pack_reference, confirm }) => confirm ? run(() => api.duplicatePack(cart_id, pack_reference)) : needConfirm("duplicate this meal pack"));
server.registerTool("delete_pack", { description: "Remove one meal pack from the cart.", inputSchema: { cart_id: z.number().int().positive(), pack_reference: z.string().min(1), ...CONFIRM }, annotations: DESTRUCTIVE }, async ({ cart_id, pack_reference, confirm }) => confirm ? run(() => api.deletePack(cart_id, pack_reference)) : needConfirm("remove this meal pack"));


server.registerTool("get_food_images", {
  description: "Fetch real Chowdeck menu photos for a food item or food-name query. Returns labelled source links and, by default, native MCP image content that image-capable clients can show directly to the user. Use these actual photos, never generated substitutes. No purchase or external message is sent.",
  inputSchema: { vendor_id: z.number().int().positive(), menu_id: z.number().int().positive().optional(), query: z.string().min(1).optional(), limit: z.number().int().min(1).max(3).default(2), embed: z.boolean().default(true) }, annotations: READ,
}, async ({ vendor_id, menu_id, query, limit, embed }) => {
  try {
    const photos = await media.foodPhotos(vendor_id, menu_id, query, limit);
    const content: any[] = [];
    const errors: string[] = [];
    for (const item of photos.items) {
      const url = item.image_urls[0];
      content.push({ type: "resource_link", uri: url, name: item.name, description: `Chowdeck photo of ${item.name}, menu id ${item.menu_id}` });
      if (embed) try { content.push(await media.downloadFoodImage(url)); } catch (error: any) { errors.push(`${item.name}: ${error.message}`); }
    }
    content.unshift({ type: "text", text: JSON.stringify({ ...photos, embed_errors: errors }, null, 2) });
    return { content };
  } catch (error: any) { return { ...res({ error: error.message }), isError: true }; }
});

server.registerTool("get_api_map", { description: "Read the evidence-backed map of current Chowdeck storefront endpoints, fields, MCP coverage and validation limits.", inputSchema: { category: z.string().optional() }, annotations: READ }, async ({ category }) => res({ ...API_MAP, operations: category ? API_MAP.operations.filter(o => o.category.toLowerCase().includes(category.toLowerCase())) : API_MAP.operations }));
server.registerTool("session_status", { description: "Validate the shared login and silently renew expired/near-expiry tokens when Chowdeck permits. Returns health/expiry or reauth_required, never tokens, and never sends an OTP.", inputSchema: {}, annotations: READ }, async () => run(workflows.sessionStatus));
server.registerTool("list_recipient_profiles", { description: "List explicitly saved gift recipient profiles and the chosen default.", inputSchema: {}, annotations: READ }, async () => res({ recipients: workflows.recipients() }));
server.registerTool("save_recipient_profile", { description: "Save user-approved gift recipient details, saved address id and rider note. Only is_default:true explicitly selects the default; no recipient is guessed.", inputSchema: { name: z.string().trim().min(1), phone: z.string(), donor_name: z.string().trim().min(1), address_id: z.number().int().positive(), rider_note: z.string().optional(), is_default: z.boolean().optional(), ...CONFIRM }, annotations: WRITE }, async ({ confirm, ...profile }) => confirm ? run(() => workflows.saveRecipient(profile)) : needConfirm("save this recipient profile"));
server.registerTool("save_favourite_recipe", { description: "Save a friendly name for a previous order and optional last price. This does not place or rebuild a cart.", inputSchema: { name: z.string().trim().min(1), order_id: z.string(), expected_total_naira: z.number().positive().optional() }, annotations: WRITE }, async ({ name, order_id, expected_total_naira }) => run(() => workflows.saveRecipe(name, order_id, expected_total_naira)));
server.registerTool("reorder_gift", { description: "One-call repeat gift preparation: preserve original options/packs via the native repeat endpoint, apply an explicitly saved recipient/address/note, select wallet and enforce a maximum total. Returns a live preview and place_order args; NEVER purchases automatically. Reuse request_id to avoid rebuilding twice.", inputSchema: { order_id: z.string().optional(), favourite_name: z.string().optional(), recipient: z.string().optional(), max_total_naira: z.number().positive(), request_id: z.string().min(8).max(200) }, annotations: WRITE }, async args => run(() => workflows.reorderGift(args)));
server.registerTool("find_item", { description: "Search nested menu items and required options by exact ids/names. Returns multiple candidates for ambiguous names; never changes a cart or guesses a variant.", inputSchema: { vendor_id: z.number().int().positive(), query: z.string().trim().min(1) }, annotations: READ }, async ({ vendor_id, query }) => run(() => workflows.findItem(vendor_id, query)));
server.registerTool("find_vendor_alternatives", { description: "Check up to eight nearby vendors, verify they are open, and inspect menus for the requested item. Returns candidates without substituting or ordering.", inputSchema: { query: z.string().min(1), vendor_type: z.string().optional() }, annotations: READ }, async ({ query, vendor_type }) => run(() => workflows.alternatives(query, vendor_type)));
server.registerTool("order_log", { description: "Recent orders placed through this MCP with timing, payment, recipient and returned order/PIN evidence. Does not fabricate historical entries.", inputSchema: { last: z.number().int().min(1).max(100).default(5) }, annotations: READ }, async ({ last }) => res({ orders: workflows.orderLog(last) }));
server.registerTool("check_order_refund", { description: "One-time order/timeline/wallet snapshot for a cancellation/refund. A wallet balance change alone is labelled unverified. Does not start recurring monitoring.", inputSchema: { order_id: z.string() }, annotations: READ }, async ({ order_id }) => run(() => workflows.checkRefund(order_id)));
server.registerTool("wallet_shortfall", { description: "Quote the current cart and exact wallet shortfall; if needed fetch fresh virtual-account details. Does not transfer, top up, rebuild or message another bot.", inputSchema: { vendor_id: z.number().int().positive(), address_id: z.number().int().positive().optional() }, annotations: READ }, async ({ vendor_id, address_id }) => run(() => workflows.shortfall(vendor_id, address_id)));

// ── Prompts ───────────────────────────────────────────────────────────────────
// Reusable, user-pickable flows. Each returns a user message that points the
// agent at the right tools while preserving the SKILL's safety rules
// (confirm address + total before ordering; never auto-charge).

function userPrompt(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

server.registerPrompt(
  "order_food",
  {
    title: "Order food on Chowdeck",
    description: "Run the full Chowdeck ordering flow: setup, find a vendor, build a cart, confirm, and check out.",
    argsSchema: { craving: z.string().optional().describe("What the user feels like eating, if known") },
  },
  ({ craving }) =>
    userPrompt(
      `Help me order food on Chowdeck${craving ? ` — I'm in the mood for ${craving}` : ""}.\n\n` +
        "Start by calling get_setup_status. If I'm not set up, run first-time setup (login + confirm delivery address). " +
        "Then find vendors/meals (search / list_vendors / featured_vendors), build a cart with update_cart, quote the fee with get_delivery_fee, " +
        "then show me the full summary — items, vendor, delivery fee, and total. Only after I approve should you call place_order with confirm:true. " +
        "After placing, give me the delivery PIN, rider info, and tracking link.",
    ),
);

server.registerPrompt(
  "find_food_near_me",
  {
    title: "Find food near me",
    description: "Discover vendors and meals near the saved delivery address, with optional filters.",
    argsSchema: { craving: z.string().optional(), open_now: z.string().optional().describe("'true' to only show vendors open now") },
  },
  ({ craving, open_now }) =>
    userPrompt(
      `What can I order on Chowdeck near me right now${craving ? ` for ${craving}` : ""}? ` +
        "Confirm my delivery address first (get_setup_status / get_active_address), then use search and list_vendors" +
        (open_now === "true" ? " with open_now:true" : "") +
        ". Show me a short, ranked list with rating, delivery time, and fee — don't dump full menus.",
    ),
);

server.registerPrompt(
  "track_my_order",
  {
    title: "Track my Chowdeck order",
    description: "Show the live status of the user's current (or a specific) order.",
    argsSchema: { order_id: z.string().optional().describe("A specific order id, if known") },
  },
  ({ order_id }) =>
    userPrompt(
      order_id
        ? `Track my Chowdeck order ${order_id} — call track_order and summarise status, ETA, rider, delivery PIN, and the tracking link.`
        : "Track my current Chowdeck order. Call get_active_orders, then track_order on the latest, and summarise status, ETA, rider, delivery PIN, and tracking link.",
    ),
);

server.registerPrompt(
  "reorder_my_usual",
  {
    title: "Reorder a past order",
    description: "Pick a recent order and place it again.",
    argsSchema: {},
  },
  () =>
    userPrompt(
      "I want to reorder something I've had before. Call get_order_history, show me my recent orders, and once I pick one, " +
        "use reorder to rebuild the cart, re-quote the delivery fee, confirm the total with me, then place_order with confirm:true.",
    ),
);


const FAST_READ={readOnlyHint:true,openWorldHint:true};
server.registerTool('search_items_everywhere',{description:'Search all synonyms locally per menu with invocation request budgets and resumable coverage. Follow next_cursor with the same queries/filters until null; merge/deduplicate by vendor_id,item_id,matched_query. max_vendors is per call (up to 200). shop is an alias for supermarket. Valid types and skip reasons are returned. No cart or order changes.',inputSchema:{queries:z.array(z.string().min(1).max(120)).min(1).max(20),vendor_type:z.string().optional(),open_now:z.boolean().default(true),in_stock_only:z.boolean().default(false),max_distance_km:z.number().positive().optional(),max_vendors:z.number().int().min(1).max(200).default(60),cursor:z.string().max(100).optional(),vendor_ids:z.array(z.number().int().positive()).min(1).max(20).optional().describe('Optional scope of known vendors for focused comparisons or repeat searches; omission searches all nearby vendors')},annotations:FAST_READ},async(args)=>res(await fast.searchEverywhere(args)));
server.registerTool('get_menu_slim',{description:'Fetch many complete slim menus in parallel. Includes real image URLs and only required option groups. Prices/stock may be cached; purchasing always revalidates live data.',inputSchema:{vendor_ids:z.array(z.number().int().positive()).min(1).max(60),category:z.string().optional(),in_stock_only:z.boolean().default(true),include_images:z.boolean().default(true)},annotations:FAST_READ},async(args)=>res(await fast.menuSlim(args)));
server.registerTool('get_food_images_batch',{description:'Return real public photo URLs for many menu IDs. Decodes supported Chowdeck image transformations to direct image links. No image embedding.',inputSchema:{items:z.array(z.object({vendor_id:z.number().int().positive(),menu_id:z.number().int().positive()})).min(1).max(120),limit_per_item:z.number().int().min(1).max(5).default(1)},annotations:FAST_READ},async({items,limit_per_item})=>res(await fast.imagesBatch(items,limit_per_item)));
const QUICK_ITEMS=z.array(z.object({menu_id:z.number().int().positive(),qty:z.number().int().min(1).max(99),pack_reference:z.string().max(100).optional(),options:z.array(z.union([z.number().int().positive(),z.object({menu_id:z.number().int().positive(),qty:z.number().int().min(1).max(99).optional(),group_id:z.number().int().positive().optional()})])).max(30).optional()})).min(1).max(50);
server.registerTool('quick_order',{description:'One-call checkout; confirm:false is strictly read-only and returns a live draft quote. confirm:true needs the exact approved expected_total_naira, recipient/address and stable key; only the selected vendor cart is replaced. Blocks closed vendors, unavailable items, price changes and over-budget totals. Unknown outcomes are reconciled, never blindly retried.',inputSchema:{vendor_id:z.number().int().positive(),items:QUICK_ITEMS,address_label:z.string().optional(),gift_recipient:z.object({donor_name:z.string(),name:z.string(),phone:z.string(),country_code:z.literal('NG').default('NG'),email:z.string().optional(),message:z.string().optional(),save_as_beneficiary:z.boolean().optional()}).nullable().optional(),rider_note:z.string().optional(),payment_method:z.enum(['wallet','card','online_payment','pay_for_me']).default('wallet'),payment_method_id:z.number().int().positive().optional(),max_total_naira:z.number().positive(),idempotency_key:z.string().trim().min(1).max(120),expected_total_naira:z.number().nonnegative().optional(),confirm:z.boolean().default(false)},annotations:DESTRUCTIVE},async(args)=>res(await quick.quickOrder(args)));
server.registerTool('reorder_fast',{description:'Prepare a past order or saved recipe in one call, preserving exact items, packs and options. Same dry-run, budget, approval and duplicate safeguards as quick_order. Uses the current saved rider note for the configured default recipient; accepts an explicit rider_note override. Never purchases with confirm:false.',inputSchema:{past_order_id:z.string().optional(),favourite_name:z.string().optional(),max_total_naira:z.number().positive(),idempotency_key:z.string().trim().min(1).max(120),confirm:z.boolean().default(false),expected_total_naira:z.number().nonnegative().optional(),address_label:z.string().optional(),rider_note:z.string().optional()},annotations:DESTRUCTIVE},async(args)=>res(await quick.reorderFast(args)));
return server;
}
