import * as api from './api.js';
import * as fast from './fast.js';
import { session, persistNow } from './session.js';
import { createHash } from 'node:crypto';
let defaults: any = {};
export function configureQuickDefaults(value: any = {}) { defaults = value; }
export type QuickItem = {
    menu_id: number;
    qty: number;
    options?: Array<number | {
        menu_id: number;
        qty?: number;
        group_id?: number;
    }>;
    pack_reference?: string;
};
export type QuickArgs = {
    vendor_id: number;
    items: QuickItem[];
    address_label?: string;
    gift_recipient?: api.GiftRecipient | null;
    rider_note?: string;
    payment_method?: 'wallet' | 'card' | 'online_payment' | 'pay_for_me';
    payment_method_id?: number;
    max_total_naira: number;
    idempotency_key: string;
    confirm?: boolean;
    expected_total_naira?: number;
};
function canonical(v: any): string { if (v === undefined)
    return 'null'; if (!v || typeof v !== 'object')
    return JSON.stringify(v); if (Array.isArray(v))
    return '[' + v.map(canonical).join(',') + ']'; return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'; }
function attempts() { return session.data?.quickAttempts ?? {}; }
async function save(key: string, value: any) { session.data = { ...session.data, quickAttempts: { ...attempts(), [key]: value } }; await persistNow(); }
async function reconcile(key: string) { let active: any = null; try {
    active = await api.getActiveOrders();
}
catch { } return { status: 'unknown', placed: null, idempotency_key: key, active_orders: active, order_log: (session.data?.orderLog ?? []).slice(-10), retry_allowed: false, message: 'An earlier attempt may have succeeded. Reconcile these records; never rebuild or place again blindly.' }; }
async function address(label?: string, gift?: any, sourceAddressId?: number) { if (sourceAddressId && !label) {
    const rows = (await api.listAddresses()).data ?? [];
    const hit = rows.find((a: any) => a.id === sourceAddressId);
    if (!hit)
        throw Error('The original saved address is no longer available. Choose an address_label.');
    return hit;
} if (label) {
    const rows = (await api.listAddresses()).data ?? [];
    const hits = rows.filter((a: any) => [a.tag, a.label, a.name, a.pretty_name].some(s => typeof s === 'string' && s.trim().toLowerCase() === label.trim().toLowerCase()));
    if (hits.length !== 1)
        throw Error('Address label missing or ambiguous. Choose one exact saved address.');
    return hits[0];
} const profile = Object.values(session.data?.recipients ?? {}).find((p: any) => gift && p.name?.toLowerCase() === gift.name?.toLowerCase()) as any; if (profile?.address_id) {
    const rows = (await api.listAddresses()).data ?? [];
    const hit = rows.find((a: any) => a.id === profile.address_id);
    if (!hit)
        throw Error('The saved recipient address no longer exists.');
    return hit;
} return api.getActiveAddress(); }
export async function quickOrder(args: QuickArgs, context: {
    sourceAddressId?: number;
    details?: any[];
} = {}) {
    if (!session.token)
        return { status: 'reauth_required', placed: false };
    const selected = args.gift_recipient === undefined ? defaults.gift_recipient : args.gift_recipient;
    if (selected && (typeof selected.phone !== 'string' || !selected.name || !selected.donor_name))
        throw Error('A complete gift recipient name, phone and donor name is required.');
    const gift = selected ? { ...selected, phone: api.normalizePhone(selected.phone), country_code: 'NG' } : null;
    const request = { ...args, confirm: undefined, expected_total_naira: undefined, gift_recipient: gift, rider_note: args.rider_note ?? defaults.rider_note, payment_method: args.payment_method ?? 'wallet' };
    const sourceAddressId = context.sourceAddressId;
    const signature = createHash('sha256').update(canonical({ ...request, sourceAddressId })).digest('hex'), previous = attempts()[args.idempotency_key];
    if (previous) {
        if (previous.signature !== signature)
            throw Error('Idempotency key belongs to different quick-order inputs.');
        if (previous.status === 'completed')
            return { ...previous.result, idempotent_replay: true };
        if (previous.status !== 'rejected')
            return reconcile(args.idempotency_key);
    }
    const underlying = session.data?.orderAttempts?.[args.idempotency_key];
    if (underlying && underlying.status !== 'rejected')
        return reconcile(args.idempotency_key);
    const destination = await address(args.address_label, gift, sourceAddressId);
    if (!destination?.id)
        throw Error('No confirmed saved delivery address is available.');
    const [vendorResponse, wallet, config, detailRows] = await Promise.all([api.getVendor(args.vendor_id, destination.id), api.getWallet(), api.getConfig(), context.details ?? fast.parallel(args.items, async (i) => (await api.getMenuItem(args.vendor_id, i.menu_id, { timeout_ms: 2500 })).data)]);
    const vendor = vendorResponse?.data ?? {}, issues: any[] = [], cartItems: any[] = [], cartPayload: any[] = [];
    if (vendor.is_open !== true || vendor.is_temporarily_unavailable === true)
        issues.push({ code: 'vendor_closed' });
    if (request.payment_method === 'card' && !args.payment_method_id)
        issues.push({ code: 'saved_card_required' });
    for (let n = 0; n < args.items.length; n++) {
        const input = args.items[n], detail = detailRows[n];
        if (!detail || Number(detail.id) !== input.menu_id) {
            issues.push({ code: 'item_missing', menu_id: input.menu_id });
            continue;
        }
        if (detail.in_stock !== true || detail.is_active === false)
            issues.push({ code: 'out_of_stock', menu_id: input.menu_id, name: detail.name });
        const g = fast.groups(detail), modifiers: any[] = [];
        const reference = input.pack_reference ?? `quick-${n + 1}`;
        cartItems.push({ item_id: input.menu_id, name: detail.name, quantity: input.qty, price_per_quantity: detail.price, in_stock: detail.in_stock, type: 'menu', pack_reference: reference });
        for (const choice of input.options ?? []) {
            const id = typeof choice === 'number' ? choice : choice.menu_id, qty = typeof choice === 'number' ? 1 : choice.qty ?? 1;
            const groups = g.filter((x: any) => (typeof choice === 'number' || choice.group_id === undefined || choice.group_id === x.id) && x.items.some((o: any) => o.id === id));
            if (groups.length !== 1) {
                issues.push({ code: 'option_missing_or_ambiguous', menu_id: input.menu_id, option_id: id });
                continue;
            }
            const group = groups[0], option = group.items.find((o: any) => o.id === id);
            if (!option.in_stock)
                issues.push({ code: 'option_out_of_stock', option_id: id });
            modifiers.push({ id, quantity: qty, menu_group_id: group.id });
            cartItems.push({ item_id: id, name: option.name, quantity: qty * input.qty, price_per_quantity: Math.round(option.price_naira * 100), in_stock: option.in_stock, type: 'group', menu_group_id: group.id, pack_reference: reference });
        }
        for (const group of g) {
            const count = modifiers.filter(m => m.menu_group_id === group.id).reduce((sum, m) => sum + m.quantity, 0);
            if (count < group.min || count > group.max)
                issues.push({ code: 'required_options_invalid', menu_id: input.menu_id, group_id: group.id, min: group.min, max: group.max });
        }
        if (detail.menu_group_ids && !g.length)
            issues.push({ code: 'option_groups_unavailable', menu_id: input.menu_id });
        const container = detail.container;
        if (container?.id)
            cartItems.push({ item_id: container.id, name: container.name, quantity: input.qty, price_per_quantity: container.price, in_stock: true, type: 'container', pack_reference: reference });
        cartPayload.push({ item_id: input.menu_id, quantity: input.qty, type: 'menu', pack_reference: reference, ...(modifiers.length ? { modifiers } : {}) });
    }
    const cart = { id: 0, vendor_id: args.vendor_id, class: 'delivery', cart_items: cartItems, bag_quantity: 0 };
    let quote: any;
    try {
        quote = await api.previewDraftCheckout(args.vendor_id, destination.id, cart, vendor, wallet?.data ?? {}, config?.data ?? {}, { max_total_naira: args.max_total_naira, payment_method: request.payment_method });
    }
    catch (error: any) {
        quote = { summary: { ready: false, total_naira: null, issues: [{ code: 'quote_unavailable', upstream_status: error?.response?.status ?? null, message: error?.response?.data?.message ?? error?.message ?? 'Quote failed' }] } };
    }
    const summary = quote.summary, allIssues = [...issues, ...summary.issues];
    const preview = { dry_run: args.confirm !== true, placed: false, total_naira: summary.total_naira, summary: { ...summary, issues: allIssues, ready: summary.ready && issues.length === 0 }, address: { id: destination.id, label: destination.tag ?? destination.label, address: destination.pretty_name }, gift_recipient: gift ?? null, rider_note: request.rider_note ?? '', payment_method: request.payment_method, items: args.items, idempotency_key: args.idempotency_key };
    if (allIssues.length || !summary.ready)
        return { ...preview, status: 'blocked', reason: allIssues[0]?.code ?? 'quote_incomplete' };
    if (args.confirm !== true || args.expected_total_naira === undefined)
        return { ...preview, status: 'preview', needs_confirmation: true, message: 'Approve this exact total, recipient and address; call with confirm:true and expected_total_naira to purchase. No cart was changed.' };
    if (Math.round(args.expected_total_naira * 100) !== Math.round(summary.total_naira * 100))
        return { ...preview, status: 'blocked', reason: 'approved_total_changed' };
    await save(args.idempotency_key, { signature, status: 'preparing', at: Date.now() });
    try {
        const old = await api.getCartByVendor(args.vendor_id);
        if (old?.data?.id)
            await api.deleteCart(old.data.id);
        await api.createOrUpdateCart({ vendor_id: args.vendor_id, address_id: destination.id, items: cartPayload });
        const live = await api.prepareCheckout(args.vendor_id, destination.id, { max_total_naira: args.max_total_naira, payment_method: request.payment_method });
        if (!live.summary.ready || live.summary.total_naira !== args.expected_total_naira) {
            await save(args.idempotency_key, { signature, status: 'rejected' });
            return { ...preview, status: 'blocked', reason: 'live_checkout_changed', total_naira: live.summary.total_naira, issues: live.summary.issues };
        }
        await save(args.idempotency_key, { signature, status: 'placing', at: Date.now() });
        const result = await api.placeOrder({ vendor_id: args.vendor_id, cart_id: live.cart.data.id, address_id: destination.id, fee_id: live.delivery_fee?.data?.id, payment_method: request.payment_method, payment_method_id: args.payment_method_id, gift_recipient: gift ?? undefined, customer_delivery_note: request.rider_note, expected_total_naira: args.expected_total_naira, max_total_naira: args.max_total_naira, idempotency_key: args.idempotency_key });
        if (result.status === 'unknown' || result.duplicate_order_blocked || !result?.data?.id) {
            await save(args.idempotency_key, { signature, status: 'unknown' });
            return { ...result, placed: result.status === 'unknown' ? null : false, ...(result.status === 'unknown' ? await reconcile(args.idempotency_key) : {}) };
        }
        let balance: any = null, detail: any = {};
        await Promise.all([(async () => { try {
                balance = (await api.getWallet()).data;
            }
            catch { } })(), (async () => { if (!result.data.delivery_pin && !result.data.order_pin && !result.data.pin)
                try {
                    detail = (await api.getOrder(String(result.data.id))).data ?? {};
                }
                catch { } })()]);
        const done = { status: 'completed', placed: true, order_number: result.data.order_number ?? result.data.reference ?? result.data.id, pin: result.data.delivery_pin ?? result.data.order_pin ?? result.data.pin ?? detail.delivery_pin ?? detail.order_pin ?? null, total_naira: args.expected_total_naira, payment_status: result.data.payment_status ?? detail.payment_status ?? 'unverified', wallet_balance_after: typeof (balance?.total_balance ?? balance?.total) === 'number' ? (balance.total_balance ?? balance.total) / 100 : null };
        await save(args.idempotency_key, { signature, status: 'completed', result: done });
        return done;
    }
    catch (error: any) {
        const attempt = session.data?.orderAttempts?.[args.idempotency_key];
        await save(args.idempotency_key, { signature, status: attempt?.status === 'rejected' ? 'rejected' : 'unknown' });
        if (attempt?.status === 'rejected')
            throw error;
        return reconcile(args.idempotency_key);
    }
}
export async function reorderFast(args: {
    past_order_id?: string;
    favourite_name?: string;
    max_total_naira: number;
    idempotency_key: string;
    confirm?: boolean;
    expected_total_naira?: number;
    address_label?: string;
}) {
    const recipe = args.favourite_name ? session.data?.recipes?.[args.favourite_name.trim().toLowerCase()] : null, id = args.past_order_id ?? recipe?.order_id;
    if (!id)
        throw Error('Choose a past_order_id or existing favourite_name.');
    const old = (await api.getOrder(String(id))).data;
    if (!old)
        throw Error('Past order not found.');
    let originalGift = old.gift_recipient ?? null;
    if (typeof originalGift === 'string') {
        try {
            originalGift = JSON.parse(originalGift);
        }
        catch {
            throw Error('The original gift recipient cannot be read safely.');
        }
    }
    const rows = old.order_items ?? old.items ?? old.cart_items ?? [];
    const mains = rows.filter((i: any) => (i.type ?? 'menu') === 'menu');
    const catalog = await fast.parallel(mains, async (i: any) => (await api.getMenuItem(Number(old.vendor_id ?? old.vendor?.id), Number(i.item_id ?? i.menu_id ?? i.menu?.id), { timeout_ms: 2500 })).data);
    const items = mains.map((i: any, index: number) => {
        const allowed = new Set(fast.groups(catalog[index]).map((g: any) => g.id));
        const ref = i.pack_reference ?? i.pack_unique_id ?? i.pack_id;
        return { menu_id: Number(i.item_id ?? i.menu_id ?? i.menu?.id), qty: Number(i.quantity ?? 1), pack_reference: String(ref ?? i.id), options: [...(i.modifiers ?? []).map((o: any) => ({ menu_id: Number(o.id ?? o.item_id), qty: o.quantity ?? 1, group_id: o.menu_group_id })), ...rows.filter((o: any) => o.type === 'group' && (o.pack_reference ?? o.pack_unique_id ?? o.pack_id) === ref && allowed.has(Number(o.menu_group_id ?? o.group_id))).map((o: any) => ({ menu_id: Number(o.item_id), qty: Number(o.quantity) / (Number(i.quantity) || 1), group_id: Number(o.menu_group_id ?? o.group_id) }))] };
    });
    for (const option of rows.filter((o: any) => o.type === 'group')) {
        const matches = items.filter((i: any) => i.pack_reference === String(option.pack_reference ?? option.pack_unique_id ?? option.pack_id) && i.options.some((o: any) => o.menu_id === Number(option.item_id)));
        if (matches.length !== 1)
            throw Error('Original options cannot be assigned to exactly one item; review the native reorder cart instead.');
    }
    if (!items.length || items.some((i: any) => !Number.isInteger(i.menu_id) || !Number.isInteger(i.qty) || i.qty < 1 || i.options.some((o: any) => !Number.isInteger(o.qty) || o.qty < 1)))
        throw Error('Original items/options cannot be reconstructed exactly; use the existing native reorder tool and review its cart instead.');
    return quickOrder({ ...args, vendor_id: Number(old.vendor_id ?? old.vendor?.id), items, gift_recipient: originalGift, rider_note: old.customer_delivery_note ?? undefined, payment_method: 'wallet' }, { sourceAddressId: args.address_label ? undefined : Number(old.customer_address_id ?? old.address?.id) || undefined, details: catalog });
}
