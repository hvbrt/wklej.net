// Global rate limiter Durable Object. One instance per SHA-256(ip) — raw IPs are
// never stored or passed here. Fixed 60s windows per action; counters auto-expire
// via a DO Alarm (no polling, no setTimeout).

import { ATLAS } from "./atlas";

const WINDOW_MS = 60_000;
const PRESENCE_TTL_MS = 45_000;
const INVITE_TTL_MS = 45_000;
const PRESENCE_REFRESH_EVERY_MS = 18_000;
const SHORTCUT_READY_TTL_MS = 75_000;
const MAX_PRESENCE_IDS = 16;
const MAX_INVITES = 32;
const LIMITS: Record<string, number> = {
  ice: 60, // TURN credential minting; enough for retries, bounded against abuse
  tree: 90, // emoji tree fetches: enough for UI, too low for fast enumeration
  session: 14, // completed pairing attempts: brute-force guard
  create: 10, // create room: 10/min
  join: 24, // join room: 24/min
  name: 8, // custom-name attempts: 8/min
  nameCheck: 36, // custom-name availability probes: 36/min
  end: 12, // authenticated teardown attempts
  shortcutReady: 24, // browser marks paired callbacks; no payload is stored
  shortcutStatus: 90, // iOS Shortcut polling while it waits for pairing
};

interface Counter {
  count: number;
  resetAt: number;
}
type Counters = Record<string, Counter>;
type Presence = Record<string, number | PresenceEntry>;

interface PresenceEntry {
  expiresAt: number;
  label: string;
}

interface NearbySelection {
  bucket: number;
  first: { id: number; pos: number };
  rest: number[];
  glyphs: string[];
  assets?: string[];
}

type NearbyInviteMode = "pair" | "send";

interface NearbyInvite {
  id: string;
  from: string;
  fromLabel: string;
  to: string;
  mode?: NearbyInviteMode;
  selection: NearbySelection;
  createdAt: number;
  expiresAt: number;
}

type Invites = Record<string, NearbyInvite>;

interface ShortcutReady {
  ready: true;
  createdAt: number;
  expiresAt: number;
}

const COUNTERS_KEY = "counters";
const PRESENCE_KEY = "presence";
const INVITES_KEY = "invites";
const SHORTCUT_READY_KEY = "shortcut-ready";

export class RateLimit implements DurableObject {
  constructor(
    private ctx: DurableObjectState,
    private env: unknown,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/presence" && req.method === "POST") {
      return this.handlePresence(req);
    }

    if (url.pathname === "/shortcut-ready" && req.method === "POST") {
      return this.handleShortcutReady();
    }

    if (url.pathname === "/shortcut-status" && req.method === "GET") {
      return this.handleShortcutStatus();
    }

    const action = url.searchParams.get("action") ?? "";
    const limit = LIMITS[action];
    if (limit === undefined) return Response.json({ allowed: false, reason: "bad-action" });

    const now = Date.now();
    const counters = (await this.ctx.storage.get<Counters>(COUNTERS_KEY)) ?? {};
    let c = counters[action];
    if (!c || now >= c.resetAt) {
      c = { count: 0, resetAt: now + WINDOW_MS };
    }
    c.count += 1;
    counters[action] = c;
    await this.ctx.storage.put(COUNTERS_KEY, counters);

    await this.scheduleAlarm(c.resetAt);

    const allowed = c.count <= limit;
    return Response.json({ allowed, count: c.count, limit, resetAt: c.resetAt });
  }

  private async handlePresence(req: Request): Promise<Response> {
    const body = await readPresence(req);
    const { id, present, label } = body;
    if (!isPresenceId(id)) return Response.json({ nearby: 0, ttl: 0 }, { status: 400 });

    const now = Date.now();
    const storedPresence = (await this.ctx.storage.get<Presence>(PRESENCE_KEY)) ?? {};
    const storedInvites = (await this.ctx.storage.get<Invites>(INVITES_KEY)) ?? {};
    const presence = prunePresence({ ...storedPresence }, now);
    const invites = pruneInvites({ ...storedInvites }, presence, now);
    let dirty = Object.keys(storedPresence).length !== Object.keys(presence).length || Object.keys(storedInvites).length !== Object.keys(invites).length;

    if (body.action === "invite") {
      const to = body.to ?? "";
      const selection = body.selection;
      if (!isPresenceId(to) || !presence[to] || !isSelection(selection)) {
        if (dirty) await this.persistPresenceState(presence, invites);
        return Response.json(this.snapshot(id, presence, invites, { ok: false, reason: "target-gone" }), { status: 404 });
      }
      if (Object.keys(invites).length < MAX_INVITES) {
        const inviteId = crypto.randomUUID();
        invites[inviteId] = {
          id: inviteId,
          from: id,
          fromLabel: cleanLabel(label),
          to,
          mode: body.mode === "send" ? "send" : "pair",
          selection,
          createdAt: now,
          expiresAt: now + INVITE_TTL_MS,
        };
        dirty = true;
      }
      if (dirty) await this.persistPresenceState(presence, invites);
      return Response.json(this.snapshot(id, presence, invites, { ok: true }));
    }

    if (body.action === "dismiss") {
      const inviteId = body.inviteId ?? "";
      if (inviteId && invites[inviteId] && (invites[inviteId]!.to === id || invites[inviteId]!.from === id)) {
        delete invites[inviteId];
        dirty = true;
      }
      if (dirty) await this.persistPresenceState(presence, invites);
      return Response.json(this.snapshot(id, presence, invites, { ok: true }));
    }

    if (present) {
      const keys = Object.keys(presence);
      if (presence[id] !== undefined || keys.length < MAX_PRESENCE_IDS) {
        const nextLabel = cleanLabel(label);
        const current = presence[id];
        const refreshDue = !current || entryExpiresAt(current) - now <= PRESENCE_TTL_MS - PRESENCE_REFRESH_EVERY_MS;
        const labelChanged = !!current && entryLabel(current) !== nextLabel;
        if (!current || refreshDue || labelChanged) {
          presence[id] = { expiresAt: now + PRESENCE_TTL_MS, label: nextLabel };
          dirty = true;
        }
      }
    } else {
      if (presence[id] !== undefined) {
        delete presence[id];
        dirty = true;
      }
      for (const invite of Object.values(invites)) {
        if (invite.from === id || invite.to === id) {
          delete invites[invite.id];
          dirty = true;
        }
      }
    }

    if (dirty) await this.persistPresenceState(presence, invites);
    return Response.json(this.snapshot(id, presence, invites));
  }

  private snapshot(
    selfId: string,
    presence: Presence,
    invites: Invites,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> {
    const now = Date.now();
    const devices = Object.entries(presence)
      .filter(([otherId, entry]) => otherId !== selfId && entryExpiresAt(entry) > now)
      .map(([id, entry]) => ({ id, label: entryLabel(entry), ageMs: entryAgeMs(entry, now) }));
    const incoming = Object.values(invites)
      .filter((invite) => invite.to === selfId && invite.expiresAt > now)
      .map(({ id, from, fromLabel, mode, selection, expiresAt }) => ({ id, from, fromLabel, mode: mode ?? "pair", selection, expiresAt }));
    return { nearby: devices.length, ttl: PRESENCE_TTL_MS / 1000, devices, invites: incoming, ...(extra ?? {}) };
  }

  private async persistPresenceState(presence: Presence, invites: Invites): Promise<void> {
    if (Object.keys(presence).length === 0) {
      await this.ctx.storage.delete(PRESENCE_KEY);
    } else {
      await this.ctx.storage.put(PRESENCE_KEY, presence);
    }
    if (Object.keys(invites).length === 0) {
      await this.ctx.storage.delete(INVITES_KEY);
    } else {
      await this.ctx.storage.put(INVITES_KEY, invites);
    }
    const nextPresence = Object.values(presence).map(entryExpiresAt);
    const nextInvites = Object.values(invites).map((invite) => invite.expiresAt);
    const next = [...nextPresence, ...nextInvites].sort((a, b) => a - b)[0];
    if (next !== undefined) await this.scheduleAlarm(next);
  }

  private async scheduleAlarm(at: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > at) await this.ctx.storage.setAlarm(at);
  }

  private async handleShortcutReady(): Promise<Response> {
    const now = Date.now();
    const status: ShortcutReady = {
      ready: true,
      createdAt: now,
      expiresAt: now + SHORTCUT_READY_TTL_MS,
    };
    await this.ctx.storage.put(SHORTCUT_READY_KEY, status);
    await this.scheduleAlarm(status.expiresAt);
    return Response.json({ ready: true, ttl: Math.ceil(SHORTCUT_READY_TTL_MS / 1000) });
  }

  private async handleShortcutStatus(): Promise<Response> {
    const now = Date.now();
    const status = await this.ctx.storage.get<ShortcutReady>(SHORTCUT_READY_KEY);
    if (!status || status.expiresAt <= now) {
      if (status) await this.ctx.storage.delete(SHORTCUT_READY_KEY);
      return Response.json({ ready: false, ttl: 0 });
    }
    return Response.json({ ready: true, ttl: Math.max(0, Math.ceil((status.expiresAt - now) / 1000)) });
  }

  // Expire counters whose window has elapsed; reschedule for any survivors.
  async alarm(): Promise<void> {
    const now = Date.now();
    const counters = (await this.ctx.storage.get<Counters>(COUNTERS_KEY)) ?? {};
    const presence = prunePresence((await this.ctx.storage.get<Presence>(PRESENCE_KEY)) ?? {}, now);
    const invites = pruneInvites((await this.ctx.storage.get<Invites>(INVITES_KEY)) ?? {}, presence, now);
    const shortcutReady = await this.ctx.storage.get<ShortcutReady>(SHORTCUT_READY_KEY);
    let next: number | null = null;
    for (const k of Object.keys(counters)) {
      if (counters[k]!.resetAt <= now) delete counters[k];
      else next = next === null ? counters[k]!.resetAt : Math.min(next, counters[k]!.resetAt);
    }
    for (const expiresAt of Object.values(presence).map(entryExpiresAt)) {
      next = next === null ? expiresAt : Math.min(next, expiresAt);
    }
    for (const expiresAt of Object.values(invites).map((invite) => invite.expiresAt)) {
      next = next === null ? expiresAt : Math.min(next, expiresAt);
    }
    const hasShortcutReady = !!shortcutReady && shortcutReady.expiresAt > now;
    if (hasShortcutReady) next = next === null ? shortcutReady.expiresAt : Math.min(next, shortcutReady.expiresAt);

    const hasCounters = Object.keys(counters).length > 0;
    const hasPresence = Object.keys(presence).length > 0;
    const hasInvites = Object.keys(invites).length > 0;
    if (!hasCounters && !hasPresence && !hasInvites && !hasShortcutReady) {
      await this.ctx.storage.deleteAll();
    } else {
      if (hasCounters) await this.ctx.storage.put(COUNTERS_KEY, counters);
      else await this.ctx.storage.delete(COUNTERS_KEY);
      if (hasPresence) await this.ctx.storage.put(PRESENCE_KEY, presence);
      else await this.ctx.storage.delete(PRESENCE_KEY);
      if (hasInvites) await this.ctx.storage.put(INVITES_KEY, invites);
      else await this.ctx.storage.delete(INVITES_KEY);
      if (!hasShortcutReady) await this.ctx.storage.delete(SHORTCUT_READY_KEY);
      if (next !== null) await this.ctx.storage.setAlarm(next);
    }
  }
}

async function readPresence(req: Request): Promise<{
  id: string;
  present: boolean;
  label: string;
  action: string;
  to?: string;
  inviteId?: string;
  selection?: NearbySelection;
  mode?: NearbyInviteMode;
}> {
  try {
    const body = await req.json<{
      id?: unknown;
      present?: unknown;
      label?: unknown;
      action?: unknown;
      to?: unknown;
      inviteId?: unknown;
      selection?: unknown;
      mode?: unknown;
    }>();
    return {
      id: typeof body.id === "string" ? body.id : "",
      present: body.present !== false,
      label: typeof body.label === "string" ? body.label : "",
      action: typeof body.action === "string" ? body.action : "presence",
      to: typeof body.to === "string" ? body.to : undefined,
      inviteId: typeof body.inviteId === "string" ? body.inviteId : undefined,
      selection: isSelection(body.selection) ? body.selection : undefined,
      mode: body.mode === "send" ? "send" : "pair",
    };
  } catch {
    return { id: "", present: false, label: "", action: "presence" };
  }
}

function isPresenceId(id: string): boolean {
  return /^[A-Za-z0-9._:-]{8,96}$/.test(id);
}

function prunePresence(presence: Presence, now: number): Presence {
  for (const id of Object.keys(presence)) {
    if (entryExpiresAt(presence[id]!) <= now) delete presence[id];
  }
  return presence;
}

function pruneInvites(invites: Invites, presence: Presence, now: number): Invites {
  for (const invite of Object.values(invites)) {
    if (invite.expiresAt <= now || !presence[invite.from] || !presence[invite.to]) delete invites[invite.id];
  }
  return invites;
}

function entryExpiresAt(entry: number | PresenceEntry): number {
  return typeof entry === "number" ? entry : entry.expiresAt;
}

function entryLabel(entry: number | PresenceEntry): string {
  return typeof entry === "number" ? "urządzenie obok" : entry.label;
}

function entryAgeMs(entry: number | PresenceEntry, now: number): number {
  if (typeof entry === "number") return 0;
  return Math.max(0, now - (entry.expiresAt - PRESENCE_TTL_MS));
}

function cleanLabel(label: string): string {
  const safe = label.replace(/[^\p{L}\p{N} ._-]/gu, "").trim();
  return safe.slice(0, 32) || "urządzenie obok";
}

function isSelection(value: unknown): value is NearbySelection {
  if (!value || typeof value !== "object") return false;
  const v = value as NearbySelection;
  return (
    Number.isInteger(v.bucket) &&
    v.bucket > 0 &&
    !!v.first &&
    Number.isInteger(v.first.id) &&
    v.first.id >= 1 &&
    v.first.id <= ATLAS.length &&
    Number.isInteger(v.first.pos) &&
    v.first.pos >= 1 &&
    v.first.pos <= 12 &&
    Array.isArray(v.rest) &&
    v.rest.length === 2 &&
    v.rest.every((id) => Number.isInteger(id) && id >= 1 && id <= ATLAS.length) &&
    Array.isArray(v.glyphs) &&
    v.glyphs.length === 3 &&
    v.glyphs.every((glyph) => typeof glyph === "string" && glyph.length > 0 && glyph.length <= 16) &&
    (v.assets === undefined ||
      (Array.isArray(v.assets) &&
        v.assets.length === 3 &&
        v.assets.every((asset) => typeof asset === "string" && /^\/emoji\/[0-9a-f_]+\.webp$/.test(asset))))
  );
}
