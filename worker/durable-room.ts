// DurableRoom: one single-use signaling room per concealed room key.
// The DO relays WebRTC signaling only; application payload never touches Worker.

import {
  CONNECTED_TTL_MS,
  PAIRING_TTL_MS,
  type RoomState,
  type Role,
  type SessionTheme,
  type SocketMeta,
  type WSMessage,
} from "./room-state";
import { isRelayMessage, sanitizeRelay } from "./signaling";

const STATE_KEY = "state";
const MAX_WS_MESSAGE_CHARS = 64_000;
const EXTENSION_WINDOW_MS = 10_000;

type UpgradeDecision =
  | { ok: true; role: Role; socketId: string; endKey: string; state: RoomState; reconnect?: boolean }
  | { ok: false; reason: string; destroyFirst?: boolean; terminateFirst?: boolean; state?: RoomState };

export class DurableRoom implements DurableObject {
  constructor(private ctx: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/check") {
      const st = await this.getState();
      const active = !!st && st.expiresAt > Date.now();
      return Response.json({ active, phase: active ? st!.phase : null });
    }

    if (url.pathname === "/api/end" && req.method === "POST") {
      const roomKey = req.headers.get("X-Room-Key") ?? "";
      const endKey = req.headers.get("X-End-Key") ?? "";
      const st = await this.getState();
      if (!st || st.roomKey !== roomKey) return new Response(null, { status: 204 });
      if (!this.canEnd(st, endKey)) return new Response("forbidden", { status: 403 });
      await this.terminate(st);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/ws") {
      const role = url.searchParams.get("role") as Role | null;
      const roomKey = req.headers.get("X-Room-Key") ?? "";
      if (role !== "seed" && role !== "peer") return new Response("bad role", { status: 400 });
      if (!roomKey) return new Response("missing room key", { status: 400 });
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      return this.handleUpgrade(role, roomKey, url.searchParams.get("resume") ?? "");
    }

    return new Response("not found", { status: 404 });
  }

  private async handleUpgrade(role: Role, roomKey: string, resumeKey: string): Promise<Response> {
    const decision = await this.reserveSocket(role, roomKey, resumeKey);
    if (!decision.ok) {
      if (decision.terminateFirst) {
        this.broadcast({ type: "peer-overflow", reason: decision.reason }, decision.state);
        await this.terminate(decision.state);
      }
      else if (decision.destroyFirst) await this.destroy();
      return this.reject(1008, decision.reason);
    }
    return this.accept(decision.role, decision.socketId, decision.endKey, decision.state, decision.reconnect === true);
  }

  private async reserveSocket(role: Role, roomKey: string, resumeKey: string): Promise<UpgradeDecision> {
    return this.ctx.storage.transaction(async (txn) => {
      const st = await txn.get<RoomState>(STATE_KEY);
      const now = Date.now();
      const active = !!st && st.expiresAt > now;

      if (role === "seed") {
        if (active && st && this.canResume(st, role, resumeKey)) {
          const next: RoomState = { ...st, seedSocketId: crypto.randomUUID() };
          await txn.put(STATE_KEY, next);
          return { ok: true, role, socketId: next.seedSocketId, endKey: next.seedEndKey, state: next, reconnect: true };
        }
        if (active) return { ok: false, reason: "room-active" };

        const next: RoomState = {
          sessionNonce: crypto.randomUUID(),
          sessionTheme: createSessionTheme(),
          roomKey,
          createdAt: now,
          expiresAt: now + PAIRING_TTL_MS,
          phase: "waiting-peer",
          seedSocketId: crypto.randomUUID(),
          seedEndKey: crypto.randomUUID(),
          extensionUsed: false,
        };
        await txn.put(STATE_KEY, next);
        await txn.setAlarm(next.expiresAt);
        return { ok: true, role, socketId: next.seedSocketId, endKey: next.seedEndKey, state: next };
      }

      if (!active || !st) return { ok: false, reason: "no-active-room" };
      const peerEndKey = st.peerEndKey;
      if (this.canResume(st, role, resumeKey) && peerEndKey) {
        const next: RoomState = { ...st, peerSocketId: crypto.randomUUID() };
        await txn.put(STATE_KEY, next);
        return { ok: true, role, socketId: next.peerSocketId!, endKey: peerEndKey, state: next, reconnect: true };
      }
      if (st.phase === "connected") {
        return { ok: false, reason: "peer-overflow", terminateFirst: true, state: st };
      }
      if (!st.seedSocketId || !this.socket("seed", st.seedSocketId)) {
        return { ok: false, reason: "no-active-room", destroyFirst: true };
      }
      if (st.peerSocketId || this.socket("peer")) {
        return { ok: false, reason: "peer-overflow", terminateFirst: true, state: st };
      }

      const next: RoomState = {
        ...st,
        sessionTheme: st.sessionTheme ?? createSessionTheme(),
        phase: "connected",
        peerSocketId: crypto.randomUUID(),
        peerEndKey: crypto.randomUUID(),
        connectedAt: now,
        expiresAt: now + CONNECTED_TTL_MS,
        extensionUsed: false,
      };
      await txn.put(STATE_KEY, next);
      await txn.setAlarm(next.expiresAt);
      return { ok: true, role, socketId: next.peerSocketId!, endKey: next.peerEndKey!, state: next };
    });
  }

  private accept(role: Role, socketId: string, endKey: string, st: RoomState, reconnect: boolean): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const meta: SocketMeta = { role, id: socketId, endKey };

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment(meta);
    server.send(JSON.stringify({ type: "role", role, endKey, theme: st.sessionTheme } satisfies WSMessage));

    if (role === "peer" && !reconnect) {
      this.send("seed", { type: "peer-joined" }, st.seedSocketId);
      this.send("seed", { type: "start-webrtc", initiator: true, theme: st.sessionTheme }, st.seedSocketId);
      server.send(JSON.stringify({ type: "start-webrtc", initiator: false, theme: st.sessionTheme } satisfies WSMessage));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private reject(code: number, reason: string): Response {
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].send(JSON.stringify({ type: "error", reason } satisfies WSMessage));
    pair[1].close(code, reason);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    if (raw.length > MAX_WS_MESSAGE_CHARS) {
      ws.close(1008, "message-too-large");
      return;
    }

    let msg: WSMessage;
    try {
      msg = JSON.parse(raw) as WSMessage;
    } catch {
      return;
    }

    const meta = ws.deserializeAttachment() as SocketMeta | null;
    const role = meta?.role;
    if (!role || !meta?.id) return;

    const st = await this.getState();
    if (!st) return;
    if (!this.isCurrentSocket(st, role, meta.id)) {
      ws.close(1008, "stale-socket");
      return;
    }

    if (isRelayMessage(msg)) {
      if (st.phase !== "connected") return;
      const clean = sanitizeRelay(msg);
      if (clean) this.send(other(role), clean, role === "seed" ? st.peerSocketId : st.seedSocketId);
      return;
    }

    if (msg.type === "extend-session") {
      await this.extendConnectedSession(st, role, meta.id);
      return;
    }

    if (msg.type === "terminate") {
      await this.terminate(st);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    const st = await this.getState();
    if (!meta?.role || !meta.id || !st || !this.isCurrentSocket(st, meta.role, meta.id)) return;
    if (st.phase === "connected") return;
    await this.terminate(st, meta.id);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    const st = await this.getState();
    if (st && meta?.role && meta.id && this.isCurrentSocket(st, meta.role, meta.id)) {
      if (st.phase === "connected") return;
      await this.terminate(st, meta.id);
      return;
    }
    await this.destroy();
  }

  async alarm(): Promise<void> {
    await this.terminate(await this.getState());
  }

  private socket(role: Role, id?: string): WebSocket | undefined {
    const sockets = this.ctx.getWebSockets(role);
    if (!id) return sockets[0];
    return sockets.find((ws) => {
      const meta = ws.deserializeAttachment() as SocketMeta | null;
      return meta?.id === id;
    });
  }

  private send(role: Role, msg: WSMessage, id?: string): void {
    if (id === undefined) return;
    const ws = this.socket(role, id);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: WSMessage, st?: RoomState, exceptSocketId?: string): void {
    if (!st) {
      const data = JSON.stringify(msg);
      for (const ws of this.ctx.getWebSockets()) {
        const meta = ws.deserializeAttachment() as SocketMeta | null;
        if (meta?.id !== exceptSocketId && ws.readyState === WebSocket.OPEN) ws.send(data);
      }
      return;
    }
    if (st.seedSocketId !== exceptSocketId) this.send("seed", msg, st.seedSocketId);
    if (st.peerSocketId !== exceptSocketId) this.send("peer", msg, st.peerSocketId);
  }

  private async getState(): Promise<RoomState | undefined> {
    return this.ctx.storage.get<RoomState>(STATE_KEY);
  }

  private isCurrentSocket(st: RoomState, role: Role, id: string): boolean {
    return role === "seed" ? st.seedSocketId === id : st.peerSocketId === id;
  }

  private canEnd(st: RoomState, endKey: string): boolean {
    return safeEqual(endKey, st.seedEndKey) || safeEqual(endKey, st.peerEndKey);
  }

  private canResume(st: RoomState, role: Role, endKey: string): boolean {
    if (role === "seed") return safeEqual(endKey, st.seedEndKey);
    return safeEqual(endKey, st.peerEndKey);
  }

  private async extendConnectedSession(st: RoomState, role: Role, socketId: string): Promise<void> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<RoomState>(STATE_KEY);
      if (!current || current.sessionNonce !== st.sessionNonce) return { ok: false as const, reason: "no-session" };
      if (current.phase !== "connected") return { ok: false as const, reason: "not-connected" };
      if (!this.isCurrentSocket(current, role, socketId)) return { ok: false as const, reason: "stale-socket" };
      if (current.extensionUsed) return { ok: false as const, reason: "extension-used" };

      const now = Date.now();
      if (current.expiresAt - now > EXTENSION_WINDOW_MS) return { ok: false as const, reason: "too-early" };
      const expiresAt = now + CONNECTED_TTL_MS;
      const next: RoomState = { ...current, extensionUsed: true, expiresAt };
      await txn.put(STATE_KEY, next);
      await txn.setAlarm(expiresAt);
      return { ok: true as const, state: next };
    });

    if (result.ok) {
      this.broadcast({ type: "session-extended", expiresAt: result.state.expiresAt }, result.state);
    } else {
      this.send(role, { type: "session-extend-denied", reason: result.reason }, socketId);
    }
  }

  private async terminate(st?: RoomState, exceptSocketId?: string): Promise<void> {
    this.broadcast({ type: "session-expired" }, st, exceptSocketId);
    await this.destroy();
  }

  private async destroy(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "session-end");
      } catch {
        // already closed
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

function other(role: Role): Role {
  return role === "seed" ? "peer" : "seed";
}

function safeEqual(a: string, b?: string): boolean {
  if (!b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function createSessionTheme(): SessionTheme {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const base = Math.floor((bytes[0]! / 256) * 360);
  const spreadA = 92 + (bytes[1]! % 46);
  const spreadB = 178 + (bytes[2]! % 58);
  return [
    hsl(base, 76 + (bytes[3]! % 11), 42 + (bytes[4]! % 10)),
    hsl((base + spreadA) % 360, 78 + (bytes[5]! % 12), 47 + (bytes[6]! % 10)),
    hsl((base + spreadB) % 360, 80 + (bytes[7]! % 10), 54 + (bytes[8]! % 8)),
  ];
}

function hsl(h: number, s: number, l: number): string {
  return `${h} ${s}% ${l}%`;
}
