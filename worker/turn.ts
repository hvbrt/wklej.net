export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TurnEnv {
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

export type IceMode = "direct" | "relay";

const STUN_FALLBACK: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const TTL_SECONDS = 3600; // Covers pairing + the 2-minute connected window.

export async function mintIceServers(env: TurnEnv, mode: IceMode = "direct"): Promise<IceServer[]> {
  if (mode === "direct") return STUN_FALLBACK;

  const id = env.TURN_KEY_ID;
  const token = env.TURN_KEY_API_TOKEN;
  if (!id || !token) return [];

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      },
    );
    if (!res.ok) return [];

    const data = await res.json<{ iceServers?: IceServer[] }>();
    const servers = data.iceServers;
    if (!Array.isArray(servers) || servers.length === 0) return [];

    // Keep the fast UDP relay path, plus TLS/443 as the restrictive-network
    // fallback. Drop noisy TURN TCP variants that tend to stall mobile ICE.
    return servers.map(normalizeTurnServer).filter((s): s is IceServer => s !== null);
  } catch {
    return [];
  }
}

function normalizeTurnServer(server: IceServer): IceServer | null {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  const fallback = urls.filter(isTurnUrl).filter((u) => !u.includes(":53")).sort((a, b) => scoreTurnUrl(a) - scoreTurnUrl(b));
  // Relay mode keeps every sane TURN transport Cloudflare returns (except :53)
  // because restrictive mobile networks may need TCP 80/3478 when UDP and
  // TLS/443 are flaky.
  const chosen = fallback;
  if (!chosen.length) return null;
  const normalizedUrls: string | string[] = Array.isArray(server.urls) ? chosen : chosen[0]!;
  return { ...server, urls: normalizedUrls };
}

function isTurnUrl(url: string): boolean {
  return url.startsWith("turn:") || url.startsWith("turns:");
}

function scoreTurnUrl(url: string): number {
  if (url.startsWith("turn:") && url.includes(":3478") && url.includes("transport=udp")) return 0;
  if (url.startsWith("turns:") && url.includes(":443")) return 1;
  if (url.startsWith("turn:") && url.includes(":80") && url.includes("transport=tcp")) return 2;
  if (url.startsWith("turn:") && url.includes(":3478") && url.includes("transport=tcp")) return 3;
  if (url.startsWith("stun:")) return 100;
  return 50;
}
