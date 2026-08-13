/**
 * The slice of the Canvas 2D API this renderer actually uses.
 *
 * Declaring it structurally (instead of taking CanvasRenderingContext2D) means
 * the exact same draw calls run against a <canvas>, an OffscreenCanvas, and a
 * fake in tests. Both real contexts satisfy this interface, so no cast is
 * needed at the call sites.
 */

export interface TextMetricsLike {
  readonly width: number;
}

export interface RenderContext2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  save(): void;
  restore(): void;

  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  /** Dashes the in-flight connect line. Pass [] to return to solid. */
  setLineDash(segments: number[]): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  fill(): void;
  stroke(): void;

  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): TextMetricsLike;
}
