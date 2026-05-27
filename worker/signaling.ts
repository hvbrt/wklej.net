// Signaling helpers. The Worker/DO relays ONLY these message types between the
// two peers. It NEVER relays application payload — payload travels P2P over
// the RTCDataChannel exclusively.

import type { WSMessage } from "./room-state";

const RELAY_TYPES = new Set(["offer", "answer", "ice-candidate"]);
const MAX_SDP_CHARS = 64_000;
const MAX_CANDIDATE_CHARS = 4_096;

export function isRelayMessage(msg: WSMessage): boolean {
  return RELAY_TYPES.has(msg.type);
}

export function sanitizeRelay(msg: WSMessage): WSMessage | null {
  switch (msg.type) {
    case "offer": {
      const sdp = sanitizeSdp(msg.sdp, "offer");
      return sdp ? { type: "offer", sdp } : null;
    }
    case "answer": {
      const sdp = sanitizeSdp(msg.sdp, "answer");
      return sdp ? { type: "answer", sdp } : null;
    }
    case "ice-candidate": {
      const candidate = sanitizeCandidate(msg.candidate);
      return candidate ? { type: "ice-candidate", candidate } : null;
    }
    default:
      return null;
  }
}

function sanitizeSdp(value: unknown, expectedType: "offer" | "answer"): { type: string; sdp: string } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { type?: unknown; sdp?: unknown };
  if (v.type !== expectedType || typeof v.sdp !== "string") return null;
  if (v.sdp.length === 0 || v.sdp.length > MAX_SDP_CHARS) return null;
  return { type: expectedType, sdp: v.sdp };
}

function sanitizeCandidate(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const v = value as {
    candidate?: unknown;
    sdpMid?: unknown;
    sdpMLineIndex?: unknown;
    usernameFragment?: unknown;
  };
  if (typeof v.candidate !== "string" || v.candidate.length > MAX_CANDIDATE_CHARS) return null;

  const out: Record<string, unknown> = { candidate: v.candidate };
  if (typeof v.sdpMid === "string" && v.sdpMid.length <= 128) out.sdpMid = v.sdpMid;
  if (typeof v.sdpMLineIndex === "number" && Number.isInteger(v.sdpMLineIndex)) {
    out.sdpMLineIndex = v.sdpMLineIndex;
  }
  if (typeof v.usernameFragment === "string" && v.usernameFragment.length <= 256) {
    out.usernameFragment = v.usernameFragment;
  }
  return out;
}
