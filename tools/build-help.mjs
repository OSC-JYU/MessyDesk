import path from 'path';
import { fileURLToPath } from 'url';
import fse from 'fs-extra';
import { marked } from 'marked';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_DIR = path.resolve(__dirname, '../docs/help');
const OUTPUT_DIR = path.resolve(__dirname, '../public/help');
const IMAGE_SOURCE_DIR = path.resolve(__dirname, '../docs/images');
const IMAGE_OUTPUT_DIR = path.resolve(__dirname, '../public/help/images');

marked.setOptions({
    gfm: true,
    breaks: false,
});

function humanizeSlug(slug) {
    return slug
    .split(/[-_\s]+/)
        .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
        .join(' ');
}

function parseFilenameMeta(fileName) {
  const baseName = path.basename(fileName, '.md');
  const match = baseName.match(/^(\d+)[.\-_\s]+(.+)$/);

  const order = match ? Number.parseInt(match[1], 10) : Number.POSITIVE_INFINITY;
  const nameWithoutOrder = match ? match[2] : baseName;
  const slug = String(nameWithoutOrder)
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return {
    baseName,
    order,
    slug,
    navLabel: humanizeSlug(nameWithoutOrder),
  };
}

function extractTitle(markdown, fallbackSlug) {
    const heading = markdown.match(/^#\s+(.+)$/m);
    if (heading && heading[1]) return heading[1].trim();
    if (fallbackSlug === 'index') return 'Help';
    return humanizeSlug(fallbackSlug);
}

function rewriteMarkdownLinks(markdown, linkMap) {
  // Convert internal markdown links to /help routes using slug mapping.
  return markdown.replace(/\]\(([^)]+)\.md(#[^)]+)?\)/g, (fullMatch, rawTarget, hashPart = '') => {
    if (/^(?:[a-z]+:|\/\/|\/|#)/i.test(rawTarget)) return fullMatch;

    const normalizedTarget = String(rawTarget).trim().replace(/^\.\//, '');
    const targetBaseName = path.basename(normalizedTarget);
    const mappedSlug = linkMap.get(targetBaseName) || parseFilenameMeta(`${targetBaseName}.md`).slug;

    if (!mappedSlug || mappedSlug === 'index') {
      return `](/help${hashPart})`;
    }

    return `](/help/${mappedSlug}${hashPart})`;
  });
}

function rewriteMarkdownImageLinks(markdown) {
  // If image path is bare filename (no slash), resolve it from docs/images.
  return markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (fullMatch, altText, src, titlePart = '') => {
    if (/^(?:[a-z]+:|\/\/|\/|#)/i.test(src)) return fullMatch;
    if (src.includes('/')) return fullMatch;
    const encodedName = encodeURIComponent(src);
    return `![${altText}](/api/help/images/${encodedName}${titlePart})`;
  });
}

async function copyHelpImages() {
  const imagesExist = await fse.pathExists(IMAGE_SOURCE_DIR);
  await fse.ensureDir(IMAGE_OUTPUT_DIR);
  await fse.emptyDir(IMAGE_OUTPUT_DIR);

  if (!imagesExist) {
    return 0;
  }

  await fse.copy(IMAGE_SOURCE_DIR, IMAGE_OUTPUT_DIR, {
    overwrite: true,
    errorOnExist: false,
  });

  const entries = await fse.readdir(IMAGE_OUTPUT_DIR, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).length;
}

function buildHelpNav(pages, currentSlug) {
    const items = pages
        .map((page) => {
            const activeClass = page.slug === currentSlug ? ' class="active"' : '';
            const href = page.slug === 'index' ? '/help' : `/help/${page.slug}`;
      return `<a${activeClass} href="${href}">${page.navLabel}</a>`;
        })
        .join('');

    return `<nav class="help-nav">${items}</nav>`;
}

function wrapHtmlDocument({ title, nav, content }) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MessyDesk Help - ${title}</title>
  <style>
    :root {
      --bg: #f2f7f8;
      --panel: #ffffff;
      --line: #d6e4e8;
      --text: #21313b;
      --accent: #0f8a8f;
      --accent-soft: #e6f6f7;
    }
    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: radial-gradient(circle at 15% 10%, #e0f3f4 0%, #f7fbfc 35%, #eef3f6 100%);
      color: var(--text);
      font-family: "Segoe UI", "Noto Sans", sans-serif;
      line-height: 1.6;
    }
    .page {
      max-width: 1060px;
      padding: 24px 18px 48px;
    }
    .help-nav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 18px;
      margin-top: 18px;
    }
    .help-nav a {
      text-decoration: none;
      color: #0f5d61;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 7px 14px;
      font-size: 14px;
    }
    .help-nav a.active {
      background: var(--accent-soft);
      border-color: #7fc8cb;
      color: #0a4c50;
      font-weight: 600;
    }
    .content {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 24px;
      box-shadow: 0 10px 25px rgba(12, 44, 56, 0.08);
    }
    h1, h2, h3 { color: #113944; }
    pre {
      background: #1e2c34;
      color: #eaf4f7;
      border-radius: 8px;
      padding: 14px;
      overflow-x: auto;
    }
    code {
      font-family: "Fira Mono", "Consolas", monospace;
      font-size: 0.92em;
    }
    a { color: #0f6f75; }
  </style>
</head>
<body>
  <main class="page">
    ${nav}
    <article class="content">
      ${content}
    </article>
  </main>
</body>
</html>`;
}

async function buildHelp() {
    const sourceExists = await fse.pathExists(SOURCE_DIR);
    if (!sourceExists) {
        throw new Error(`Help source directory not found: ${SOURCE_DIR}`);
    }

    const entries = await fse.readdir(SOURCE_DIR, { withFileTypes: true });
    const markdownFiles = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .map((entry) => entry.name)
        .sort();

    if (!markdownFiles.length) {
        throw new Error('No markdown files found in docs/help');
    }

    const pageData = [];
    const linkMap = new Map();
    const usedSlugs = new Set();

    for (const fileName of markdownFiles) {
      const { baseName, order, slug, navLabel } = parseFilenameMeta(fileName);
      if (!slug) {
        throw new Error(`Invalid help filename for slug generation: ${fileName}`);
      }
      if (usedSlugs.has(slug)) {
        throw new Error(`Duplicate help slug "${slug}" from filename: ${fileName}`);
      }

        const inputPath = path.join(SOURCE_DIR, fileName);
        const markdown = await fse.readFile(inputPath, 'utf8');
        const title = extractTitle(markdown, slug);
      const page = { fileName, baseName, order, slug, navLabel, title, markdown };
      pageData.push(page);
      linkMap.set(baseName, slug);
      usedSlugs.add(slug);
    }

    pageData.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.baseName.localeCompare(b.baseName);
    });

    await fse.ensureDir(OUTPUT_DIR);
    await fse.emptyDir(OUTPUT_DIR);
    const copiedImageCount = await copyHelpImages();

    for (const page of pageData) {
      const rewritten = rewriteMarkdownImageLinks(rewriteMarkdownLinks(page.markdown, linkMap));
        const bodyHtml = marked.parse(rewritten);
        const navHtml = buildHelpNav(pageData, page.slug);
        const html = wrapHtmlDocument({
            title: page.title,
            nav: navHtml,
            content: bodyHtml,
        });

        await fse.writeFile(path.join(OUTPUT_DIR, `${page.slug}.html`), html, 'utf8');
    }

      console.log(`Generated ${pageData.length} help page(s) and copied ${copiedImageCount} image(s) in ${OUTPUT_DIR}`);
}

buildHelp().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
