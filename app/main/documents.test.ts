/**
 * Document import — reading .docx / .md / .txt into plain text.
 *
 * The .docx case builds a real Office Open XML file on the fly rather than
 * mocking mammoth, because the thing that can actually break here is the
 * container format, not our call site.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDocument, readFolder, SUPPORTED_EXTENSIONS } from './documents';
import { DOCUMENT_CHAR_LIMIT } from '../../shared/types/claude';

let dir: string;

/** Minimal but valid .docx: a zip with the parts Word requires. */
async function writeDocx(filePath: string, paragraphs: readonly string[]): Promise<void> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );

  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`)
    .join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body>
</w:document>`,
  );

  await fs.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

/**
 * A minimal single-page PDF with a text stream.
 *
 * Hand-built rather than fixture-committed so the test proves the reader
 * handles real PDF structure — xref table, object offsets and all.
 */
async function writePdf(filePath: string, lines: readonly string[]): Promise<void> {
  const content =
    lines.length === 0
      ? ''
      : `BT /F1 12 Tf 72 720 Td 14 TL ${lines
          .map((line) => `(${line.replace(/([()\\])/g, '\\$1')}) Tj T*`)
          .join(' ')} ET`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  await fs.writeFile(filePath, pdf, 'latin1');
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'braindump-docs-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('readDocument', () => {
  it('reads a .txt file', async () => {
    const file = path.join(dir, 'note.txt');
    await fs.writeFile(file, 'The binding constraint is EUV lithography.');

    const document = await readDocument(file);
    expect(document.name).toBe('note.txt');
    expect(document.text).toBe('The binding constraint is EUV lithography.');
    expect(document.isTruncated).toBe(false);
  });

  it('reads a .md file without stripping its markup', async () => {
    const file = path.join(dir, 'thesis.md');
    await fs.writeFile(file, '# Thesis\n\n- point one\n- point two\n');

    const document = await readDocument(file);
    expect(document.text).toContain('# Thesis');
    expect(document.text).toContain('- point one');
  });

  it('reads a real .docx down to its text', async () => {
    const file = path.join(dir, 'memo.docx');
    await writeDocx(file, [
      'Q3 Strategy Memo',
      'ASML remains the sole supplier of EUV scanners.',
      'That monopoly is the binding constraint on logic capacity.',
    ]);

    const document = await readDocument(file);
    expect(document.name).toBe('memo.docx');
    expect(document.text).toContain('Q3 Strategy Memo');
    expect(document.text).toContain('sole supplier of EUV scanners');
    expect(document.text).toContain('binding constraint');
    // The XML container must not leak into the prose handed to the model.
    expect(document.text).not.toContain('<w:');
  });

  it('collapses the blank-line runs docx extraction produces', async () => {
    const file = path.join(dir, 'spaced.docx');
    await writeDocx(file, ['First', '', '', '', 'Second']);

    const document = await readDocument(file);
    expect(document.text).not.toMatch(/\n{3,}/);
  });

  it('truncates past the limit and says so', async () => {
    const file = path.join(dir, 'long.txt');
    // Paragraph-shaped, so the cut has a boundary to prefer.
    await fs.writeFile(file, 'a'.repeat(200).concat('\n\n').repeat(600));

    const document = await readDocument(file);
    expect(document.isTruncated).toBe(true);
    expect(document.text.length).toBeLessThanOrEqual(DOCUMENT_CHAR_LIMIT);
  });

  it('refuses an empty file with a message rather than sending nothing', async () => {
    const file = path.join(dir, 'empty.txt');
    await fs.writeFile(file, '   \n\n  ');
    await expect(readDocument(file)).rejects.toThrow(/no readable text/i);
  });

  it('reports a missing file by name', async () => {
    await expect(readDocument(path.join(dir, 'absent.txt'))).rejects.toThrow(/absent\.txt/);
  });

  it('reports a corrupt .docx instead of throwing a parser stack trace', async () => {
    const file = path.join(dir, 'broken.docx');
    await fs.writeFile(file, 'this is definitely not a zip archive');
    await expect(readDocument(file)).rejects.toThrow(/Could not read broken\.docx/);
  });

  it('offers exactly the formats the import control advertises', () => {
    expect([...SUPPORTED_EXTENSIONS]).toEqual([
      'pdf',
      'docx',
      'doc',
      'rtf',
      'md',
      'markdown',
      'txt',
      'text',
    ]);
  });

  it('reads a real .rtf down to its text', async () => {
    const file = path.join(dir, 'memo.rtf');
    // Minimal but valid RTF, control words and all.
    await fs.writeFile(
      file,
      String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Times New Roman;}}` +
        String.raw`\f0\fs24 ASML is the sole supplier of EUV scanners.\par` +
        String.raw`That monopoly is the binding constraint.\par}`,
    );

    const document = await readDocument(file);
    expect(document.text).toContain('sole supplier of EUV scanners');
    expect(document.text).toContain('binding constraint');
    // Control words must not leak into the prose handed to the model.
    expect(document.text).not.toContain('\\rtf1');
    expect(document.text).not.toContain('fonttbl');
  });

  it('reads a real .pdf down to its text', async () => {
    const file = path.join(dir, 'memo.pdf');
    await writePdf(file, ['Q3 Capacity Memo', 'EUV lithography is the binding constraint.']);

    const document = await readDocument(file);
    expect(document.name).toBe('memo.pdf');
    expect(document.text).toContain('Q3 Capacity Memo');
    expect(document.text).toContain('binding constraint');
  });

  it('says a PDF may be scanned when it yields no text', async () => {
    const file = path.join(dir, 'scanned.pdf');
    await writePdf(file, []);
    await expect(readDocument(file)).rejects.toThrow(/scanned document/i);
  });

  it('reports a corrupt .pdf instead of a parser stack trace', async () => {
    const file = path.join(dir, 'broken.pdf');
    await fs.writeFile(file, 'not a pdf at all');
    await expect(readDocument(file)).rejects.toThrow(/Could not read broken\.pdf/);
  });
});

/*
 * Folder import. The structure is the deliverable: the directory becomes the
 * concept and each subdirectory becomes one of its sub-concepts, so the outline
 * has to name every subfolder — including the ones with nothing readable in
 * them, which would otherwise vanish off the map silently.
 */
describe('readFolder', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'braindump-folder-'));

    await fs.mkdir(path.join(root, 'Energy'), { recursive: true });
    await fs.writeFile(path.join(root, 'Energy', 'grid.md'), 'Gas sets the clearing price.');

    await fs.mkdir(path.join(root, 'Semis'), { recursive: true });
    await fs.writeFile(path.join(root, 'Semis', 'euv.md'), 'One supplier for EUV lithography.');
    // Nested one level deeper, to prove depth is walked rather than ignored.
    await fs.mkdir(path.join(root, 'Semis', 'Packaging'), { recursive: true });
    await fs.writeFile(path.join(root, 'Semis', 'Packaging', 'cowos.md'), 'Advanced packaging.');

    await fs.mkdir(path.join(root, 'Empty'), { recursive: true });

    await fs.writeFile(path.join(root, 'readme.md'), 'What this collection is.');

    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'pkg.md'), 'MACHINERY, NOT KNOWLEDGE');
    await fs.writeFile(path.join(root, '.secret.md'), 'HIDDEN FILE CONTENT');
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('names the folder and marks the document as one', async () => {
    const document = await readFolder(root);

    expect(document.name).toBe(path.basename(root));
    expect(document.isFolder).toBe(true);
    expect(document.text).toContain(`# Folder: ${path.basename(root)}`);
  });

  it('gives every subfolder its own section, in name order', async () => {
    const { text } = await readFolder(root);

    expect(text).toContain('## Subfolder: Energy');
    expect(text).toContain('## Subfolder: Semis');
    expect(text.indexOf('## Subfolder: Energy')).toBeLessThan(text.indexOf('## Subfolder: Semis'));
  });

  it('carries the text of the files inside each subfolder', async () => {
    const { text } = await readFolder(root);

    expect(text).toContain('Gas sets the clearing price.');
    expect(text).toContain('One supplier for EUV lithography.');
  });

  it('walks below the first level rather than stopping at it', async () => {
    expect((await readFolder(root)).text).toContain('Advanced packaging.');
  });

  /*
   * A subfolder the author made is a concept they meant, even when it holds
   * nothing readable yet. Dropping it would silently lose a subnode.
   */
  it('keeps a subfolder with nothing readable in it', async () => {
    const { text } = await readFolder(root);

    expect(text).toContain('## Subfolder: Empty');
    expect(text).toContain('(no readable documents in it)');
  });

  it('keeps loose files sitting directly in the folder', async () => {
    const { text } = await readFolder(root);

    expect(text).toContain('## Files directly in this folder');
    expect(text).toContain('What this collection is.');
  });

  it('skips machinery and hidden files rather than spending the budget on them', async () => {
    const { text } = await readFolder(root);

    expect(text).not.toContain('MACHINERY, NOT KNOWLEDGE');
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('HIDDEN FILE CONTENT');
  });

  it('stays inside the character limit the CLI can accept', async () => {
    expect((await readFolder(root)).text.length).toBeLessThanOrEqual(DOCUMENT_CHAR_LIMIT);
  });

  it('says so plainly when there is nothing to import', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'braindump-bare-'));
    try {
      await expect(readFolder(bare)).rejects.toThrow(/no readable documents/);
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });

  it('refuses a file handed to it as a folder', async () => {
    const file = path.join(root, 'readme.md');
    await expect(readFolder(file)).rejects.toThrow(/is not a folder/);
  });
});
