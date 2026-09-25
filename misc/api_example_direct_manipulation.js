import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import axios from 'axios';
import FormData from 'form-data';

const DEFAULT_API = 'http://localhost:8200';
const DEFAULT_MAIL = 'local.user@localhost';
const DEFAULT_FILE = 'test/files/test.jpg';

function parseArgs(argv) {
  const args = {
    api: DEFAULT_API,
    mail: DEFAULT_MAIL,
    file: DEFAULT_FILE,
    project: `api_example_${Date.now()}`,
    projectDescription: 'Example project created via API script',
    fileDescription: 'Example description set via /api/graph/vertices/{rid}',
    queueTopic: 'md-imaginary',
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
    if (key === '--file' && next) {
      args.file = next;
      i++;
      continue;
    }
    if (key === '--project' && next) {
      args.project = next;
      i++;
      continue;
    }
    if (key === '--project-description' && next) {
      args.projectDescription = next;
      i++;
      continue;
    }
    if (key === '--file-description' && next) {
      args.fileDescription = next;
      i++;
      continue;
    }
    if (key === '--queue-topic' && next) {
      args.queueTopic = next;
      i++;
      continue;
    }
  }

  return args;
}

function cleanRid(rid) {
  return String(rid || '').replace(/^#/, '');
}

async function ensureFileExists(filePath) {
  try {
    await fs.access(path.resolve(filePath));
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
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

async function createProject({ api, mail, label, description }) {
  return apiJson(`${api}/api/projects`, {
    method: 'POST',
    headers: {
      mail,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      label,
      description,
      position: { x: 50, y: 50 },
    }),
  });
}

async function uploadFileToProject({ api, mail, projectRid, filePath }) {
  const absFilePath = path.resolve(filePath);
  const filename = path.basename(absFilePath);

  const form = new FormData();
  form.append('file', createReadStream(absFilePath), filename);

  const response = await axios.post(
    `${api}/api/projects/${cleanRid(projectRid)}/upload`,
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

async function setFileDescription({ api, mail, fileRid, description }) {
  return apiJson(`${api}/api/graph/vertices/${cleanRid(fileRid)}`, {
    method: 'POST',
    headers: {
      mail,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      key: 'description',
      value: description,
    }),
  });
}

async function queueImaginaryFlip({ api, mail, fileRid, queueTopic }) {
  const payload = {
    service: queueTopic,
    id: 'flip',
    params: {},
    info: 'I flipped image',
  };

  return apiJson(`${api}/api/queue/${queueTopic}/files/${cleanRid(fileRid)}`, {
    method: 'POST',
    headers: {
      mail,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureFileExists(args.file);

  console.log('Running API direct-manipulation example...');
  console.log('API:', args.api);
  console.log('User:', args.mail);
  console.log('Project label:', args.project);
  console.log('Input file:', path.resolve(args.file));

  // 1) Create project
  const project = await createProject({
    api: args.api,
    mail: args.mail,
    label: args.project,
    description: args.projectDescription,
  });

  const projectRid = project?.['@rid'];
  if (!projectRid) {
    throw new Error(`Project creation response missing @rid: ${JSON.stringify(project)}`);
  }
  console.log('Created project:', projectRid);

  // 2) Upload file to project
  const fileNode = await uploadFileToProject({
    api: args.api,
    mail: args.mail,
    projectRid,
    filePath: args.file,
  });

  const fileRid = fileNode?.['@rid'];
  if (!fileRid) {
    throw new Error(`File upload response missing @rid: ${JSON.stringify(fileNode)}`);
  }
  console.log('Uploaded file:', fileRid);

  // 3) Write description to file
  await setFileDescription({
    api: args.api,
    mail: args.mail,
    fileRid,
    description: args.fileDescription,
  });
  console.log('Updated file description.');

  // 4) Add imaginary flip processing node via queue API
  const queueResult = await queueImaginaryFlip({
    api: args.api,
    mail: args.mail,
    fileRid,
    queueTopic: args.queueTopic,
  });
  console.log('Queued flip processing:', queueResult);

  console.log('\nDone. Summary:');
  console.log(`- Project: ${projectRid}`);
  console.log(`- File: ${fileRid}`);
  console.log(`- Description: ${args.fileDescription}`);
  console.log(`- Processing: ${args.queueTopic}:flip`);
}

main().catch((error) => {
  console.error('api_example_direct_manipulation.js failed:', error.message);
  process.exit(1);
});
