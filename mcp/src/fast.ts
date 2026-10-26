import * as api from './api.js';
import { session } from './session.js';
import { imageUrl } from './media.js';
import { createHash } from 'node:crypto';
type KV = {
    get(k: string, t: 'json'): Promise<any>;
    put(k: string, v: string, o: {
        expirationTtl: number;
    }): Promise<void>;
    delete(k: string): Promise<void>;
};
const memory = new Map<string, any>(), pending = new Map<string, Promise<any>>();
let kv: KV | undefined, background: ((p: Promise<any>) => void) | undefined;
export function configureFastCache(store?: KV, waitUntil?: (p: Promise<any>) => void) { kv = store; background = waitUntil; }
export function resetFastCache() { memory.clear(); pending.clear(); }
async function read(key: string) { let e = memory.get(key); if (e && e.expires > Date.now())
    return e; if (kv)
    try {
        e = await kv.get(key, 'json');
        if (e && e.expires > Date.now()) {
            memory.set(key, e);
            return e;
        }
    }
    catch { } return null; }
async function write(key: string, value: any, ttl: number, extra: any = {}) { const e = { value, expires: Date.now() + ttl * 1000, ...extra }; memory.set(key, e); if (memory.size > 240)
    memory.delete(memory.keys().next().value!); if (kv)
    await kv.put(key, JSON.stringify(e), { expirationTtl: ttl }).catch(() => { }); return e; }
async function single(key: string, fn: () => Promise<any>) { if (pending.has(key))
    return pending.get(key)!; const p = fn().finally(() => pending.delete(key)); pending.set(key, p); return p; }
let active = 0;
const waiters: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>) { if (active >= 12)
    await new Promise<void>(r => waiters.push(r)); active++; try {
    return await fn();
}
finally {
    active--;
    waiters.shift()?.();
} }
export async function parallel<T, R>(values: T[], fn: (v: T) => Promise<R>, concurrency = 12): Promise<R[]> { let next = 0; const out: R[] = new Array(values.length); await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => { for (;;) {
    const i = next++;
    if (i >= values.length)
        return;
    out[i] = await fn(values[i]);
} })); return out; }
export function normalize(value: string) { return value.normalize('NFKD').toLowerCase().replace(/3\s*[-–]?\s*in\s*[-–]?\s*1/g, '3in1').replace(/[^a-z0-9]+/g, ' ').trim(); }
function matches(text: string, query: string) { const a = normalize(text), b = normalize(query); return b !== '' && ((b.length > 3 && a.includes(b)) || (b.length > 3 && a.replaceAll(' ', '').includes(b.replaceAll(' ', ''))) || b.split(' ').every(t => a.split(' ').some(w => w === t || w.startsWith(t) && t.length >= 4))); }
export function menuRows(raw: any): any[] { const d = raw?.data ?? raw; if (Array.isArray(d))
    return d.filter(x => x && typeof x === 'object' && x.id !== undefined && (x.price !== undefined || x.discount_price !== undefined) && Number(x.group_id ?? 0) === 0 && !['group', 'modifier', 'option', 'option_group', 'menu_group'].includes(x.type ?? x.menu_type)); return Array.isArray(d?.menus) ? menuRows(d.menus) : []; }
export function groups(item: any) { return (item.modifiers ?? item.option_groups ?? item.menu_groups ?? item.options ?? []).filter((g: any) => g && typeof g === 'object').map((g: any) => ({ id: Number(g.id), name: String(g.name ?? ''), min: Number(g.minimum_selection ?? g.min_selection ?? (g.required || g.is_required ? 1 : 0)), max: Number(g.maximum_selection ?? g.max_selection ?? 1), items: (g.items ?? g.menus ?? g.options ?? []).map((i: any) => ({ id: Number(i.id), name: String(i.name ?? ''), price_naira: Number(i.price ?? 0) / 100, in_stock: i.in_stock === true })) })); }
function imageUrls(item: any) { return [...new Set([...(item.images ?? []), item.image_url, item.image].map((x: any) => imageUrl(typeof x === 'string' ? x : x?.path ?? x?.url)).filter(Boolean))] as string[]; }
export function normalizeItem(i: any) { return { id: Number(i.id), name: String(i.name ?? ''), price_naira: Number(i.discount_price ?? i.price) / 100, base_price_kobo: Number(i.price), in_stock: i.in_stock === true, description: String(i.description ?? '').slice(0, 80), image_urls: imageUrls(i), category: String(i.category?.name ?? i.category_name ?? ''), group_ids: String(i.menu_group_ids ?? '').split(',').filter(Boolean), option_groups: groups(i), updated_at: String(i.updated_at ?? ''), container_type_id: i.container_type_id, container_price: i.container_price }; }
export async function cachedMenu(id: number, opts: {
    fresh?: boolean;
    hint?: string;
    details?: boolean;
} = {}) {
    return single(`menu-load:${id}:${!!opts.fresh}:${!!opts.details}`, async () => {
        const deadline = Date.now() + 3000;
        const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw Error('Vendor menu deadline exceeded'); return ms; };
        const head = await read(`menu-head:${id}`);
        let entry = !opts.fresh && head?.value?.key ? await read(head.value.key) : null;
        if (opts.hint && head?.hint && opts.hint !== head.hint)
            entry = null;
        if (entry && (!opts.details || entry.value.details_complete)) {
            if (opts.hint && !head.hint)
                await write(`menu-head:${id}`, head.value, 600, { hint: opts.hint });
            if (background && Date.now() - (head.value.checked_at ?? 0) > 60000)
                background(cachedMenu(id, { ...opts, fresh: true }).catch(() => { }));
            return { ...entry.value, cache_hit: true };
        }
        const raw = entry?.value?.items ? null : await limited(() => api.getMenu(id, undefined, { timeout_ms: remaining() }));
        const items = raw ? menuRows(raw).map(normalizeItem) : entry!.value.items;
        let complete = entry?.value?.details_complete ?? items.every((i: any) => i.group_ids.length === 0);
        if (opts.details && !complete) {
            const known = new Map<number, any>();
            for (const i of items)
                for (const g of i.option_groups)
                    known.set(g.id, g);
            const reps = new Map<string, any>();
            for (const i of items)
                if (i.group_ids.length && !i.group_ids.every((g: string) => known.has(Number(g))))
                    reps.set(i.group_ids.join(','), i);
            const details = await parallel([...reps.values()], async (i: any) => { try {
                return groups((await limited(() => api.getMenuItem(id, i.id, { timeout_ms: remaining() }))).data);
            }
            catch {
                return null;
            } });
            for (const list of details)
                for (const g of list ?? [])
                    known.set(g.id, g);
            for (const i of items)
                if (i.group_ids.length)
                    i.option_groups = i.group_ids.map((g: string) => known.get(Number(g))).filter(Boolean);
            complete = items.every((i: any) => i.group_ids.every((g: string) => i.option_groups.some((v: any) => v.id === Number(g))));
        }
        const updated = items.reduce((a: string, i: any) => i.updated_at > a ? i.updated_at : a, '') || 'unknown';
        const version = updated + ':' + createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 16), key = `menu:${id}:${version}`, value = { items, updated_at: updated, details_complete: complete };
        await write(key, value, 600);
        await write(`menu-head:${id}`, { key, checked_at: Date.now() }, 600, { hint: opts.hint });
        if (head?.value?.key && head.value.key !== key) {
            memory.delete(head.value.key);
            if (kv)
                await kv.delete(head.value.key).catch(() => { });
        }
        return { ...value, cache_hit: false };
    });
}
function vendorRows(raw: any) { return Array.isArray(raw?.data) ? raw.data : raw?.data?.vendors ?? raw?.data?.data ?? []; }
export async function openVendors(args: {
    vendor_type?: string;
    open_now?: boolean;
    max_distance_km?: number;
    max_vendors?: number;
}) {
    const key = `vendors:v2:${session.addressId}:${JSON.stringify(args)}`;
    const hit = await read(key);
    if (hit)
        return { ...hit.value, cache_hit: true };
    const value = await single(key, async () => {
        const all: any[] = [], seen = new Set<number>(), cursors = new Set<string>();
        let cursor: string | undefined, complete = false, pages = 0, skipped = 0;
        for (; pages < 20;) {
            const raw = await api.getVendors({ vendor_type: args.vendor_type, cursor, open_now: args.open_now });
            pages++;
            for (const v of vendorRows(raw)) {
                if (seen.has(v.id))
                    continue;
                seen.add(v.id);
                if (args.open_now !== false && v.is_open !== true || args.max_distance_km !== undefined && Number(v.distance) > args.max_distance_km) {
                    skipped++;
                    continue;
                }
                all.push({ id: v.id, name: v.name, distance: v.distance, delivery_price: v.delivery_price, is_open: v.is_open, menu_updated_at: v.menu_updated_at ?? v.menu_last_updated_at });
            }
            const next = raw?.meta?.next_cursor ?? raw?.data?.next_cursor, more = raw?.meta?.has_more ?? raw?.data?.has_more ?? !!next;
            if (!more) {
                complete = true;
                break;
            }
            if (all.length >= (args.max_vendors ?? 60))
                break;
            if (!next || cursors.has(next))
                break;
            cursors.add(next);
            cursor = next;
        }
        return { vendors: all.slice(0, args.max_vendors ?? 60), vendors_skipped: skipped, coverage_complete: complete && all.length <= (args.max_vendors ?? 60), pages };
    });
    await write(key, value, 120);
    return { ...value, cache_hit: false };
}
export async function searchEverywhere(args: {
    queries: string[];
    vendor_type?: string;
    open_now?: boolean;
    in_stock_only?: boolean;
    max_distance_km?: number;
    max_vendors?: number;
}) {
    const start = performance.now();
    const listed = await openVendors({ vendor_type: args.vendor_type, open_now: args.open_now, max_distance_km: args.max_distance_km, max_vendors: args.max_vendors });
    let skipped = listed.vendors_skipped, checked = 0, cacheHits = 0, incomplete = 0;
    const rows: any[] = [];
    await parallel(listed.vendors, async (v: any) => { try {
        const menu = await cachedMenu(v.id, { hint: v.menu_updated_at, details: true });
        checked++;
        if (!menu.details_complete) incomplete++;
        if (menu.cache_hit)
            cacheHits++;
        for (const i of menu.items) {
            if (args.in_stock_only && i.in_stock !== true)
                continue;
            for (const q of args.queries) {
                const n = matches(i.name, q), c = matches(i.category, q), o = i.option_groups.some((g: any) => matches(g.name, q));
                if (!n && !c && !o)
                    continue;
                rows.push({ vendor_id: v.id, vendor_name: v.name, distance_km: Number(v.distance), delivery_fee_naira: Number(v.delivery_price) / 100, item_id: i.id, item_name: i.name, price_naira: i.price_naira, in_stock: i.in_stock, image_url: i.image_urls[0] ?? null, matched_query: q, _rank: n ? 0 : c ? 1 : 2 });
            }
        }
    }
    catch {
        skipped++;
    } });
    rows.sort((a, b) => a._rank - b._rank || a.distance_km - b.distance_km || a.price_naira - b.price_naira || a.item_id - b.item_id);
    for (const r of rows)
        delete r._rank;
    return { items: rows, cache_hits: cacheHits, vendors_checked: checked, vendors_skipped: skipped, vendors_incomplete: incomplete, coverage_complete: listed.coverage_complete && checked === listed.vendors.length && incomplete === 0, max_vendors: args.max_vendors ?? 60, elapsed_ms: Math.round(performance.now() - start) };
}
export async function menuSlim(args: {
    vendor_ids: number[];
    category?: string;
    in_stock_only?: boolean;
    include_images?: boolean;
}) { const vendors = await parallel([...new Set(args.vendor_ids)], async (vendor_id) => { try {
    const m = await cachedMenu(vendor_id, { details: true });
    const items = m.items.filter((i: any) => (args.in_stock_only === false || i.in_stock) && (!args.category || normalize(i.category).includes(normalize(args.category)))).map((i: any) => ({ id: i.id, name: i.name, price_naira: i.price_naira, in_stock: i.in_stock, ...(i.description ? { description: i.description } : {}), ...(args.include_images !== false ? { image_url: i.image_urls[0] ?? null } : {}), ...(i.option_groups.some((g: any) => g.min > 0) ? { required_option_groups: i.option_groups.filter((g: any) => g.min > 0) } : {}) }));
    return { vendor_id, items, updated_at: m.updated_at, cache_hit: m.cache_hit, option_groups_complete: m.details_complete };
}
catch {
    return { vendor_id, items: [], error: 'menu_timeout_or_unavailable' };
} }); return { vendors }; }
export async function imagesBatch(items: {
    vendor_id: number;
    menu_id: number;
}[], limit = 1) { const menus = new Map<number, any>(); await parallel([...new Set(items.map(i => i.vendor_id))], async (id) => { try {
    menus.set(id, await cachedMenu(id));
}
catch { } }); return { items: items.map(i => { const item = menus.get(i.vendor_id)?.items.find((x: any) => x.id === i.menu_id); return { ...i, image_urls: item?.image_urls.slice(0, limit) ?? [], ...(!item ? { error: 'item_not_found_or_vendor_unavailable' } : {}) }; }), embedded_images: false }; }
export function prewarmFavorites() { const task = (async () => { const raw = await api.listFavorites(); await parallel(vendorRows(raw).slice(0, 60), async (v: any) => { try {
    await cachedMenu(v.id, { details: true });
}
catch { } }); })(); if (background)
    background(task.catch(() => { })); return task; }
