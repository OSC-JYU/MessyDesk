// Per-user UI preferences, saved on the User vertex as `settings` and edited
// on the Settings page of the UI. Only known keys and values are accepted.

// light/dark are Fjord and system follows the OS between them; the others
// are the Navy, Slate, Reading room (warm) and MessyDesk classic themes of the UI.
export const THEMES = [
    'light', 'dark', 'system', 'navy', 'navy-dark', 'slate', 'warm', 'warm-dark', 'classic',
];
export const COOKIE_COLOURS = ['classic', 'chocolate', 'matcha', 'strawberry', 'blueberry'];
// 'off' stops the UI's playful animations.
export const MOTION = ['on', 'off'];
// 'on': the set browser shows one card per original PDF instead of all its pages in a row.
export const GROUP_PDF = ['on', 'off'];
// 'on': a file picked in the lineage of the file viewer opens next to the file instead of replacing it.
export const LINEAGE_COMPARE = ['on', 'off'];

// 'on': the "Learn MessyDesk" card with the demo desks is hidden on the front page.
export const HIDE_DEMOS = ['on', 'off'];
// How the front page shows the desks.
export const DESK_VIEWS = ['grid', 'list'];

export const DEFAULT_SETTINGS = Object.freeze({ theme: 'light', cookie: 'classic', motion: 'on', group_pdf: 'on', lineage_compare: 'on', hide_demos: 'off', desk_view: 'grid' });

const ALLOWED: Record<string, string[]> = { theme: THEMES, cookie: COOKIE_COLOURS, motion: MOTION, group_pdf: GROUP_PDF, lineage_compare: LINEAGE_COMPARE, hide_demos: HIDE_DEMOS, desk_view: DESK_VIEWS };

// Stored settings with defaults filled in; unknown or stale values are dropped.
export function withDefaults(stored: unknown): Record<string, string> {
    const settings: Record<string, string> = { ...DEFAULT_SETTINGS };
    if (stored && typeof stored === 'object') {
        for (const [key, values] of Object.entries(ALLOWED)) {
            const value = (stored as Record<string, string>)[key];
            if (values.includes(value)) settings[key] = value;
        }
    }
    return settings;
}

// Checks a partial update. Returns the clean patch, or throws an Error whose
// message says what is wrong.
export function validatePatch(patch: unknown): Record<string, string> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('Settings must be an object');
    }
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(patch as Record<string, string>)) {
        if (!ALLOWED[key]) throw new Error(`Unknown setting: ${key}`);
        if (!ALLOWED[key].includes(value)) {
            throw new Error(`${key} must be one of: ${ALLOWED[key].join(', ')}`);
        }
        clean[key] = value;
    }
    return clean;
}
