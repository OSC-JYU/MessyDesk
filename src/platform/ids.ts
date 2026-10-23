// Record ids (ArcadeDB "#cluster:position") and UUIDv7 generation.

import { randomBytes } from 'node:crypto';

export type Rid = `#${number}:${number}`;

const RID_PATTERN = /^#?(\d+):(\d+)$/;

export class InvalidRidError extends Error {}

/** Normalises "12:3" or "#12:3" to "#12:3"; throws InvalidRidError for anything else. */
export function toRid(value: unknown): Rid {
    if (typeof value !== 'string') throw new InvalidRidError('RID must be a string');
    const match = value.trim().match(RID_PATTERN);
    if (!match) throw new InvalidRidError('Invalid RID format');
    return `#${match[1]}:${match[2]}` as Rid;
}

/** Like toRid but returns null instead of throwing. */
export function tryRid(value: unknown): Rid | null {
    try {
        return value === null || value === undefined || value === '' ? null : toRid(value);
    } catch {
        return null;
    }
}

export function isRid(value: unknown): value is Rid {
    return typeof value === 'string' && /^#\d+:\d+$/.test(value);
}

/** "#12:3" -> "12_3", the form used in file names. */
export function ridToPathPart(rid: string): string {
    return rid.replace('#', '').replace(':', '_');
}

export function stripHash(rid: string): string {
    return String(rid).replace('#', '');
}

/** UUIDv7: the first 6 bytes hold the millisecond timestamp, so ids sort by creation time. */
export function uuidv7(): string {
    const bytes = randomBytes(16);
    const ts = Date.now();
    bytes[0] = (ts / 0x10000000000) & 0xff;
    bytes[1] = (ts / 0x100000000) & 0xff;
    bytes[2] = (ts / 0x1000000) & 0xff;
    bytes[3] = (ts / 0x10000) & 0xff;
    bytes[4] = (ts / 0x100) & 0xff;
    bytes[5] = ts & 0xff;
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuid(value: unknown): boolean {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
