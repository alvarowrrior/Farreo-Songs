"use client";

import { useEffect, useState } from "react";
import { FilmIcon } from "lucide-react";
import {
  DEFAULT_YOUTUBE_VIDEO_WAIT_FOR_READY,
  YOUTUBE_VIDEO_WAIT_FOR_READY_CHANGE_EVENT,
  YOUTUBE_VIDEO_WAIT_FOR_READY_STORAGE_KEY,
  getYoutubeVideoWaitForReady,
  setYoutubeVideoWaitForReady,
} from "@/lib/youtubeVideoBackgroundPreference";
import styles from "./ProfileDiscPreference.module.scss";

const OPTIONS = [
  {
    value: false,
    title: "REPRODUCIR SIN ESPERAR",
    detail: "La música comienza sin esperar al videoclip de fondo. El vídeo carga en segundo plano y se sincroniza con la canción al estar listo. Recomendado y predeterminado.",
  },
  {
    value: true,
    title: "ESPERAR AL VIDEOCLIP",
    detail: "Antes de reproducir, espera a que el videoclip de fondo esté preparado (máximo 7 segundos), como hasta ahora.",
  },
] as const;

export default function ProfileYoutubeVideoStartPreference() {
  const [waitForVideo, setWaitForVideo] = useState(DEFAULT_YOUTUBE_VIDEO_WAIT_FOR_READY);

  useEffect(() => {
    const refresh = () => setWaitForVideo(getYoutubeVideoWaitForReady());
    const onStorage = (event: StorageEvent) => {
      if (event.key === YOUTUBE_VIDEO_WAIT_FOR_READY_STORAGE_KEY) refresh();
    };

    refresh();
    window.addEventListener(YOUTUBE_VIDEO_WAIT_FOR_READY_CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(YOUTUBE_VIDEO_WAIT_FOR_READY_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return (
    <section className={styles.card} aria-labelledby="youtube-video-start-title">
      <div className={styles.heading}>
        <span><FilmIcon size={20} /></span>
        <div>
          <h2 id="youtube-video-start-title">Esperar al videoclip de fondo</h2>
          <p>Preferencia local para PC. Solo afecta al inicio de canciones con fondo de YouTube; no modifica la Radio ni las portadas animadas.</p>
        </div>
      </div>

      <div className={styles.options} role="radiogroup" aria-label="Esperar al videoclip antes de reproducir">
        {OPTIONS.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={waitForVideo === option.value}
            className={`${styles.option} ${waitForVideo === option.value ? styles.optionActive : ""}`}
            onClick={() => {
              setWaitForVideo(option.value);
              setYoutubeVideoWaitForReady(option.value);
            }}
          >
            <span className={styles.radioMark}><i /></span>
            <span>
              <strong>{option.title}</strong>
              <small>{option.detail}</small>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
