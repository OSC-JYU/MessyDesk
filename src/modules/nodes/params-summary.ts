// A short, readable copy of the parameters a run was started with, kept on the process node so the
// desk can show them on the cruncher's card. It is built from the task's own values, never from the
// vault: API keys and `secret_ref` are left out, and so is anything that looks like a credential.

const MAX_VALUE_LENGTH = 120;
const MAX_PROMPT_LENGTH = 4000;
const SECRET_NAME = /secret|token|password|passwd|credential|api[_-]?key|auth/i;

export interface ParamsSummary {
    params: { name: string; label: string; value: string }[];
    prompt?: string;
}

function titleOf(help: any, value: unknown): string {
    const values = help?.values;
    if (Array.isArray(values)) {
        const hit = values.find((v: any) => v && String(v.value) === String(value));
        if (hit?.title) return String(hit.title);
    } else if (values && typeof values === 'object' && typeof value !== 'object') {
        const title = values[String(value)];
        if (typeof title === 'string') return title;
    }
    return String(value);
}

function displayValue(help: any, value: unknown): string {
    let text: string;
    if (typeof value === 'boolean') text = value ? 'Yes' : 'No';
    else if (Array.isArray(value)) text = value.map((v) => titleOf(help, v)).join(', ');
    else if (value && typeof value === 'object') text = JSON.stringify(value);
    else text = titleOf(help, value);
    return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text;
}

/** The parameters of a task as labelled rows, or null when there is nothing to show. */
export function summarizeParams(service: any, task: any): ParamsSummary | null {
    if (!task) return null;
    const helps = service?.tasks?.[task.id]?.params_help || {};
    const params: ParamsSummary['params'] = [];
    for (const [name, value] of Object.entries<any>(task.params || {})) {
        if (name === 'secret_ref' || SECRET_NAME.test(name)) continue;
        // A prompt run's params also carry the prompt's own system params (text, schema): not user choices.
        if (name === 'prompts' || (task.system_params && name in task.system_params)) continue;
        if (value === '' || value === null || value === undefined) continue;
        if (Array.isArray(value) && !value.length) continue;
        const help = helps[name];
        if (help?.display === 'hidden') continue;
        params.push({ name, label: String(help?.name || name), value: displayValue(help, value) });
    }
    const content = task.params?.prompts?.content ?? task.system_params?.prompts?.content;
    const prompt = typeof content === 'string' && content.trim() ? content.trim().slice(0, MAX_PROMPT_LENGTH) : undefined;
    if (!params.length && !prompt) return null;
    return prompt ? { params, prompt } : { params };
}

/** The node attribute value: the summary as JSON, or undefined when there is none. */
export function paramsSummaryJson(service: any, task: any): string | undefined {
    const summary = summarizeParams(service, task);
    return summary ? JSON.stringify(summary) : undefined;
}
