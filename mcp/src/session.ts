/*!
 * Chowdeck MCP · session store
 * Author: Hendrix Nwaokolo (@thathman) <hello@airixmedia.com>
 * License: MIT. © 2026 Hendrix Nwaokolo.
 * Watermark: THATHMAN·CHOWDECK·MCP
 */
// Session state persisted to disk so login/OTP setup only happens once.
// Stored at ~/.chowdeck-mcp/session.json
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const DIR = process.env.CHOWDECK_SESSION_DIR ?? path.join(os.homedir(), ".chowdeck-mcp");
const FILE = path.join(DIR, "session.json");
// Personal installations can keep auth exclusively in the encrypted central store.
const MEMORY_ONLY = process.env.CHOWDECK_SESSION_PERSISTENCE === "memory";
const STORE_HELPER = process.env.CHOWDECK_CREDENTIAL_HELPER;
const STORE_SESSION = process.env.CHOWDECK_CREDENTIAL_SESSION ?? "chowdeck/personal";

export type PaymentPref = {
  mode: "default" | "ask";
  paymentMethod?: "wallet" | "card" | "online_payment" | "pay_for_me";
  methodId?: number;
  methodLabel?: string;
};

type SessionState = {
  token: string | null;
  guestId: string | null;
  addressId: number | null;
  phone: string | null;
  paymentPref: PaymentPref | null;
  data: Record<string, any>;
};

const DEFAULTS: SessionState = {
  token: null,
  guestId: null,
  addressId: null,
  phone: null,
  paymentPref: null,
  data: {},
};

function load(): SessionState {
  if (MEMORY_ONLY) return { ...DEFAULTS };
  if (STORE_HELPER) {
    try {
      const value = execFileSync(STORE_HELPER, ["get-session", STORE_SESSION], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      return { ...DEFAULTS, ...JSON.parse(value) };
    } catch (error: any) {
      if (String(error.stderr ?? "").includes("is missing from the central store")) return { ...DEFAULTS };
      throw new Error("Unable to read encrypted Chowdeck session. Repair credential-store access before continuing.");
    }
  }
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(state: SessionState) {
  if (MEMORY_ONLY) return;
  if (STORE_HELPER) {
    try {
      execFileSync(STORE_HELPER, ["put-session", STORE_SESSION], { input: JSON.stringify(state), stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      throw new Error("Unable to persist encrypted Chowdeck session. No plaintext fallback was written.");
    }
    return;
  }
  try {
    // The file holds a bearer token — keep it private to the current user.
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(DIR, 0o700);
      fs.chmodSync(FILE, 0o600);
    } catch {
      // chmod may be unsupported (e.g. Windows) — directory ACLs still apply.
    }
  } catch {
    // persistence is best-effort; in-memory state still works
  }
}

// Proxy so any assignment (session.token = ...) is written to disk immediately.
export const session: SessionState = new Proxy(load(), {
  set(target, prop, value) {
    const next = { ...target, [prop]: value };
    save(next);
    (target as any)[prop] = value;
    return true;
  },
});

export function clearSession() {
  session.token = null;
  session.guestId = null;
  session.addressId = null;
  session.phone = null;
  session.paymentPref = null;
}

// Assignments persist synchronously in local modes; hosted storage overrides this.
export async function persistNow(): Promise<void> {}
