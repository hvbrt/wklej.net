// Selection -> concealed room key, scoped to a rotating creation bucket.
// Bucket rotation affects only new pairing trees and new room keys. Once a
// Durable Object room exists, its lifecycle is controlled by RoomState.expiresAt.

import { sha256Hex } from "./hash";
import type { FirstMove } from "./room-state";

export const WINDOW_MS = 60_000;

export function currentBucket(now: number = Date.now()): number {
  return Math.floor(now / WINDOW_MS);
}

export function isUsableBucket(bucket: number, now: number = Date.now()): boolean {
  const current = currentBucket(now);
  return Number.isInteger(bucket) && bucket <= current && bucket >= current - 1;
}

export function roomKeyForSelection(bucket: number, first: FirstMove, rest: number[], pepper: string): Promise<string> {
  return sha256Hex(`path:v4:${pepper}:${bucket}:${first.id}@${first.pos}:${rest.join(",")}`);
}

export function roomKeyForName(bucket: number, name: string, pepper: string): Promise<string> {
  return sha256Hex(`name:v1:${pepper}:${bucket}:${name}`);
}
