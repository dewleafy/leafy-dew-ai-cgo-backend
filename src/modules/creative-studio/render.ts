import fs from "fs";
import os from "os";
import path from "path";

// Draws brand pictures with sharp (Pango text shaping, so Hindi and Tamil render correctly).
// Fonts live in assets/fonts. fontconfig is pointed at them before sharp loads.

const FONT_DIR = path.resolve(process.cwd(), "assets", "fonts");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SharpFn = (input?: any) => any;
let sharpMod: SharpFn | null = null;

async function getSharp(): Promise<SharpFn> {
  if (sharpMod) return sharpMod;
  const conf = path.join(os.tmpdir(), "leafydew-fonts.conf");
  fs.writeFileSync(
    conf,
    `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${FONT_DIR}</dir><cachedir>${path.join(os.tmpdir(), "leafydew-fontcache")}</cachedir></fontconfig>`
  );
  process.env.FONTCONFIG_FILE = conf;
  const loaded = (await import("sharp")) as unknown as { default?: SharpFn };
  sharpMod = (loaded.default ?? (loaded as unknown as SharpFn)) as SharpFn;
  return sharpMod;
}

export const BRAND = { green: "#0f5a34", deep: "#0a3f25", cream: "#f5e9c8", white: "#ffffff" };

export function stripEmoji(text: string): string {
  return text.replace(/[\p{Extended_Pictographic}️‍]/gu, "").replace(/[ \t]+/g, " ").trim();
}

const SCRIPTS: [RegExp, string][] = [
  [/[\u0900-\u097F]/, "Noto Sans Devanagari"],
  [/[\u0B80-\u0BFF]/, "Noto Sans Tamil"],
  [/[\u0C00-\u0C7F]/, "Noto Sans Telugu"],
  [/[\u0A80-\u0AFF]/, "Noto Sans Gujarati"],
  [/[\u0980-\u09FF]/, "Noto Sans Bengali"],
  [/[\u0C80-\u0CFF]/, "Noto Sans Kannada"],
  [/[\u0D00-\u0D7F]/, "Noto Sans Malayalam"],
  [/[\u0A00-\u0A7F]/, "Noto Sans Gurmukhi"]
];

export function hasNonLatin(text: string): boolean {
  return SCRIPTS.some(([re]) => re.test(text));
}

function fontFor(text: string): string {
  return SCRIPTS.find(([re]) => re.test(text))?.[1] ?? "Poppins";
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Splits text into lines that fit a width, using a rough character width.
function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

function textBlock(lines: string[], opts: { x: number; startY: number; size: number; color: string; maxChars: number; gap: number }): { svg: string; endY: number } {
  let y = opts.startY;
  let svg = "";
  for (const raw of lines) {
    for (const part of wrap(raw, opts.maxChars)) {
      svg += `<text x="${opts.x}" y="${y}" font-family="${fontFor(part)}" font-weight="700" font-size="${opts.size}" fill="${opts.color}" text-anchor="middle">${esc(part)}</text>`;
      y += Math.round(opts.size * 1.45);
    }
    y += opts.gap;
  }
  return { svg, endY: y };
}

function leaf(cx: number, cy: number, size: number, rot: number, opacity: number): string {
  return `<g transform="translate(${cx} ${cy}) rotate(${rot}) scale(${size / 100})" opacity="${opacity}"><path d="M0,-100 C70,-60 70,40 0,100 C-70,40 -70,-60 0,-100 Z" fill="#ffffff"/><path d="M0,-90 L0,95" stroke="${BRAND.green}" stroke-width="4" fill="none"/></g>`;
}

function backdrop(w: number, h: number): string {
  return `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BRAND.green}"/><stop offset="1" stop-color="${BRAND.deep}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#bg)"/>${leaf(w * 0.14, h * 0.12, 150, -30, 0.08)}${leaf(w * 0.9, h * 0.2, 110, 35, 0.07)}${leaf(w * 0.86, h * 0.88, 170, 140, 0.08)}${leaf(w * 0.1, h * 0.82, 120, -140, 0.06)}`;
}

function footer(w: number, h: number): string {
  return `<text x="${w / 2}" y="${h - 110}" font-family="Poppins" font-weight="700" font-size="46" fill="${BRAND.cream}" text-anchor="middle" letter-spacing="3">LEAFY DEW</text><text x="${w / 2}" y="${h - 62}" font-family="Poppins" font-weight="600" font-size="28" fill="${BRAND.white}" opacity="0.8" text-anchor="middle">@leafy_dew</text>`;
}

// 1080x1350 greeting picture. headline is the festival name, lines are the greeting lines.
export async function renderGreeting(input: { headline: string; lines: string[] }): Promise<Buffer> {
  const sharp = await getSharp();
  const w = 1080;
  const h = 1350;
  const head = textBlock([stripEmoji(input.headline)], { x: w / 2, startY: 380, size: 70, color: BRAND.white, maxChars: 20, gap: 30 });
  const body = textBlock(input.lines.map(stripEmoji).filter(Boolean), { x: w / 2, startY: head.endY + 40, size: 52, color: BRAND.cream, maxChars: 26, gap: 26 });
  const rule = `<rect x="${w / 2 - 70}" y="${head.endY - 20}" width="140" height="5" rx="2.5" fill="${BRAND.cream}" opacity="0.7"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${backdrop(w, h)}${head.svg}${rule}${body.svg}${footer(w, h)}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

// 1080x1920 reel frame: product photo on a white card with a line of text above.
export async function renderReelFrame(input: { photo: Buffer; line: string; cta?: boolean }): Promise<Buffer> {
  const sharp = await getSharp();
  const w = 1080;
  const h = 1920;
  const cardSize = 960;
  const photo = await sharp(input.photo).resize(cardSize - 40, cardSize - 40, { fit: "contain", background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer();
  const text = textBlock([stripEmoji(input.line)], { x: w / 2, startY: 330, size: 60, color: BRAND.white, maxChars: 24, gap: 0 });
  const cta = input.cta
    ? `<rect x="${w / 2 - 260}" y="1560" width="520" height="90" rx="45" fill="${BRAND.cream}"/><text x="${w / 2}" y="1620" font-family="Poppins" font-weight="700" font-size="40" fill="${BRAND.deep}" text-anchor="middle">Link in bio</text>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${backdrop(w, h)}${text.svg}<rect x="${(w - cardSize) / 2}" y="560" width="${cardSize}" height="${cardSize}" rx="36" fill="#ffffff"/>${cta}${footer(w, h)}</svg>`;
  return sharp(Buffer.from(svg))
    .composite([{ input: photo, left: (w - cardSize) / 2 + 20, top: 580 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}
