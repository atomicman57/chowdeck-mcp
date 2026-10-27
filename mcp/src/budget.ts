import { AsyncLocalStorage } from 'node:async_hooks';

// One context per HTTP invocation, shared by retries, refresh and parallel work.
export class SubrequestBudgetError extends Error {
    constructor() { super('Search subrequest budget exhausted'); this.name = 'SubrequestBudgetError'; }
}
export class RequestBudget {
    external = 0; internal = 0; search = false;
    readonly externalLimit: number; readonly internalLimit: number;
    constructor(config: { plan?: string; limit?: string | number; storage?: 'd1' | 'kv' } = {}) {
        const planLimit = config.plan === 'paid' ? 1000 : 50;
        const configured = Number(config.limit ?? planLimit);
        const limit = Number.isInteger(configured) && configured >= 12 ? Math.min(configured, planLimit) : 50;
        this.externalLimit = limit - 8;
        this.internalLimit = config.storage === 'd1' ? Math.max(4, limit - 8) : Math.min(config.plan === 'paid' ? limit : 1000, 1000) - 16;
    }
    take(kind: 'external' | 'internal', checkpoint = false) {
        if (this.search && this[kind] >= (kind === 'external' ? this.externalLimit : this.internalLimit - (checkpoint ? 0 : 2))) throw new SubrequestBudgetError();
        this[kind]++;
    }
    stats() { return { external: this.external, internal: this.internal, external_budget: this.externalLimit, internal_budget: this.internalLimit }; }
}
const context = new AsyncLocalStorage<RequestBudget>();
export const currentBudget = () => context.getStore();
export const chargeSubrequest = (kind: 'external' | 'internal') => currentBudget()?.take(kind);
export function withRequestBudget<T>(config: { plan?: string; limit?: string | number; storage?: 'd1' | 'kv' }, fn: () => T): T {
    return context.run(new RequestBudget(config), fn);
}
