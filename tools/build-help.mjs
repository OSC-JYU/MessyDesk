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
const HELP_STYLE_SOURCE = path.resolve(__dirname, '../docs/help/help.css');
const HELP_STYLE_OUTPUT_DIR = path.resolve(__dirname, '../public/help/styles');
const HELP_STYLE_OUTPUT_FILE = path.join(HELP_STYLE_OUTPUT_DIR, 'help.css');

marked.setOptions({
    gfm: true,
    breaks: false,
});

function renderMarkdownNotes(markdown) {
  const lines = String(markdown).split('\n');

  const transformedLines = lines.map((line) => {
    const trimmedLine = line.trim();

    const boldNoteMatch = trimmedLine.match(/^\*\*note:?\*\*\s+(.+)$/i);
    if (boldNoteMatch && boldNoteMatch[1]) {
      const content = marked.parseInline(boldNoteMatch[1].trim());
      return `<div class="md-note"><p class="md-note-title">NOTE</p><p>${content}</p></div>`;
    }

    const italicNoteMatch = trimmedLine.match(/^\*note:\s+(.+)\*$/i);
    if (italicNoteMatch && italicNoteMatch[1]) {
      const content = marked.parseInline(italicNoteMatch[1].trim());
      return `<div class="md-note"><p class="md-note-title">NOTE</p><p>${content}</p></div>`;
    }

    const plainNoteMatch = trimmedLine.match(/^note:\s+(.+)$/i);
    if (plainNoteMatch && plainNoteMatch[1]) {
      const content = marked.parseInline(plainNoteMatch[1].trim());
      return `<div class="md-note"><p class="md-note-title">NOTE</p><p>${content}</p></div>`;
    }

    return line;
  });

  return transformedLines.join('\n');
}

function renderMarkdownColumns(markdown) {
  const columnsBlockPattern = /:::columns(?:\s+(\d+))?\s*\n([\s\S]*?)\n:::/g;

  return markdown.replace(columnsBlockPattern, (fullMatch, rawCount, body) => {
    const sections = String(body)
      .split(/\n\s*---\s*\n/g)
      .map((section) => section.trim())
      .filter(Boolean);

    if (sections.length < 2) {
      return fullMatch;
    }

    const parsedCount = Number.parseInt(rawCount, 10);
    const desiredCount = Number.isFinite(parsedCount) ? parsedCount : sections.length;
    const safeColumnCount = Math.max(1, Math.min(desiredCount, 6));
    const mediumColumnCount = Math.max(1, Math.min(2, safeColumnCount));

    // Render each column section with markdown support before inserting HTML wrappers.
    const columnsHtml = sections
      .map((section) => `<section class="md-column">${marked.parse(section)}</section>`)
      .join('');

    return `<div class="md-columns" style="--md-columns: ${safeColumnCount}; --md-columns-medium: ${mediumColumnCount};">${columnsHtml}</div>`;
  });
}

function decorateSpecialBlockquotes(html) {
  const withTip = String(html).replace(
    /<blockquote>\s*<p>(?:💡\s*)?<strong>TIP:<\/strong>\s*/gi,
    '<blockquote class="md-tip"><p><span class="md-tip-icon" aria-hidden="true">💡</span> <strong>TIP:</strong> '
  );

  const withWarning = withTip.replace(
    /<blockquote>\s*<p>(?:⚠️?\s*)?<strong>WARNING:<\/strong>\s*/gi,
    '<blockquote class="md-warning"><p><span class="md-warning-icon" aria-hidden="true">⚠</span> <strong>WARNING:</strong> '
  );

  const stampColors = new Set(['orange', 'red', 'teal', 'blue', 'green']);

  return withWarning.replace(
    /<blockquote>\s*<p>(?:📌\s*)?<strong>\s*STAMP(?:\s*:\s*([a-z-]+))?\s*:??\s*<\/strong>\s*/gi,
    (fullMatch, rawColor) => {
      const color = String(rawColor || '').toLowerCase();
      const colorClass = stampColors.has(color) ? ` md-stamp-${color}` : '';
      return `<blockquote class="md-stamp${colorClass}"><p><span class="md-stamp-seal" aria-hidden="true"></span> `;
    }
  );
}

function decorateInlineStamps(html) {
  const stampColors = new Set(['orange', 'red', 'teal', 'blue', 'green']);

  return String(html).replace(
    /<p>\s*<strong>\s*STAMP(?:\s*:\s*([a-z-]+))?\s*:??\s*<\/strong>\s*([\s\S]*?)<\/p>/gi,
    (fullMatch, rawColor, content) => {
      const color = String(rawColor || '').toLowerCase();
      const colorClass = stampColors.has(color) ? ` md-stamp-${color}` : '';
      const trimmedContent = String(content || '').trim();
      if (!trimmedContent) {
        return fullMatch;
      }
      return `<p class="md-stamp-inline${colorClass}"><span class="md-stamp-seal" aria-hidden="true"></span> ${trimmedContent}</p>`;
    }
  );
}

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
  <link rel="stylesheet" href="/api/help/styles/help.css" />
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

async function copyHelpStyles() {
  const stylesExist = await fse.pathExists(HELP_STYLE_SOURCE);
  if (!stylesExist) {
    throw new Error(`Help style file not found: ${HELP_STYLE_SOURCE}`);
  }

  await fse.ensureDir(HELP_STYLE_OUTPUT_DIR);
  await fse.copyFile(HELP_STYLE_SOURCE, HELP_STYLE_OUTPUT_FILE);
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
    await copyHelpStyles();

    for (const page of pageData) {
      const rewritten = rewriteMarkdownImageLinks(rewriteMarkdownLinks(page.markdown, linkMap));
      const withNotes = renderMarkdownNotes(rewritten);
      const withColumns = renderMarkdownColumns(withNotes);
      const parsedHtml = marked.parse(withColumns);
      const withDecoratedQuotes = decorateSpecialBlockquotes(parsedHtml);
      const bodyHtml = decorateInlineStamps(withDecoratedQuotes);
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
