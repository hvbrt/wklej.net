// Rate-limit + same-network presence gate. Raw IPs are never stored or passed
// to Durable Objects; rate limits use exact IP hashes, nearby uses a broader
// network hash so IPv6 privacy addresses on one Wi-Fi can still meet.

async function hashValue(value: string): Promise<string> {
  const normalized = value.trim().toLowerCase();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hashIp(ip: string): Promise<string> {
  return hashValue(`ip:${ip.trim().toLowerCase()}`);
}

function hashNearbyNetwork(ip: string): Promise<string> {
  return hashValue(`nearby:${nearbyNetworkScope(ip)}`);
}

async function check(
  rl: DurableObjectNamespace,
  ip: string,
  action: "create" | "join" | "name" | "nameCheck",
): Promise<boolean> {
  const id = rl.idFromName(await hashIp(ip));
  const stub = rl.get(id);
  const res = await stub.fetch(`https://ratelimit/check?action=${action}`);
  const { allowed } = await res.json<{ allowed: boolean }>();
  return allowed;
}

export function allowCreate(rl: DurableObjectNamespace, ip: string): Promise<boolean> {
  return check(rl, ip, "create");
}

export function allowJoin(rl: DurableObjectNamespace, ip: string): Promise<boolean> {
  return check(rl, ip, "join");
}

export function allowNamedSession(rl: DurableObjectNamespace, ip: string): Promise<boolean> {
  return check(rl, ip, "name");
}

export function allowNamedCheck(rl: DurableObjectNamespace, ip: string): Promise<boolean> {
  return check(rl, ip, "nameCheck");
}

export interface NearbySelection {
  bucket: number;
  first: { id: number; pos: number };
  rest: number[];
  glyphs: string[];
  assets?: string[];
}

export type NearbyInviteMode = "pair" | "send";

export interface NearbyRequest {
  id: string;
  present: boolean;
  label?: string;
  action?: string;
  to?: string;
  inviteId?: string;
  selection?: NearbySelection;
  mode?: NearbyInviteMode;
}

export interface NearbyResult {
  nearby: number;
  ttl: number;
  devices?: Array<{ id: string; label: string; ageMs?: number }>;
  invites?: Array<{
    id: string;
    from: string;
    fromLabel: string;
    mode?: NearbyInviteMode;
    selection: NearbySelection;
    expiresAt: number;
  }>;
  ok?: boolean;
  reason?: string;
}

export async function updateNearbyPresence(
  rl: DurableObjectNamespace,
  ip: string,
  body: NearbyRequest,
): Promise<NearbyResult> {
  const id = rl.idFromName(await hashNearbyNetwork(ip));
  const stub = rl.get(id);
  const res = await stub.fetch("https://ratelimit/presence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { nearby: 0, ttl: 0 };
  return res.json<NearbyResult>();
}

function nearbyNetworkScope(ip: string): string {
  const value = ip.trim().toLowerCase();
  const v4 = ipv4Scope(value);
  if (v4) return v4;
  const v6 = ipv6Scope(value);
  if (v6) return v6;
  return `unknown:${value}`;
}

function ipv4Scope(ip: string): string | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (!nums.every((n, i) => Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === parts[i])) return null;
  return `v4:${nums[0]}.${nums[1]}.${nums[2]}.0/24`;
}

function ipv6Scope(ip: string): string | null {
  if (!ip.includes(":") || ip.includes(".")) return null;
  const clean = ip.split("%", 1)[0]!;
  const split = clean.split("::");
  if (split.length > 2) return null;

  const left = split[0] ? split[0].split(":").filter(Boolean) : [];
  const right = split.length === 2 && split[1] ? split[1].split(":").filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (split.length === 1 && missing !== 0)) return null;

  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;

  const expanded = groups.map((g) => Number.parseInt(g, 16).toString(16).padStart(4, "0"));
  return `v6:${expanded.slice(0, 4).join(":")}::/64`;
}
