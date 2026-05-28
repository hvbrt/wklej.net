// Shared room state and WebSocket message contract.

export type Phase = "waiting-peer" | "connected";
export type Role = "seed" | "peer";
export type IceSignalMode = "direct" | "relay";

export interface FirstMove {
  id: number;
  pos: number;
}

export interface EmojiDTO {
  id: number;
  symbol: string;
  asset: string;
}

export type SessionTheme = [string, string, string];

export interface RoomState {
  sessionNonce: string;
  sessionTheme: SessionTheme;
  roomKey: string;
  createdAt: number;
  expiresAt: number;
  phase: Phase;
  seedSocketId: string;
  seedEndKey: string;
  peerSocketId?: string;
  peerEndKey?: string;
  connectedAt?: number;
  extensionUsed?: boolean;
}

export interface SocketMeta {
  role: Role;
  id: string;
  endKey: string;
}

export type WSMessage =
  | { type: "peer-joined" }
  | { type: "offer"; sdp: unknown; iceMode?: unknown }
  | { type: "answer"; sdp: unknown; iceMode?: unknown }
  | { type: "ice-candidate"; candidate: unknown }
  | { type: "session-expired" }
  | { type: "session-extended"; expiresAt: number }
  | { type: "session-extend-denied"; reason: string }
  | { type: "peer-overflow"; reason: string }
  | { type: "terminate" }
  | { type: "extend-session" }
  | { type: "role"; role: Role; endKey: string; theme: SessionTheme }
  | { type: "start-webrtc"; initiator: boolean; theme: SessionTheme }
  | { type: "error"; reason: string };

export const PAIRING_TTL_MS = 120_000;
export const CONNECTED_TTL_MS = 120_000;
