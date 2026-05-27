import {
  paletteOptions,
  levelAfter,
  isValidProgress,
  isValidSelection,
  isValidPos,
  TREE_DEPTH,
  POS_COUNT,
} from "./emoji-tree";
import { currentBucket, isUsableBucket, roomKeyForSelection } from "./pairing";
import { sealRoomKey, openRoomKeyToken } from "./room-key";
import type { FirstMove } from "./room-state";

export interface PairingDeps {
  pepper: string;
  isRoomActive: (roomKey: string) => Promise<boolean>;
}

function parseIds(raw: string | null): number[] | null {
  if (!raw) return [];
  const parts = raw.split(",").filter((s) => s.length > 0);
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > 1024) return null;
    out.push(n);
  }
  return out;
}

function parseFirst(raw: string | null): FirstMove | null | undefined {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot < 0) return undefined;
  const id = Number(raw.slice(0, dot));
  const pos = Number(raw.slice(dot + 1));
  if (!Number.isInteger(id) || id < 1 || id > 1024 || !isValidPos(pos)) return undefined;
  return { id, pos };
}

function parseBucket(raw: string | null): number | null | undefined {
  if (!raw) return null;
  const bucket = Number(raw);
  return Number.isInteger(bucket) ? bucket : undefined;
}

export async function handleTree(url: URL, deps: PairingDeps): Promise<Response> {
  if (!deps.pepper) return Response.json({ ok: false, reason: "server-misconfig" }, { status: 500 });

  const first = parseFirst(url.searchParams.get("m1"));
  const rest = parseIds(url.searchParams.get("path"));
  if (first === undefined || rest === null || rest.length > TREE_DEPTH - 1) {
    return Response.json({ ok: false, reason: "bad-path" }, { status: 400 });
  }

  const requestedBucket = parseBucket(url.searchParams.get("b"));
  if (requestedBucket === undefined) {
    return Response.json({ ok: false, reason: "bad-path" }, { status: 400 });
  }
  const bucket = requestedBucket ?? currentBucket();
  if (!isUsableBucket(bucket)) {
    return Response.json({ ok: false, reason: "expired-path" }, { status: 400 });
  }

  if (!(await isValidProgress(bucket, first, rest, deps.pepper))) {
    return Response.json({ ok: false, reason: "bad-path" }, { status: 400 });
  }

  if (first === null) {
    const options = await paletteOptions(bucket, deps.pepper);
    return Response.json({ ok: true, complete: false, stage: "move", level: 1, depth: TREE_DEPTH, positions: POS_COUNT, bucket, options });
  }

  if (rest.length >= TREE_DEPTH - 1) {
    return Response.json({ ok: true, complete: true, depth: TREE_DEPTH, bucket });
  }

  const options = await levelAfter(bucket, first, rest, deps.pepper);
  return Response.json({ ok: true, complete: false, stage: "click", level: rest.length + 2, depth: TREE_DEPTH, bucket, options });
}

export async function handlePairSession(req: Request, deps: PairingDeps): Promise<Response> {
  if (!deps.pepper) return Response.json({ ok: false, reason: "server-misconfig" }, { status: 500 });

  let first: FirstMove | null = null;
  let rest: number[] | null = null;
  let bucket: number | null = null;
  try {
    const body = (await req.json()) as { m1?: { id?: unknown; pos?: unknown }; path?: unknown; bucket?: unknown };
    if (body.m1 && typeof body.m1 === "object") first = { id: Number(body.m1.id), pos: Number(body.m1.pos) };
    if (Array.isArray(body.path)) rest = body.path.map((x) => Number(x));
    if (body.bucket !== undefined) bucket = Number(body.bucket);
  } catch {
    return Response.json({ ok: false, reason: "bad-request" }, { status: 400 });
  }

  bucket ??= currentBucket();
  if (!isUsableBucket(bucket)) {
    return Response.json({ ok: false, reason: "expired-path" }, { status: 400 });
  }
  if (!first || !rest || !(await isValidSelection(bucket, first, rest, deps.pepper))) {
    return Response.json({ ok: false, reason: "bad-path" }, { status: 400 });
  }

  const roomKey = await roomKeyForSelection(bucket, first, rest, deps.pepper);
  const available = !(await deps.isRoomActive(roomKey));
  const token = await sealRoomKey(roomKey, deps.pepper);
  return Response.json({ ok: true, available, token });
}

export function openRoomKey(token: string, pepper: string | undefined): Promise<string | null> {
  return openRoomKeyToken(token, pepper);
}
