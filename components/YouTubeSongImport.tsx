"use client";

import { useState } from "react";
import { LoaderCircleIcon, PlusIcon, PlayIcon } from "lucide-react";
import { type ApiSong } from "@/lib/radioApi";
import { importYoutubeTrack, youtubeVideoId } from "@/lib/youtubeTracks";
import styles from "./YouTubeSongImport.module.scss";

type Props = {
  value: string;
  label?: string;
  onImported: (song: ApiSong) => Promise<void> | void;
};

/** Inline action only visible when the search field contains a YouTube URL. */
export default function YouTubeSongImport({ value, label = "Añadir desde YouTube", onImported }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoId = youtubeVideoId(value);
  if (!videoId) return null;

  const handleImport = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const song = await importYoutubeTrack(value.trim());
      await onImported(song);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo importar el video de YouTube.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.container}>
      <button className={styles.button} type="button" onClick={() => void handleImport()} disabled={busy}>
        {busy ? <LoaderCircleIcon size={17} className={styles.spinner} /> : <PlayIcon size={18} />}
        <span>{busy ? "Leyendo canción y letras..." : label}</span>
        {!busy && <PlusIcon size={16} />}
      </button>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}
