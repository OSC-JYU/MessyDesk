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

export const DEFAULT_SETTINGS = Object.freeze({ theme: 'light', cookie: 'classic', motion: 'on' });

const ALLOWED = { theme: THEMES, cookie: COOKIE_COLOURS, motion: MOTION };

// Stored settings with defaults filled in; unknown or stale values are dropped.
export function withDefaults(stored) {
    const settings = { ...DEFAULT_SETTINGS };
    if (stored && typeof stored === 'object') {
        for (const [key, values] of Object.entries(ALLOWED)) {
            if (values.includes(stored[key])) settings[key] = stored[key];
        }
    }
    return settings;
}

// Checks a partial update. Returns the clean patch, or throws an Error whose
// message says what is wrong.
export function validatePatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('Settings must be an object');
    }
    const clean = {};
    for (const [key, value] of Object.entries(patch)) {
        if (!ALLOWED[key]) throw new Error(`Unknown setting: ${key}`);
        if (!ALLOWED[key].includes(value)) {
            throw new Error(`${key} must be one of: ${ALLOWED[key].join(', ')}`);
        }
        clean[key] = value;
    }
    return clean;
}
