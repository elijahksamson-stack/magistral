/**
 * A Canvas 2D context that actually rasterizes fillRect into an RGBA buffer.
 *
 * Lets the renderer tests assert what was actually painted — that the
 * background fill covers the canvas, and that culling really did skip the
 * off-screen nodes — rather than just counting draw calls.
 */

import type { RenderContext2D, TextMetricsLike } from '../renderContext';

/** Local stand-in for the canvas surface the renderer draws onto. */
export interface ExportCanvas {
  readonly width: number;
  readonly height: number;
  readonly context: RenderContext2D;
}

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const CHANNELS = 4;
const OPAQUE = 255;
/** Fake glyph width so measureText is deterministic. */
export const FAKE_GLYPH_WIDTH = 6;

export function parseColor(color: string): Rgba {
  const value = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex?.[1]) {
    const digits = hex[1];
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((d) => d + d)
            .join('')
        : digits;
    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }

  const rgba = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgba?.[1]) {
    const parts = rgba[1].split(',').map((part) => Number.parseFloat(part.trim()));
    return {
      r: parts[0] ?? 0,
      g: parts[1] ?? 0,
      b: parts[2] ?? 0,
      a: parts[3] ?? 1,
    };
  }

  throw new Error(`FakeCanvasContext cannot parse the colour "${color}".`);
}

export class FakeCanvasContext implements RenderContext2D {
  fillStyle: string | CanvasGradient | CanvasPattern = '#000000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000000';
  lineWidth = 1;
  globalAlpha = 1;
  font = '';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';

  readonly pixels: Uint8ClampedArray;
  readonly filledTexts: string[] = [];
  /** Stroke colour at each stroke(), so tests can assert which signal painted. */
  readonly strokeColors: string[] = [];
  readonly transforms: number[][] = [];
  fillRectCount = 0;
  arcCount = 0;
  strokeCount = 0;

  private scaleX = 1;
  private scaleY = 1;
  private translateX = 0;
  private translateY = 0;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Uint8ClampedArray(width * height * CHANNELS);
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transforms.push([a, b, c, d, e, f]);
    this.scaleX = a;
    this.scaleY = d;
    this.translateX = e;
    this.translateY = f;
  }

  save(): void {}
  restore(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  quadraticCurveTo(): void {}
  setLineDash(): void {}
  fill(): void {}

  arc(): void {
    this.arcCount += 1;
  }

  stroke(): void {
    this.strokeCount += 1;
    if (typeof this.strokeStyle === 'string') this.strokeColors.push(this.strokeStyle);
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.fillRectCount += 1;
    if (typeof this.fillStyle !== 'string') return;

    const color = parseColor(this.fillStyle);
    const alpha = color.a * this.globalAlpha;
    if (alpha <= 0) return;

    const left = Math.max(0, Math.round(x * this.scaleX + this.translateX));
    const top = Math.max(0, Math.round(y * this.scaleY + this.translateY));
    const right = Math.min(this.width, Math.round((x + width) * this.scaleX + this.translateX));
    const bottom = Math.min(this.height, Math.round((y + height) * this.scaleY + this.translateY));

    for (let py = top; py < bottom; py += 1) {
      for (let px = left; px < right; px += 1) {
        this.composite(px, py, color, alpha);
      }
    }
  }

  fillText(text: string): void {
    this.filledTexts.push(text);
  }

  measureText(text: string): TextMetricsLike {
    return { width: text.length * FAKE_GLYPH_WIDTH };
  }

  getPixel(x: number, y: number): Rgba {
    const offset = (y * this.width + x) * CHANNELS;
    return {
      r: this.pixels[offset] ?? 0,
      g: this.pixels[offset + 1] ?? 0,
      b: this.pixels[offset + 2] ?? 0,
      a: this.pixels[offset + 3] ?? 0,
    };
  }

  private composite(x: number, y: number, color: Rgba, alpha: number): void {
    const offset = (y * this.width + x) * CHANNELS;
    const destAlpha = (this.pixels[offset + 3] ?? 0) / OPAQUE;
    const outAlpha = alpha + destAlpha * (1 - alpha);

    for (let channel = 0; channel < 3; channel += 1) {
      const source = channel === 0 ? color.r : channel === 1 ? color.g : color.b;
      const dest = this.pixels[offset + channel] ?? 0;
      this.pixels[offset + channel] = source * alpha + dest * (1 - alpha);
    }
    this.pixels[offset + 3] = outAlpha * OPAQUE;
  }
}

/** Bytes-per-pixel used to fake a plausible JPEG size. */
const FAKE_BYTES_PER_PIXEL = 0.25;

export class FakeExportCanvas implements ExportCanvas {
  readonly context: FakeCanvasContext;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.context = new FakeCanvasContext(width, height);
  }

  getContext(): RenderContext2D | null {
    return this.context;
  }

  convertToBlob(options?: { type?: string; quality?: number }): Promise<Blob> {
    const size = Math.max(1, Math.round(this.width * this.height * FAKE_BYTES_PER_PIXEL));
    return Promise.resolve(
      new Blob([new Uint8Array(size)], { type: options?.type ?? 'image/jpeg' }),
    );
  }
}
