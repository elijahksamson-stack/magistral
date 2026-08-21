/**
 * The files a cell embeds.
 *
 * `![[chart.png]]` embeds a file; `[[Chart]]` asserts a concept. The parser
 * deliberately ignores the first — an image is not a node, and treating it as
 * one filled the canvas with concepts named after filenames — which leaves
 * nothing else to answer "what images does this concept carry?".
 *
 * That is this module. Pure: no IPC, no DOM.
 */

/** `![[name]]`, tolerating padding. The `!` is what distinguishes it. */
const EMBED = /!\[\[\s*([^\]\n|]+?)\s*\]\]/g;

/** Extensions the panel will try to draw. Anything else is a file, not a picture. */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

function isImage(fileName: string): boolean {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.includes(extension);
}

/**
 * Every image embedded in the markdown, in order, without repeats.
 *
 * Deduplicated because an author who refers to the same figure twice wants it
 * shown once: the panel is a gallery of what this concept carries, not a
 * transcript of how often it was mentioned.
 */
export function embeddedImages(markdown: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  EMBED.lastIndex = 0;
  for (let match = EMBED.exec(markdown); match; match = EMBED.exec(markdown)) {
    const fileName = (match[1] ?? '').trim();
    if (fileName.length === 0 || seen.has(fileName) || !isImage(fileName)) continue;
    seen.add(fileName);
    found.push(fileName);
  }

  return found;
}

/** The markdown that embeds a file. */
export function embedMarkdown(fileName: string): string {
  return `![[${fileName}]]`;
}
