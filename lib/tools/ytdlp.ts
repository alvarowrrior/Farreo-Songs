// Resolución de los binarios que necesita la descarga de YouTube.
//
// A propósito no dependemos de `yt-dlp-wrap` ni de `ffmpeg-static`: el segundo
// pesa ~80 MB y reventaría el bundle de Vercel para toda la app. En su lugar
// buscamos los binarios del sistema y, si no están, bajamos yt-dlp bajo demanda.
import path from "path";
import fs from "fs";
import os from "os";
import https from "https";
import { execFile } from "child_process";

const BIN_DIR = path.join(process.cwd(), ".ytdlp");

function binaryName(): string {
  switch (os.platform()) {
    case "win32":
      return "yt-dlp.exe";
    case "darwin":
      return "yt-dlp_macos";
    default:
      return "yt-dlp";
  }
}

const RELEASE_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${binaryName()}`;

// Desde 2026.06 yt-dlp necesita un runtime JS para extraer YouTube; solo deno
// viene habilitado por defecto. Reutilizamos el Node que ya ejecuta el server.
export const COMMON_ARGS = ["--js-runtimes", `node:${process.execPath}`];

/** Entornos serverless de solo lectura donde esto no puede funcionar. */
export function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
}

function which(command: string): Promise<string | null> {
  const finder = os.platform() === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    execFile(finder, [command], (err, stdout) => {
      if (err) return resolve(null);
      const first = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
      resolve(first || null);
    });
  });
}

function download(url: string, dest: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Demasiadas redirecciones"));
    const tmp = `${dest}.download`;
    const file = fs.createWriteStream(tmp);
    https
      .get(url, { headers: { "User-Agent": "farreo" } }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          file.close();
          fs.rm(tmp, { force: true }, () => {});
          const next = new URL(res.headers.location, url).toString();
          return resolve(download(next, dest, redirects + 1));
        }
        if (status !== 200) {
          res.resume();
          file.close();
          fs.rm(tmp, { force: true }, () => {});
          return reject(new Error(`La descarga de yt-dlp falló (HTTP ${status})`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => {
          fs.rename(tmp, dest, (err) => (err ? reject(err) : resolve()));
        }));
      })
      .on("error", (err) => {
        file.close();
        fs.rm(tmp, { force: true }, () => {});
        reject(err);
      });
  });
}

let ytDlpPromise: Promise<string> | null = null;

async function resolveYtDlp(): Promise<string> {
  const fromEnv = process.env.YTDLP_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const local = path.join(BIN_DIR, binaryName());
  if (fs.existsSync(local)) return local;

  const onPath = await which(os.platform() === "win32" ? "yt-dlp.exe" : "yt-dlp");
  if (onPath) return onPath;

  if (isServerless()) {
    throw new Error("El servidor no permite descargar yt-dlp (entorno de solo lectura)");
  }

  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
  await download(RELEASE_URL, local);
  if (os.platform() !== "win32") {
    try { fs.chmodSync(local, 0o755); } catch {}
  }
  return local;
}

/** Ruta a yt-dlp, descargándolo la primera vez si hace falta. */
export function getYtDlp(): Promise<string> {
  if (!ytDlpPromise) {
    ytDlpPromise = resolveYtDlp().catch((err) => {
      ytDlpPromise = null;
      throw err;
    });
  }
  return ytDlpPromise;
}

/** True si ya tenemos yt-dlp sin necesidad de descargarlo. */
export function hasYtDlpReady(): Promise<boolean> {
  const fromEnv = process.env.YTDLP_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return Promise.resolve(true);
  if (fs.existsSync(path.join(BIN_DIR, binaryName()))) return Promise.resolve(true);
  return which(os.platform() === "win32" ? "yt-dlp.exe" : "yt-dlp").then(Boolean);
}

let ffmpegPromise: Promise<string | null> | null = null;

/** Ruta a ffmpeg si está disponible; null si no. Sin él no se transcodifica a MP3. */
export function getFfmpeg(): Promise<string | null> {
  if (!ffmpegPromise) {
    const fromEnv = process.env.FFMPEG_PATH;
    ffmpegPromise = fromEnv && fs.existsSync(fromEnv)
      ? Promise.resolve(fromEnv)
      : which(os.platform() === "win32" ? "ffmpeg.exe" : "ffmpeg");
  }
  return ffmpegPromise;
}
