import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import axios from "axios";
import { renderReelFrame } from "./render";

// Builds a short silent reel (about 4 seconds per photo) from listing photos using ffmpeg.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegPath: string = require("ffmpeg-static");

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d) => { err += String(d).slice(-800); });
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.slice(-400)}`))));
  });
}

export async function makeReelMp4(input: { photoUrls: string[]; lines: string[] }): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reel-"));
  try {
    const frames: string[] = [];
    for (let i = 0; i < input.photoUrls.length; i += 1) {
      const res = await axios.get<ArrayBuffer>(input.photoUrls[i], { responseType: "arraybuffer", timeout: 30000 });
      const last = i === input.photoUrls.length - 1;
      const frame = await renderReelFrame({ photo: Buffer.from(res.data), line: input.lines[i] ?? input.lines[input.lines.length - 1] ?? "", cta: last });
      const file = path.join(dir, `f${i}.jpg`);
      fs.writeFileSync(file, frame);
      frames.push(file);
    }
    if (frames.length === 0) throw new Error("No photos for the reel.");

    const seg = 4;
    const fade = 0.5;
    const args = ["-y"];
    for (const f of frames) args.push("-loop", "1", "-t", String(seg + fade), "-i", f);
    const filters: string[] = [];
    let prev = "[0:v]";
    for (let i = 1; i < frames.length; i += 1) {
      const out = i === frames.length - 1 ? "[vout]" : `[x${i}]`;
      filters.push(`${prev}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${i * seg}${out}`);
      prev = out;
    }
    if (frames.length === 1) filters.push("[0:v]null[vout]");
    const total = frames.length * seg + fade;
    const outFile = path.join(dir, "out.mp4");
    args.push(
      "-filter_complex", filters.join(";"),
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-map", "[vout]", "-map", `${frames.length}:a`,
      "-t", String(total),
      "-r", "24", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart", outFile
    );
    await run(args);
    return fs.readFileSync(outFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
