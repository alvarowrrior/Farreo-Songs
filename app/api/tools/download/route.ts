import { NextRequest } from "next/server";
import { spawn } from "child_process";
import { Readable } from "stream";
import { COMMON_ARGS, getFfmpeg, getYtDlp, hasYtDlpReady, isServerless } from "@/lib/tools/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 60 s es el tope del plan Hobby de Vercel: un valor mayor hace fallar el
// despliegue entero, aunque esta ruta ni siquiera funcione en serverless.
export const maxDuration = 60;

const YOUTUBE_REGEX =
  /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/|v\/)|youtu\.be\/)[\w\-]+/i;

function sanitize(name: string) {
  return name.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120).trim() || "youtube";
}

function contentDisposition(filename: string, ext: string): string {
  const full = `${filename}.${ext}`;
  // Fallback ASCII: fuera todo lo que no sea ASCII imprimible.
  const ascii = full.replace(/[^\x20-\x7E]+/g, "_").replace(/"/g, "'") || `youtube.${ext}`;
  // Variante UTF-8 (RFC 5987) para navegadores modernos.
  const encoded = encodeURIComponent(full);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function getTitle(binaryPath: string, url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binaryPath, [
      ...COMMON_ARGS,
      "--no-playlist",
      "--no-warnings",
      // Sin esto yt-dlp escribe stdout en la codificación de consola (cp1252
      // en Windows) y se pierden los acentos del título.
      "--encoding", "utf-8",
      "--print", "%(title)s",
      url,
    ]);
    proc.stdout.setEncoding("utf8");
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", (d) => { err += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0 && out.trim()) resolve(out.trim().split("\n")[0]);
      else reject(new Error(err.trim() || `yt-dlp salió con código ${code}`));
    });
  });
}

function nodeStreamToWeb(stream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      stream.on("data", (chunk: Buffer) => {
        try { controller.enqueue(new Uint8Array(chunk)); } catch {}
      });
      stream.on("end", () => { try { controller.close(); } catch {} });
      stream.on("error", (err) => { try { controller.error(err); } catch {} });
    },
    cancel() { stream.destroy(); },
  });
}

/** Le dice a la UI si esta instalación puede descargar de YouTube. */
export async function GET() {
  if (isServerless()) {
    return Response.json({
      available: false,
      reason:
        "Esta herramienta necesita ejecutar yt-dlp, y el despliegue actual es serverless (sistema de archivos de solo lectura). Funciona ejecutando Farreo en local o en un servidor propio.",
      ffmpeg: false,
    });
  }

  const [ytdlp, ffmpeg] = await Promise.all([hasYtDlpReady(), getFfmpeg()]);
  return Response.json({
    available: true,
    // Si aún no está, se descarga en la primera petición.
    ready: ytdlp,
    ffmpeg: Boolean(ffmpeg),
    reason: null,
  });
}

export async function POST(req: NextRequest) {
  let body: { url?: string; format?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { url, format } = body;

  if (!url || !YOUTUBE_REGEX.test(url)) {
    return Response.json({ error: "URL de YouTube no válida" }, { status: 400 });
  }

  if (format !== "mp3" && format !== "mp4") {
    return Response.json({ error: "El formato debe ser mp3 o mp4" }, { status: 400 });
  }

  if (isServerless()) {
    return Response.json(
      { error: "La descarga de YouTube no está disponible en este despliegue (serverless)" },
      { status: 501 },
    );
  }

  let binaryPath: string;
  let title = "youtube";
  try {
    binaryPath = await getYtDlp();
    title = sanitize(await getTitle(binaryPath, url));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error inicializando yt-dlp";
    return Response.json({ error: `No se pudo leer el vídeo: ${message}` }, { status: 500 });
  }

  try {
    if (format === "mp4") {
      // Preferimos un mp4 progresivo único (vídeo + audio). Si no, el mejor disponible.
      const ytdlp = spawn(binaryPath, [
        ...COMMON_ARGS,
        "-f", "best[ext=mp4]/best",
        "--no-playlist",
        "-o", "-",
        "--quiet",
        "--no-warnings",
        url,
      ]);

      ytdlp.stderr.on("data", (d) => console.error("[yt-dlp]", d.toString()));

      return new Response(nodeStreamToWeb(ytdlp.stdout), {
        headers: {
          "Content-Type": "video/mp4",
          "Content-Disposition": contentDisposition(title, "mp4"),
          "Cache-Control": "no-store",
        },
      });
    }

    const ffmpegPath = await getFfmpeg();

    if (!ffmpegPath) {
      // Sin ffmpeg no podemos transcodificar: servimos el mejor audio tal cual
      // (normalmente m4a) en lugar de fallar. La UI avisa del cambio de formato.
      const ytdlp = spawn(binaryPath, [
        ...COMMON_ARGS,
        "-f", "bestaudio[ext=m4a]/bestaudio/best",
        "--no-playlist",
        "-o", "-",
        "--quiet",
        "--no-warnings",
        url,
      ]);

      ytdlp.stderr.on("data", (d) => console.error("[yt-dlp]", d.toString()));

      return new Response(nodeStreamToWeb(ytdlp.stdout), {
        headers: {
          "Content-Type": "audio/mp4",
          "Content-Disposition": contentDisposition(title, "m4a"),
          "Cache-Control": "no-store",
          "X-Farreo-Audio-Fallback": "m4a",
        },
      });
    }

    // MP3: yt-dlp emite el mejor audio -> ffmpeg lo transcodifica a mp3 192 kbps.
    const ytdlp = spawn(binaryPath, [
      ...COMMON_ARGS,
      "-f", "bestaudio/best",
      "--no-playlist",
      "-o", "-",
      "--quiet",
      "--no-warnings",
      url,
    ]);

    const ffmpeg = spawn(ffmpegPath, [
      "-i", "pipe:0",
      "-vn",
      "-f", "mp3",
      "-ab", "192k",
      "-loglevel", "error",
      "pipe:1",
    ]);

    ytdlp.stderr.on("data", (d) => console.error("[yt-dlp]", d.toString()));
    ffmpeg.stderr.on("data", (d) => console.error("[ffmpeg]", d.toString()));

    if (!ffmpeg.stdin || !ffmpeg.stdout) {
      return Response.json({ error: "ffmpeg no se inició correctamente" }, { status: 500 });
    }

    ytdlp.stdout.pipe(ffmpeg.stdin);
    ytdlp.stdout.on("error", () => ffmpeg.stdin.destroy());
    ffmpeg.stdin.on("error", () => { /* ignoramos EPIPE */ });

    return new Response(nodeStreamToWeb(ffmpeg.stdout), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": contentDisposition(title, "mp3"),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error durante la descarga";
    return Response.json({ error: message }, { status: 500 });
  }
}
