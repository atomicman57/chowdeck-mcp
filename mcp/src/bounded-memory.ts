// Conservative retained-size accounting: JSON bytes * 4 + per-entry overhead.
// This bounds the cache's retained estimate, not transient parsing/response allocations.
export class BoundedMemoryCache extends Map<string, any> {
    private weights = new Map<string, number>();
    accountedBytes = 0;
    constructor(readonly maxBytes = 12 * 1024 * 1024, readonly maxEntries = 240, readonly maxEntryBytes = 3 * 1024 * 1024) { super(); }
    override get(key: string) {
        const value = super.get(key);
        if (value && value.expires <= Date.now()) { this.delete(key); return undefined; }
        if (value !== undefined) { super.delete(key); super.set(key, value); }
        return value;
    }
    override set(key: string, value: any): this {
        this.delete(key);
        for (const [k, entry] of this) if (entry.expires <= Date.now()) this.delete(k);
        if (!value || !Number.isFinite(value.expires) || value.expires <= Date.now()) return this;
        let bytes: number;
        try { bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength * 4 + new TextEncoder().encode(key).byteLength * 2 + 192; }
        catch { return this; }
        if (bytes > this.maxEntryBytes || bytes > this.maxBytes) return this;
        while (this.size && (this.size >= this.maxEntries || this.accountedBytes + bytes > this.maxBytes)) this.delete(this.keys().next().value!);
        super.set(key, value); this.weights.set(key, bytes); this.accountedBytes += bytes;
        return this;
    }
    override delete(key: string) {
        this.accountedBytes -= this.weights.get(key) ?? 0; this.weights.delete(key);
        return super.delete(key);
    }
    override clear() { super.clear(); this.weights.clear(); this.accountedBytes = 0; }
}
