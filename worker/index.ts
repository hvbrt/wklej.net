// Worker entry point. Routes:
//   GET  /api/ice                  -> ICE servers (TURN if configured, STUN otherwise)
//   GET  /api/tree                 -> rotating emoji tree options
//   POST /api/nearby { id,present } -> short-lived anonymous same-network hint
//   POST /api/session { m1, path } -> room availability + opaque room token
//   POST /api/name-session { name,intent } -> custom-name room token
//   POST /api/end { token,endKey } -> participant-authenticated teardown
//   GET  /ws?token=...&role=...   -> WebSocket signaling upgrade
//   *                              -> static assets from ./public
//
// The Worker is signaling-only. Text and files travel over WebRTC DataChannel.
// Room keys stay server-side and enter the Durable Object only via X-Room-Key.

import { allowCreate, allowJoin, allowNamedSession, updateNearbyPresence, type NearbyRequest } from "./rate-limit";
import { DurableRoom } from "./durable-room";
import { RateLimit } from "./rate-limit-do";
import { handleNamedSession, handlePairSession, handleTree, openRoomKey, type PairingDeps } from "./pairing-session";
import { mintIceServers, type IceMode, type TurnEnv } from "./turn";

export { DurableRoom, RateLimit };

interface Env extends TurnEnv {
  ROOM: DurableObjectNamespace;
  RATELIMIT: DurableObjectNamespace;
  ASSETS: Fetcher;
  ROOM_PEPPER: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const ip = req.headers.get("CF-Connecting-IP") ?? "anon";

    if (url.protocol === "http:" && req.headers.has("CF-Ray")) {
      url.protocol = "https:";
      return redirect(req, url.toString(), 308);
    }

    if (url.pathname === "/api/ice") {
      const requestedMode = parseIceMode(url.searchParams.get("mode"));
      const iceServers = await mintIceServers(env, requestedMode);
      const hasTurn = hasTurnServer(iceServers);
      return json(req, { iceServers, hasTurn, mode: hasTurn ? requestedMode : "direct" });
    }

    if (url.pathname === "/api/tree" && req.method === "GET") {
      return withSecurityHeaders(req, await handleTree(url, pairingDeps(env)));
    }

    if (url.pathname === "/api/nearby" && req.method === "POST") {
      return handleNearby(req, env, ip);
    }

    if (url.pathname === "/api/session" && req.method === "POST") {
      return handleSession(req, env, ip);
    }

    if (url.pathname === "/api/name-session" && req.method === "POST") {
      return handleNameSession(req, env, ip);
    }

    if (url.pathname === "/api/end" && req.method === "POST") {
      return handleEnd(req, env);
    }

    if (url.pathname === "/ws") {
      return handleWs(req, url, env, ip);
    }

    return withSecurityHeaders(req, await env.ASSETS.fetch(req));
  },
};

function pairingDeps(env: Env): PairingDeps {
  return {
    pepper: env.ROOM_PEPPER,
    isRoomActive: async (roomKey: string) => {
      const stub = env.ROOM.get(env.ROOM.idFromName(roomKey));
      const res = await stub.fetch("https://room/api/check");
      const d = await res.json<{ active?: unknown }>();
      return d.active === true;
    },
  };
}

async function handleSession(req: Request, env: Env, ip: string): Promise<Response> {
  if (!(await allowJoin(env.RATELIMIT, ip))) {
    return json(req, { ok: false, reason: "rate-limited" }, { status: 429 });
  }
  return withSecurityHeaders(req, await handlePairSession(req, pairingDeps(env)));
}

async function handleNameSession(req: Request, env: Env, ip: string): Promise<Response> {
  if (!(await allowNamedSession(env.RATELIMIT, ip))) {
    return json(req, { ok: false, reason: "rate-limited" }, { status: 429 });
  }
  return withSecurityHeaders(req, await handleNamedSession(req, pairingDeps(env)));
}

async function handleNearby(req: Request, env: Env, ip: string): Promise<Response> {
  const body = await readNearbyRequest(req);
  if (!body.id) return json(req, { nearby: 0, ttl: 0 }, { status: 400 });
  const result = await updateNearbyPresence(env.RATELIMIT, ip, body);
  return json(req, { ...result, privacy: privacyHint(req) });
}

async function readNearbyRequest(req: Request): Promise<NearbyRequest> {
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
      selection: isNearbySelection(body.selection),
      mode: body.mode === "send" ? "send" : "pair",
    };
  } catch {
    return { id: "", present: false };
  }
}

function isNearbySelection(value: unknown): NearbyRequest["selection"] {
  if (!value || typeof value !== "object") return undefined;
  const v = value as NearbyRequest["selection"];
  if (
    !v ||
    !Number.isInteger(v.bucket) ||
    !v.first ||
    !Number.isInteger(v.first.id) ||
    !Number.isInteger(v.first.pos) ||
    !Array.isArray(v.rest) ||
    !Array.isArray(v.glyphs)
  ) {
    return undefined;
  }
  return {
    bucket: v.bucket,
    first: { id: v.first.id, pos: v.first.pos },
    rest: v.rest.map((id) => Number(id)),
    glyphs: v.glyphs.map((glyph) => String(glyph)),
    assets:
      Array.isArray(v.assets) &&
      v.assets.length === 3 &&
      v.assets.every((asset) => typeof asset === "string" && /^\/emoji\/[0-9a-f_]+\.webp$/.test(asset))
        ? v.assets.map((asset) => String(asset))
        : undefined,
  };
}

function privacyHint(req: Request): { privateRelayLikely: boolean; asOrganization: string } {
  const cf = (req as Request & { cf?: { asOrganization?: unknown } }).cf;
  const asOrganization = typeof cf?.asOrganization === "string" ? cf.asOrganization : "";
  const privateRelayLikely = /icloud|private relay|apple|warp|vpn/i.test(asOrganization);
  return { privateRelayLikely, asOrganization: privateRelayLikely ? asOrganization : "" };
}

async function handleEnd(req: Request, env: Env): Promise<Response> {
  const { token, endKey } = await readEndRequest(req);
  if (!token || !endKey) return text(req, "bad request", { status: 400 });

  const roomKey = await openRoomKey(token, env.ROOM_PEPPER);
  if (!roomKey) return text(req, "invalid token", { status: 400 });

  const stub = env.ROOM.get(env.ROOM.idFromName(roomKey));
  const headers = new Headers();
  headers.set("X-Room-Key", roomKey);
  headers.set("X-End-Key", endKey);
  const res = await stub.fetch("https://room/api/end", { method: "POST", headers });
  return new Response(null, withSecurityHeadersInit(req, { status: res.status === 403 ? 403 : 204 }));
}

async function readEndRequest(req: Request): Promise<{ token: string; endKey: string }> {
  const text = await req.text();
  if (!text) return { token: "", endKey: "" };
  try {
    const body = JSON.parse(text) as { token?: unknown; endKey?: unknown };
    return {
      token: typeof body.token === "string" ? body.token : "",
      endKey: typeof body.endKey === "string" ? body.endKey : "",
    };
  } catch {
    const params = new URLSearchParams(text);
    return {
      token: params.get("token") ?? "",
      endKey: params.get("endKey") ?? "",
    };
  }
}

async function handleWs(req: Request, url: URL, env: Env, ip: string): Promise<Response> {
  const role = url.searchParams.get("role");
  const token = url.searchParams.get("token") ?? "";
  if (role !== "seed" && role !== "peer") return text(req, "bad role", { status: 400 });

  const roomKey = await openRoomKey(token, env.ROOM_PEPPER);
  if (!roomKey) return text(req, "invalid token", { status: 400 });

  const ok = role === "seed" ? await allowCreate(env.RATELIMIT, ip) : await allowJoin(env.RATELIMIT, ip);
  if (!ok) return text(req, "rate limited", { status: 429 });

  const stub = env.ROOM.get(env.ROOM.idFromName(roomKey));
  const fwd = new URL("https://room/ws");
  fwd.searchParams.set("role", role);
  const resume = url.searchParams.get("resume");
  if (resume) fwd.searchParams.set("resume", resume);
  const fwdReq = new Request(fwd.toString(), req);
  fwdReq.headers.set("X-Room-Key", roomKey);
  return stub.fetch(fwdReq);
}

function json(req: Request, data: unknown, init?: ResponseInit): Response {
  return withSecurityHeaders(req, Response.json(data, init));
}

function text(req: Request, body: string, init?: ResponseInit): Response {
  return withSecurityHeaders(req, new Response(body, init));
}

function redirect(req: Request, location: string, status: 301 | 302 | 307 | 308): Response {
  const headers = new Headers({ Location: location });
  return new Response(null, withSecurityHeadersInit(req, { status, headers }));
}

function hasTurnServer(iceServers: Array<{ urls: string | string[] }>): boolean {
  return iceServers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((u) => u.startsWith("turn:") || u.startsWith("turns:"));
  });
}

function parseIceMode(value: string | null): IceMode {
  return value === "turn" || value === "relay" ? value : "direct";
}

function withSecurityHeaders(req: Request, res: Response): Response {
  const init = withSecurityHeadersInit(req, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
  return new Response(res.body, init);
}

function withSecurityHeadersInit(req: Request, init: ResponseInit): ResponseInit {
  const url = new URL(req.url);
  const headers = new Headers(init.headers);

  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-DNS-Prefetch-Control", "off");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Permitted-Cross-Domain-Policies", "none");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Origin-Agent-Cluster", "?1");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), accelerometer=(), gyroscope=()",
  );
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "font-src 'self'",
      "img-src 'self' data: blob:",
      "connect-src 'self' wss: https://rtc.live.cloudflare.com stun: turn: turns:",
      "media-src 'none'",
      "object-src 'none'",
      "worker-src 'none'",
    ].join("; "),
  );

  if (url.protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  if (url.pathname.startsWith("/api/")) {
    headers.set("Cache-Control", "no-store");
  } else if (
    (init.status ?? 200) >= 200 &&
    (init.status ?? 200) < 300 &&
    (/^\/[0-9a-f]{10}\.(?:js|css|webp)$/.test(url.pathname) || /^\/emoji\/[0-9a-f_]+\.webp$/.test(url.pathname))
  ) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else if (url.pathname === "/" || url.pathname === "/index.html") {
    headers.set("Cache-Control", "no-cache");
  }

  return {
    status: init.status,
    statusText: init.statusText,
    headers,
  };
}
