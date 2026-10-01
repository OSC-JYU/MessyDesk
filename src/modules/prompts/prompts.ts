// Prompts for the LLM services: the user's own and the public ones. LLM services offer each
// prompt as a task (services/matching.ts).

import Boom from '@hapi/boom';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { tryRid, uuidv7 } from '../../platform/ids.ts';

/** Accepts a JSON object schema, also one with unquoted keys/values; returns it compact. */
export function normalizeJsonSchema(raw: unknown): string {
    if (!raw) return '';
    const text = String(raw);
    const check = (parsed: unknown): string => {
        if (Array.isArray(parsed)) throw new Error('JSON schema must be an object, not an array. Arrays are allowed as values within the object.');
        return JSON.stringify(parsed);
    };
    try {
        return check(JSON.parse(text));
    } catch (error) {
        try {
            let fixed = text.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
            fixed = fixed.replace(/:\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*([,}\]])/g, (match, value, ending) => (/^(true|false|null|\d+\.?\d*|\{|\[)/.test(value) ? match : `: "${value}"${ending}`));
            return check(JSON.parse(fixed));
        } catch (fixError) {
            throw new Error('Invalid JSON schema: ' + (error as Error).message + '. Attempted fix also failed: ' + (fixError as Error).message);
        }
    }
}

export class PromptsService {
    private readonly db: ArcadeClient;

    constructor(db: ArcadeClient) {
        this.db = db;
    }

    list(userRid: string): Promise<any[]> {
        return this.db.rows('SELECT FROM Prompt WHERE owner = "public" OR owner = :owner ORDER BY label', { owner: userRid });
    }

    /**
     * Creates a prompt, or updates one of the user's own prompts when `@rid` is given. Text is
     * stored as typed (the old backend replaced quotes and newlines; plan/decisions.md C5).
     */
    async save(prompt: any, userRid: string): Promise<any[]> {
        let schema: string;
        try {
            schema = normalizeJsonSchema(prompt?.json_schema);
        } catch (error) {
            throw Boom.badData((error as Error).message);
        }
        const outputType = prompt?.output_type === 'json' ? 'json' : 'text';
        const fields = {
            name: String(prompt?.name ?? ''),
            content: String(prompt?.content ?? ''),
            description: String(prompt?.description ?? ''),
            json_schema: schema,
            output_type: outputType,
        };
        const rid = tryRid(prompt?.['@rid']);
        if (rid) {
            const own = await this.db.first('SELECT @rid FROM Prompt WHERE @rid = :rid AND owner = :owner', { rid, owner: userRid });
            if (!own) throw Boom.notFound('Prompt not found');
            return (await this.db.sql(`UPDATE ${rid} SET name = :name, content = :content, description = :description, json_schema = :json_schema, output_type = :output_type`, fields)).result;
        }
        return (await this.db.sql('CREATE VERTEX Prompt CONTENT :content', { content: { uuid: uuidv7(), ...fields, type: prompt?.type, owner: userRid } })).result;
    }
}
