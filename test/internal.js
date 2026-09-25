import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import axios from 'axios';
import FormData from 'form-data';

const DEFAULT_API = 'http://localhost:8200';
const DEFAULT_MAIL = 'local.user@localhost';
const DEFAULT_PROJECT = 'dev_test';

function parseArgs(argv) {
    const args = {
        api: DEFAULT_API,
        mail: DEFAULT_MAIL,
        project: DEFAULT_PROJECT,
        file: '',
        description: '',
        allowDuplicate: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        const next = argv[i + 1];

        if (key === '--api' && next) {
            args.api = next;
            i++;
            continue;
        }
        if (key === '--mail' && next) {
            args.mail = next;
            i++;
            continue;
        }
        if (key === '--project' && next) {
            args.project = next;
            i++;
            continue;
        }
        if (key === '--file' && next) {
            args.file = next;
            i++;
            continue;
        }
        if (key === '--description' && next) {
            args.description = next;
            i++;
            continue;
        }
        if (key === '--allow-duplicate') {
            args.allowDuplicate = true;
            continue;
        }
    }

    return args;
}

async function apiJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }

    if (!response.ok) {
        throw new Error(`Request failed ${response.status} ${response.statusText}: ${JSON.stringify(body)}`);
    }

    return body;
}

function normalizeProjectLabel(project) {
    if (!project || typeof project !== 'object') return '';
    if (Array.isArray(project.label)) return String(project.label[0] || '');
    if (Array.isArray(project.name)) return String(project.name[0] || '');
    return String(project.label || project.name || '');
}

function normalizeProjectRid(project) {
    if (!project || typeof project !== 'object') return '';
    if (Array.isArray(project['@rid'])) return String(project['@rid'][0] || '');
    return String(project['@rid'] || '');
}

async function findProjectByLabel(apiBase, mail, label) {
    const projects = await apiJson(`${apiBase}/api/projects`, {
        headers: { mail },
    });

    const wanted = String(label || '').trim().toLowerCase();
    return (projects || []).find((project) => normalizeProjectLabel(project).trim().toLowerCase() === wanted) || null;
}

async function createProject(apiBase, mail, label, description = '') {
    const payload = {
        label,
        description,
        position: { x: 50, y: 50 },
    };

    return apiJson(`${apiBase}/api/projects`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            mail,
        },
        body: JSON.stringify(payload),
    });
}

async function uploadFileToProject(apiBase, mail, projectRid, filePath) {
    const cleanRid = String(projectRid).replace(/^#/, '');
    const absFilePath = path.resolve(filePath);
    const filename = path.basename(absFilePath);
    const form = new FormData();
    form.append('file', createReadStream(absFilePath), filename);

    const response = await axios.post(
        `${apiBase}/api/projects/${cleanRid}/upload`,
        form,
        {
            headers: {
                ...form.getHeaders(),
                mail,
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            validateStatus: () => true,
        }
    );

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Upload failed ${response.status}: ${JSON.stringify(response.data)}`);
    }

    return response.data;
}

async function getProjectGraph(apiBase, mail, projectRid) {
    const cleanRid = String(projectRid).replace(/^#/, '');
    return apiJson(`${apiBase}/api/projects/${cleanRid}`, {
        headers: { mail },
    });
}

function projectHasFilename(projectGraph, filename) {
    const wanted = String(filename || '').trim().toLowerCase();
    if (!wanted) return false;

    const nodes = Array.isArray(projectGraph?.nodes) ? projectGraph.nodes : [];
    for (const node of nodes) {
        if (node?.data?.type !== 'File') continue;
        const name = String(node?.data?.name || '').trim().toLowerCase();
        if (name === wanted) return true;
    }
    return false;
}

async function ensureFileExists(filePath) {
    try {
        await fs.access(path.resolve(filePath));
    } catch {
        throw new Error(`File not found: ${filePath}`);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (!args.file) {
        console.error('Usage: node test/internal.js --file <path> [--project <label>] [--mail <mail>] [--api <url>] [--allow-duplicate]');
        process.exit(1);
    }

    await ensureFileExists(args.file);

    console.log('API:', args.api);
    console.log('User:', args.mail);
    console.log('Project label:', args.project);
    console.log('File:', path.resolve(args.file));

    let project = await findProjectByLabel(args.api, args.mail, args.project);
    if (!project) {
        console.log('Project not found, creating it...');
        project = await createProject(args.api, args.mail, args.project, args.description);
    } else {
        console.log('Using existing project.');
    }

    const projectRid = normalizeProjectRid(project);
    if (!projectRid) {
        throw new Error(`Could not resolve project rid from response: ${JSON.stringify(project)}`);
    }

    console.log('Project RID:', projectRid);

    if (!args.allowDuplicate) {
        const filename = path.basename(path.resolve(args.file));
        const projectGraph = await getProjectGraph(args.api, args.mail, projectRid);
        if (projectHasFilename(projectGraph, filename)) {
            console.log(`File \"${filename}\" already exists in project ${projectRid}, skipping upload.`);
            return;
        }
    }

    const fileNode = await uploadFileToProject(args.api, args.mail, projectRid, args.file);
    console.log('Uploaded file node:', fileNode?.['@rid'] || fileNode?.rid || JSON.stringify(fileNode));
}

main().catch((error) => {
    console.error('internal.js failed:', error.message);
    process.exit(1);
});


