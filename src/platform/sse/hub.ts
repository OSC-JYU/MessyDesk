// Server-sent events. One user can have several open connections (several tabs); every event
// for that user goes to all of them. The wire format matches what the old backend produced with
// the `susie` plugin: unnamed events, "id: <ms timestamp>\r\ndata: <json>\r\n\r\n".

import { PassThrough } from 'node:stream';

export interface SseConnection {
    stream: PassThrough;
    userRid: string;
}

export class SseHub {
    private connections = new Map<string, Set<SseConnection>>();

    open(userRid: string): SseConnection {
        const stream = new PassThrough();
        const connection = { stream, userRid };
        let set = this.connections.get(userRid);
        if (!set) {
            set = new Set();
            this.connections.set(userRid, set);
        }
        set.add(connection);
        return connection;
    }

    close(connection: SseConnection): void {
        const set = this.connections.get(connection.userRid);
        if (!set) return;
        set.delete(connection);
        if (!set.size) this.connections.delete(connection.userRid);
        connection.stream.end();
    }

    write(connection: SseConnection, data: unknown): void {
        connection.stream.write(`id: ${Date.now()}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`);
    }

    /** Sends an event to every open connection of the user. Returns false when none is open. */
    send(userRid: string | null | undefined, data: unknown): boolean {
        if (!userRid) return false;
        const set = this.connections.get(String(userRid));
        if (!set || !set.size) return false;
        for (const connection of set) this.write(connection, data);
        return true;
    }

    connectedUsers(): string[] {
        return [...this.connections.keys()];
    }

    closeAll(): void {
        for (const set of this.connections.values()) for (const c of set) c.stream.end();
        this.connections.clear();
    }
}
