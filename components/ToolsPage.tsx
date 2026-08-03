"use client";

import { useEffect, useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import { DownloadIcon, SlidersHorizontalIcon, VideoIcon } from "lucide-react";
import { downloadBlob } from "@/lib/tools/mp3";
import { auth } from "@/lib/firebase";
import { MUSIC_API_URL } from "@/lib/radioApi";

// El estudio arrastra soundtouchjs y lamejs: fuera del bundle inicial y sin SSR
// (todo su motor depende de Web Audio).
const AudioStudio = dynamic(() => import("@/components/tools/AudioStudio"), {
  ssr: false,
  loading: () => <p className="tools-status">Cargando el estudio…</p>,
});

type Tab = "youtube" | "studio";

interface DownloadAvailability {
  available: boolean;
  ready?: boolean;
  ffmpeg: boolean;
  reason: string | null;
}

// De dónde sale la descarga. El servidor de música es el único camino que
// funciona en producción; la ruta de Next solo sirve en desarrollo local.
type Backend =
  | { kind: "server"; ffmpeg: boolean }
  | { kind: "local"; ffmpeg: boolean }
  | { kind: "none"; reason: string }
  | null;

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "youtube", label: "Desde YouTube", icon: <VideoIcon size={16} /> },
  { id: "studio", label: "Estudio", icon: <SlidersHorizontalIcon size={16} /> },
];

function filenameFromResponse(res: Response, fallback: string) {
  const disposition = res.headers.get("Content-Disposition") || "";
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const asciiMatch = disposition.match(/filename="([^"]+)"/);
  if (utf8Match) return decodeURIComponent(utf8Match[1]);
  if (asciiMatch) return asciiMatch[1];
  return fallback;
}

export default function ToolsPage() {
  const [tab, setTab] = useState<Tab>("youtube");

  return (
    <div className="tools-page">
      <header className="tools-page__header">
        <h1 className="tools-page__title">Herramientas</h1>
        <p className="tools-page__subtitle">
          Descarga vídeos de YouTube o transforma audio en el estudio.
        </p>
      </header>

      <div className="tools-page__tabs" role="tablist" aria-label="Herramientas disponibles">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`tools-page__tab ${tab === item.id ? "tools-page__tab--active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      <section className={`tools-page__panel ${tab === "studio" ? "tools-page__panel--wide" : ""}`}>
        {tab === "youtube" ? <YoutubeTool /> : <AudioStudio />}
      </section>
    </div>
  );
}

function YoutubeTool() {
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<"mp3" | "mp4">("mp4");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [backend, setBackend] = useState<Backend>(null);

  useEffect(() => {
    let cancelled = false;

    const detect = async (): Promise<Backend> => {
      // 1) El servidor de música: el único que funciona desplegado.
      try {
        const res = await fetch(`${MUSIC_API_URL}/youtube/status`);
        if (res.ok) {
          const data = (await res.json()) as DownloadAvailability;
          if (data.available) return { kind: "server", ffmpeg: Boolean(data.ffmpeg) };
          if (data.reason) return { kind: "none", reason: data.reason };
        }
      } catch {
        // Servidor apagado o inalcanzable: probamos la ruta local.
      }

      // 2) La ruta de Next, que solo sirve ejecutando Farreo en local.
      try {
        const res = await fetch("/api/tools/download");
        if (res.ok) {
          const data = (await res.json()) as DownloadAvailability;
          if (data.available) return { kind: "local", ffmpeg: Boolean(data.ffmpeg) };
          return { kind: "none", reason: data.reason || "No disponible." };
        }
      } catch {
        // sin nada más que probar
      }

      return {
        kind: "none",
        reason:
          "No se ha podido contactar con el servidor de música y esta instalación no puede descargar por su cuenta.",
      };
    };

    void detect().then((result) => {
      if (!cancelled) setBackend(result);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!backend || backend.kind === "none") return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      let endpoint = "/api/tools/download";

      if (backend.kind === "server") {
        const user = auth?.currentUser;
        if (!user) throw new Error("Inicia sesión para descargar desde el servidor.");
        headers.Authorization = `Bearer ${await user.getIdToken()}`;
        endpoint = `${MUSIC_API_URL}/youtube/download`;
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ url, format }),
      });

      if (!res.ok) {
        if (res.status === 401) throw new Error("Inicia sesión para usar esta herramienta.");
        if (res.status === 403) {
          throw new Error("Solo los administradores pueden descargar desde el servidor.");
        }
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Error al descargar");
      }

      if (res.headers.get("X-Farreo-Audio-Fallback") === "m4a") {
        setNotice("Sin ffmpeg en el servidor: se ha descargado el audio original en M4A en vez de MP3.");
      }
      const filename = filenameFromResponse(res, `youtube.${format}`);
      downloadBlob(await res.blob(), filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  }

  const unavailable = backend?.kind === "none";

  return (
    <form className="tools-form" onSubmit={handleSubmit}>
      {unavailable && backend?.kind === "none" && (
        <div className="tools-notice tools-notice--warning">
          <strong>No disponible aquí.</strong> {backend.reason}
        </div>
      )}

      {backend?.kind === "server" && (
        <p className="tools-hint">
          La descarga la hace el servidor de música. Necesitas haber iniciado sesión como
          administrador.
        </p>
      )}

      <div className="tools-field">
        <label htmlFor="yt-url">URL de YouTube</label>
        <input
          id="yt-url"
          type="text"
          placeholder="https://www.youtube.com/watch?v=..."
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={loading || unavailable}
          required
        />
      </div>

      <div className="tools-field">
        <label>Formato</label>
        <div className="tools-radio-group">
          <label className="tools-radio">
            <input
              type="radio"
              name="format"
              value="mp4"
              checked={format === "mp4"}
              onChange={() => setFormat("mp4")}
              disabled={loading || unavailable}
            />
            <span>MP4 (vídeo)</span>
          </label>
          <label className="tools-radio">
            <input
              type="radio"
              name="format"
              value="mp3"
              checked={format === "mp3"}
              onChange={() => setFormat("mp3")}
              disabled={loading || unavailable}
            />
            <span>MP3 (audio)</span>
          </label>
        </div>
      </div>

      {format === "mp3" && backend !== null && backend.kind !== "none" && !backend.ffmpeg && (
        <p className="tools-hint">
          No se ha encontrado ffmpeg en el servidor: el audio se descargará en M4A sin
          transcodificar. Instala ffmpeg o define <code>FFMPEG_PATH</code> para obtener MP3.
        </p>
      )}

      <button
        type="submit"
        className="tools-btn tools-btn--primary tools-btn--block"
        disabled={loading || !url || unavailable}
      >
        <DownloadIcon size={16} />
        {loading ? "Procesando…" : "Descargar"}
      </button>

      {notice && <div className="tools-notice">{notice}</div>}
      {error && <div className="tools-error">{error}</div>}
      <p className="tools-hint">
        Uso personal. Respeta los derechos de autor del contenido y los términos de YouTube.
      </p>
    </form>
  );
}
