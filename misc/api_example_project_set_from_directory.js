import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import axios from 'axios';
import FormData from 'form-data';

const DEFAULT_API = 'http://localhost:8200';
const DEFAULT_MAIL = 'local.user@localhost';
const DEFAULT_DIR = 'test/files';

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.gif', '.bmp',
]);

function cleanRid(rid) {
  return String(rid || '').replace(/^#/, '');
}

function parseArgs(argv) {
  const now = Date.now();
  const args = {
    api: DEFAULT_API,
    mail: DEFAULT_MAIL,
    dir: DEFAULT_DIR,
    project: `api_example_dir_${now}`,
    projectDescription: 'Example project created from directory upload script',
    set: `images_${now}`,
    setDescription: 'Image set created from directory upload script',
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
    if (key === '--dir' && next) {
      args.dir = next;
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
    if (key === '--set' && next) {
      args.set = next;
      i++;
      continue;
    }
    if (key === '--set-description' && next) {
      args.setDescription = next;
      i++;
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
      position: { x: 60, y: 60 },
    }),
  });
}

async function createSet({ api, mail, projectRid, label, description }) {
  return apiJson(`${api}/api/projects/${cleanRid(projectRid)}/sets`, {
    method: 'POST',
    headers: {
      mail,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      label,
      description,
    }),
  });
}

async function uploadFileToSet({ api, mail, projectRid, setRid, filePath }) {
  const absFilePath = path.resolve(filePath);
  const filename = path.basename(absFilePath);
  const form = new FormData();
  form.append('file', createReadStream(absFilePath), filename);

  const response = await axios.post(
    `${api}/api/projects/${cleanRid(projectRid)}/upload/${cleanRid(setRid)}`,
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

async function getImageFilesFromDirectory(dirPath) {
  const absDir = path.resolve(dirPath);
  const dirStat = await fs.stat(absDir).catch(() => null);
  if (!dirStat || !dirStat.isDirectory()) {
    throw new Error(`Directory not found: ${absDir}`);
  }

  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(absDir, entry.name))
    .filter((fullPath) => IMAGE_EXTENSIONS.has(path.extname(fullPath).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  return files;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('Running directory-to-set API example...');
  console.log('API:', args.api);
  console.log('User:', args.mail);
  console.log('Input directory:', path.resolve(args.dir));
  console.log('Project label:', args.project);
  console.log('Set label:', args.set);

  const imageFiles = await getImageFilesFromDirectory(args.dir);
  if (imageFiles.length === 0) {
    throw new Error(`No image files found in ${path.resolve(args.dir)}`);
  }

  console.log(`Found ${imageFiles.length} image file(s).`);

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

  const setNode = await createSet({
    api: args.api,
    mail: args.mail,
    projectRid,
    label: args.set,
    description: args.setDescription,
  });
  const setRid = setNode?.['@rid'];
  if (!setRid) {
    throw new Error(`Set creation response missing @rid: ${JSON.stringify(setNode)}`);
  }
  console.log('Created set:', setRid);

  const uploaded = [];
  const failed = [];

  for (const filePath of imageFiles) {
    const filename = path.basename(filePath);
    try {
      const fileNode = await uploadFileToSet({
        api: args.api,
        mail: args.mail,
        projectRid,
        setRid,
        filePath,
      });
      uploaded.push({
        filename,
        rid: fileNode?.['@rid'] || null,
      });
      console.log(`Uploaded ${filename} -> ${fileNode?.['@rid'] || 'no rid'}`);
    } catch (error) {
      failed.push({ filename, error: error.message });
      console.error(`Failed ${filename}: ${error.message}`);
    }
  }

  console.log('\nDone. Summary:');
  console.log(`- Project: ${projectRid}`);
  console.log(`- Set: ${setRid}`);
  console.log(`- Images found: ${imageFiles.length}`);
  console.log(`- Uploaded: ${uploaded.length}`);
  console.log(`- Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.log('- Failed files:');
    for (const item of failed) {
      console.log(`  - ${item.filename}: ${item.error}`);
    }
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error('api_example_project_set_from_directory.js failed:', error.message);
  process.exit(1);
});
