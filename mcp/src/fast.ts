import * as api from './api.js';
import { session } from './session.js';
import { imageUrl } from './media.js';
import { createHash, randomUUID } from 'node:crypto';
import { currentBudget, chargeSubrequest, withRequestBudget, SubrequestBudgetError } from './budget.js';
type KV = {
    get(k: string | string[], t: 'json'): Promise<any>;
    getMany?(keys: string[], t: 'json'): Promise<Map<string, any>>;
    putMany?(entries: { key: string; value: string; expirationTtl: number }[]): Promise<void>;
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
        chargeSubrequest('internal');
        e = await kv.get(key, 'json');
        if (e && e.expires > Date.now()) {
            memory.set(key, e);
            return e;
        }
    }
    catch (error) { if (error instanceof SubrequestBudgetError) throw error; } return null; }
async function write(key: string, value: any, ttl: number, extra: any = {}, persist = true) { const e = { value, expires: Date.now() + ttl * 1000, ...extra }; memory.set(key, e); if (memory.size > 240)
    memory.delete(memory.keys().next().value!); if (persist && kv && (!currentBudget() || currentBudget()!.internal < currentBudget()!.internalLimit - 4)) {
    chargeSubrequest('internal');
    await kv.put(key, JSON.stringify(e), { expirationTtl: ttl }).catch(() => { }); } return e; }
// Bulk-load a bounded batch before menu matching: two KV round trips instead of
// two per vendor. Six large menus stay well below KV's 25 MiB bulk response cap;
// unavailable/oversized bulk reads safely fall back to ordinary per-key reads.
async function primeMenus(ids: number[]) {
    if (!kv) return;
    async function bulk(keys: string[], negativeHeads = false) {
        const missing = keys.filter(k => !memory.get(k) || memory.get(k).expires <= Date.now());
        if (!missing.length) return;
        try {
            // D1's getMany is one SQL query. Legacy adapters may issue one per key.
            if (kv!.getMany) chargeSubrequest('internal');
            else for (const key of missing) chargeSubrequest('internal');
            const entries = kv!.getMany ? await kv!.getMany(missing, 'json') : await kv!.get(missing, 'json');
            if (!(entries instanceof Map)) return;
            for (const key of missing) {
                const entry = entries.get(key);
                if (entry?.expires > Date.now()) memory.set(key, entry);
                else if (negativeHeads) memory.set(key, { value: null, expires: Date.now() + 5000 });
            }
        } catch { /* The normal reads below retain budget/error handling. */ }
    }
    await bulk(ids.map(id => `menu-head:${id}`), true);
    await bulk(ids.map(id => memory.get(`menu-head:${id}`)?.value?.key).filter(Boolean));
}
async function single(key: string, fn: () => Promise<any>) { if (pending.has(key))
    return pending.get(key)!; const p = fn().finally(() => pending.delete(key)); pending.set(key, p); return p; }
let active = 0;
const waiters: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>) { if (active >= (currentBudget()?.search ? 6 : 12))
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
function matches(text: string, query: string) { const canonical = (value: string) => normalize(value).replace(/\b(?:cables?|cords?|chords?)\b/g, 'cable').replace(/\b(?:usb|type)\s*c\b/g, 'usb c'); const a = canonical(text), b = canonical(query); return b !== '' && ((b.length > 3 && a.includes(b)) || (b.length > 3 && a.replaceAll(' ', '').includes(b.replaceAll(' ', ''))) || b.split(' ').every(t => a.split(' ').some(w => w === t || w.startsWith(t) && t.length >= 4))); }
export function menuRows(raw: any): any[] { const d = raw?.data ?? raw; if (Array.isArray(d))
    return d.filter(x => x && typeof x === 'object' && x.id !== undefined && (x.price !== undefined || x.discount_price !== undefined) && Number(x.group_id ?? 0) === 0 && !['group', 'modifier', 'option', 'option_group', 'menu_group'].includes(x.type ?? x.menu_type)); return Array.isArray(d?.menus) ? menuRows(d.menus) : []; }
export function groups(item: any) { return (item.modifiers ?? item.option_groups ?? item.menu_groups ?? item.options ?? []).filter((g: any) => g && typeof g === 'object').map((g: any) => ({ id: Number(g.id), name: String(g.name ?? ''), min: Number(g.minimum_selection ?? g.min_selection ?? (g.required || g.is_required ? 1 : 0)), max: Number(g.maximum_selection ?? g.max_selection ?? 1), items: (g.items ?? g.menus ?? g.options ?? []).map((i: any) => ({ id: Number(i.id), name: String(i.name ?? ''), price_naira: Number(i.price ?? 0) / 100, in_stock: i.in_stock === true })) })); }
function imageUrls(item: any) { return [...new Set([...(item.images ?? []), item.image_url, item.image].map((x: any) => imageUrl(typeof x === 'string' ? x : x?.path ?? x?.url)).filter(Boolean))] as string[]; }
export function normalizeItem(i: any) { return { id: Number(i.id), name: String(i.name ?? ''), price_naira: Number(i.discount_price ?? i.price) / 100, base_price_kobo: Number(i.price), in_stock: i.in_stock === true, description: String(i.description ?? '').slice(0, 80), image_urls: imageUrls(i), category: String(i.category?.name ?? i.category_name ?? ''), group_ids: String(i.menu_group_ids ?? '').split(',').filter(Boolean), option_groups: groups(i), updated_at: String(i.updated_at ?? ''), container_type_id: i.container_type_id, container_price: i.container_price }; }
export async function cachedMenu(id: number, opts: {
    fresh?: boolean;
    hint?: string;
    details?: boolean;
    timeout_ms?: number;
} = {}) {
    return single(`menu-load:${id}:${!!opts.fresh}:${!!opts.details}`, async () => {
        const deadline = Date.now() + (opts.timeout_ms ?? 3000);
        const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw Error('Vendor menu deadline exceeded'); return ms; };
        const head = await read(`menu-head:${id}`);
        let entry = !opts.fresh && head?.value?.key ? await read(head.value.key) : null;
        if (opts.hint && head?.hint && opts.hint !== head.hint)
            entry = null;
        if (entry && (!opts.details || entry.value.details_complete)) {
            if (opts.hint && !head.hint)
                await write(`menu-head:${id}`, head.value, 600, { hint: opts.hint });
            if (background && !currentBudget()?.search && Date.now() - (head.value.checked_at ?? 0) > 60000)
                background(cachedMenu(id, { ...opts, fresh: true }).catch(() => { }));
            return { ...entry.value, cache_hit: true };
        }
        const raw = entry?.value?.items ? null : await limited(() => api.getMenu(id, undefined, { timeout_ms: remaining() }));
        const items = raw ? menuRows(raw).map(normalizeItem) : entry!.value.items;
        let absentGroups: string[] = entry?.value?.absent_group_ids ?? [];
        let budgetLimited = false;
        let complete = entry?.value?.details_complete ?? items.every((i: any) => i.group_ids.length === 0);
        if (opts.details && !complete) {
            const known = new Map<number, any>();
            const absent = new Set<string>(entry?.value?.absent_group_ids ?? []);
            for (const i of items)
                for (const g of i.option_groups)
                    known.set(g.id, g);
            // Pick a small set of representative items covering all unknown groups.
            // Distinct combinations often overlap heavily on large restaurant menus.
            const reps: any[] = [], uncovered = new Set<string>(items.flatMap((i: any) => i.group_ids).filter((g: string) => !known.has(Number(g)) && !absent.has(g)));
            while (uncovered.size) {
                let best: any, score = 0;
                for (const i of items) {
                    const count = i.group_ids.filter((g: string) => uncovered.has(g)).length;
                    if (count > score) { best = i; score = count; }
                }
                if (!best) break;
                reps.push(best);
                for (const g of best.group_ids) uncovered.delete(g);
            }
            const details = await parallel(reps, async (i: any) => { try {
                const data = (await limited(() => api.getMenuItem(id, i.id, { timeout_ms: remaining() }))).data;
                const parsed = groups(data);
                // Explicit item-detail modifiers are authoritative active membership.
                // Root menus can retain retired group IDs indefinitely.
                return { groups: parsed, absent: Number(data?.id) === i.id && Array.isArray(data?.modifiers) ? i.group_ids.filter((g: string) => !parsed.some((v: any) => v.id === Number(g))) : [] };
            }
            catch (error) {
                if (error instanceof SubrequestBudgetError) budgetLimited = true;
                return null;
            } });
            for (const detail of details) {
                for (const g of detail?.groups ?? []) known.set(g.id, g);
                for (const g of detail?.absent ?? []) absent.add(g);
            }
            for (const i of items)
                if (i.group_ids.length)
                    i.option_groups = i.group_ids.map((g: string) => known.get(Number(g))).filter(Boolean);
            absentGroups = [...absent].filter(g => !known.has(Number(g)));
            complete = items.every((i: any) => i.group_ids.every((g: string) => i.option_groups.some((v: any) => v.id === Number(g)) || absent.has(g)));
        }
        const updated = items.reduce((a: string, i: any) => i.updated_at > a ? i.updated_at : a, '') || 'unknown';
        const version = updated + ':' + createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 16), key = `menu:${id}:${version}`, value = { items, updated_at: updated, details_complete: complete, absent_group_ids: absentGroups, budget_limited: budgetLimited };
        if (kv?.putMany) {
            const menuEntry = await write(key, value, 600, {}, false);
            const headEntry = await write(`menu-head:${id}`, { key, checked_at: Date.now() }, 600, { hint: opts.hint }, false);
            if (!currentBudget() || currentBudget()!.internal < currentBudget()!.internalLimit - 2) {
            chargeSubrequest('internal');
            await kv.putMany([{ key, value: JSON.stringify(menuEntry), expirationTtl: 600 }, { key: `menu-head:${id}`, value: JSON.stringify(headEntry), expirationTtl: 600 }]).catch(() => { });
            }
        } else {
            await write(key, value, 600);
            await write(`menu-head:${id}`, { key, checked_at: Date.now() }, 600, { hint: opts.hint });
        }
        if (head?.value?.key && head.value.key !== key) {
            memory.delete(head.value.key);
            if (kv && (!currentBudget() || currentBudget()!.internal < currentBudget()!.internalLimit - 4)) {
                chargeSubrequest('internal');
                await kv.delete(head.value.key).catch(() => { }); }
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
export const VALID_VENDOR_TYPES = ['restaurant', 'supermarket', 'pharmacy', 'local market', 'chowstore'];
export const VENDOR_TYPE_ALIASES: Record<string, string> = { shop: 'supermarket', local_market: 'local market', 'local-market': 'local market' };
type SearchArgs = { queries: string[]; vendor_type?: string; open_now?: boolean; in_stock_only?: boolean; max_distance_km?: number; max_vendors?: number; cursor?: string; vendor_ids?: number[] };
export async function searchEverywhere(args: SearchArgs): Promise<any> {
    if (!currentBudget()) return withRequestBudget({ plan: process.env.CHOWDECK_WORKERS_PLAN, limit: process.env.CHOWDECK_SUBREQUEST_LIMIT }, () => searchEverywhere(args));
    const budget = currentBudget()!, wasSearch = budget.search;
    budget.search = true;
    try { return await searchPage(args); } finally { budget.search = wasSearch; }
}
async function searchPage(args: SearchArgs) {
    const start = performance.now(), budget = currentBudget()!;
    const vendorType = args.vendor_type ? VENDOR_TYPE_ALIASES[args.vendor_type] ?? args.vendor_type : undefined;
    if (vendorType && !VALID_VENDOR_TYPES.includes(vendorType)) return { items: [], error: 'invalid_vendor_type', valid_vendor_types: VALID_VENDOR_TYPES, vendor_type_aliases: VENDOR_TYPE_ALIASES, coverage_complete: false, next_cursor: null, elapsed_ms: Math.round(performance.now() - start) };
    const scope = { address_id: session.addressId, queries: args.queries, vendor_ids: args.vendor_ids ? [...new Set(args.vendor_ids)].sort((a,b)=>a-b) : undefined, vendor_type: vendorType, open_now: args.open_now !== false, in_stock_only: !!args.in_stock_only, max_distance_km: args.max_distance_km };
    const fingerprint = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    const resultKey = `search-result:v2:${fingerprint}:${args.max_vendors ?? 60}`;
    if (!args.cursor) {
        const cached = await read(resultKey);
        if (cached) return { ...cached.value, cache_hits: 0, vendors_from_result_cache: cached.value.vendors_checked, result_cache_hit: true, subrequests: budget.stats(), elapsed_ms: Math.round(performance.now() - start) };
    }
    let state: any = { pending: [], seen: [], upstream: null, started: false, done: false, upstream_seen: [], checked: 0, eligible: 0, failed: [], attempts: {} };
    if (args.cursor) {
        if (!/^search:[a-f0-9-]{36}$/.test(args.cursor)) throw Error('Invalid search cursor.');
        const saved = await read(args.cursor);
        if (!saved || saved.value.fingerprint !== fingerprint) throw Error('Search cursor expired or does not match queries, filters and address. Restart the search.');
        state = structuredClone(saved.value.state);
    }
    const cap = Math.max(1, Math.min(200, args.max_vendors ?? 60)), rows: any[] = [], deferred: any[] = [];
    const reasons = { closed: 0, cap_reached: 0, budget: 0, error: 0, distance: 0 };
    if (!args.cursor && scope.vendor_ids) {
        // Explicit small scopes avoid loading unrelated menus for comparisons or
        // repeat searches at known vendors. Normal discovery remains unchanged.
        state.done = true;
        const selected = await parallel(scope.vendor_ids, async id => {
            try { return (await api.getVendor(id)).data; }
            catch { state.failed.push({ vendor_id: id, reason: 'vendor_unavailable' }); reasons.error++; return null; }
        }, 6);
        for (const v of selected) {
            if (!v) continue;
            state.seen.push(v.id);
            if (vendorType && v.vendor_type !== vendorType) continue;
            if (args.open_now !== false && v.is_open !== true) { reasons.closed++; continue; }
            if (args.max_distance_km !== undefined && Number(v.distance) > args.max_distance_km) { reasons.distance++; continue; }
            state.pending.push(v); state.eligible++;
        }
    }
    const checkedIds: number[] = [];
    let checked = 0, cacheHits = 0, incomplete = 0, attempted = 0, stop = false;
    const seen = new Set<number>(state.seen);
    while (!stop && attempted < cap) {
        if (!state.pending.length) {
            if (state.done) break;
            try {
                const key = `vendor-page:v3:${session.addressId}:${vendorType ?? 'all'}:${args.open_now !== false}:${state.upstream ?? 'first'}`;
                let page = (await read(key))?.value;
                if (!page) {
                    const raw = await api.getVendors({ vendor_type: vendorType, cursor: state.upstream ?? undefined, open_now: args.open_now });
                    page = { vendors: vendorRows(raw), next: raw?.meta?.next_cursor ?? raw?.data?.next_cursor, more: raw?.meta?.has_more ?? raw?.data?.has_more };
                    if (page.more === undefined) page.more = !!page.next;
                    await write(key, page, 120);
                }
                state.started = true;
                for (const v of page.vendors) {
                    if (seen.has(v.id)) continue;
                    seen.add(v.id);
                    if (args.open_now !== false && v.is_open !== true) { reasons.closed++; continue; }
                    if (args.max_distance_km !== undefined && Number(v.distance) > args.max_distance_km) { reasons.distance++; continue; }
                    state.eligible++;
                state.pending.push({ id: v.id, name: v.name, distance: v.distance, delivery_price: v.delivery_price, menu_updated_at: v.menu_updated_at ?? v.menu_last_updated_at });
                }
                state.done = !page.more;
                if (page.more && (!page.next || state.upstream_seen.includes(page.next))) {
                    state.done = true; state.failed.push({ stage: 'vendor_listing', reason: 'invalid_upstream_cursor' }); reasons.error++;
                }
                if (!state.done) { state.upstream = page.next; state.upstream_seen.push(page.next); }
            } catch (error) {
                if (error instanceof SubrequestBudgetError) reasons.budget++; else reasons.error++;
                stop = true;
            }
            if (!state.pending.length) continue;
        }
        const batch = state.pending.splice(0, Math.min(6, cap - attempted));
        attempted += batch.length;
        const retry: any[] = [];
        await primeMenus(batch.map((v: any) => v.id));
        await parallel(batch, async (v: any) => {
            try {
                const menu = await cachedMenu(v.id, { hint: v.menu_updated_at, details: true, timeout_ms: state.attempts[v.id] ? 8000 : 3000 });
                checked++; checkedIds.push(v.id);
                if (menu.cache_hit) cacheHits++;
                if (!menu.details_complete) {
                    incomplete++;
                    if (menu.budget_limited) { reasons.budget++; retry.push(v); stop = true; }
                    else {
                        reasons.error++; state.attempts[v.id] = (state.attempts[v.id] ?? 0) + 1;
                        if (state.attempts[v.id] < 3) deferred.push(v); else state.failed.push({ vendor_id: v.id, reason: 'option_details_unavailable' });
                    }
                } else state.checked++;
                for (const i of menu.items) {
                    if (args.in_stock_only && !i.in_stock) continue;
                    for (const q of args.queries) {
                        const n = matches(i.name, q), c = matches(i.category, q) || matches(`${i.name} ${i.category}`, q), o = i.option_groups.some((g: any) => matches(g.name, q));
                        if (!n && !c && !o) continue;
                        rows.push({ vendor_id: v.id, vendor_name: v.name, distance_km: Number(v.distance), delivery_fee_naira: Number(v.delivery_price) / 100, item_id: i.id, item_name: i.name, price_naira: i.price_naira, in_stock: i.in_stock, image_url: i.image_urls[0] ?? null, matched_query: q, _rank: n ? 0 : c ? 1 : 2 });
                    }
                }
            } catch (error) {
                incomplete++;
                if (error instanceof SubrequestBudgetError) { reasons.budget++; retry.push(v); stop = true; }
                else {
                    reasons.error++; state.attempts[v.id] = (state.attempts[v.id] ?? 0) + 1;
                    if (state.attempts[v.id] < 3) deferred.push(v); else state.failed.push({ vendor_id: v.id, reason: 'menu_unavailable', code: String((error as any)?.code ?? (error as any)?.name ?? 'unknown') });
                }
            }
        });
        state.pending.push(...retry);
    }
    state.pending.push(...deferred);
    state.seen = [...seen];
    const more = state.pending.length > 0 || !state.done;
    if (more && attempted >= cap && !reasons.budget) reasons.cap_reached = state.pending.length || 1;
    let cursor: string | null = null;
    if (more) {
        cursor = `search:${randomUUID()}`;
        // Cursor checkpoint uses a reserved internal request and survives isolate eviction.
        const entry = { value: { fingerprint, state }, expires: Date.now() + 900000 };
        memory.set(cursor, entry);
        if (kv) { budget.take('internal', true); await kv.put(cursor, JSON.stringify(entry), { expirationTtl: 900 }); }
    }
    rows.sort((a, b) => a._rank - b._rank || a.distance_km - b.distance_km || a.price_naira - b.price_naira || a.item_id - b.item_id);
    for (const r of rows) delete r._rank;
    const result = { items: rows, cache_hits: cacheHits, vendors_checked: checked, vendors_checked_total: state.checked, vendor_ids_checked: checkedIds, eligible_vendors_discovered: state.eligible, vendors_discovered_total: seen.size, vendors_skipped: Object.values(reasons).reduce((a, b) => a + b, 0), vendors_incomplete: Math.max(incomplete, state.pending.length + state.failed.length, !state.done ? 1 : 0), skip_reasons: reasons, undiscovered_vendors_remaining: !state.done, errors: state.failed, coverage_complete: !more && !state.failed.length, next_cursor: cursor, cursor_expires_in_seconds: cursor ? 900 : null, valid_vendor_types: VALID_VENDOR_TYPES, vendor_type_aliases: VENDOR_TYPE_ALIASES, vendor_type: vendorType ?? null, scope_vendor_ids: scope.vendor_ids ?? null, max_vendors: cap, subrequests: budget.stats(), elapsed_ms: Math.round(performance.now() - start) };
    if (!args.cursor && !reasons.error && !reasons.budget) await write(resultKey, result, 120);
    result.subrequests = budget.stats();
    result.elapsed_ms = Math.round(performance.now() - start);
    return result;
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
