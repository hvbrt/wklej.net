// Shared room state and WebSocket message contract.

export type Phase = "waiting-peer" | "connected";
export type Role = "seed" | "peer";

export interface FirstMove {
  id: number;
  pos: number;
}

export interface EmojiDTO {
  id: number;
  symbol: string;
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
}

export interface SocketMeta {
  role: Role;
  id: string;
  endKey: string;
}

export type WSMessage =
  | { type: "peer-joined" }
  | { type: "offer"; sdp: unknown }
  | { type: "answer"; sdp: unknown }
  | { type: "ice-candidate"; candidate: unknown }
  | { type: "session-expired" }
  | { type: "terminate" }
  | { type: "role"; role: Role; endKey: string; theme: SessionTheme }
  | { type: "start-webrtc"; initiator: boolean; theme: SessionTheme }
  | { type: "error"; reason: string };

export const PAIRING_TTL_MS = 120_000;
export const CONNECTED_TTL_MS = 120_000;
