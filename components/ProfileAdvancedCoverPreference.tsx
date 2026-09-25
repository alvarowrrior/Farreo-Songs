"use client";

import { useEffect, useState } from "react";
import { FilmIcon } from "lucide-react";
import {
  ADVANCED_COVER_SYNC_CHANGE_EVENT,
  ADVANCED_COVER_SYNC_STORAGE_KEY,
  DEFAULT_ADVANCED_COVER_SYNC,
  getAdvancedCoverSyncEnabled,
  setAdvancedCoverSyncEnabled,
} from "@/lib/advancedCoverPlaybackPreference";
import styles from "./ProfileDiscPreference.module.scss";

const OPTIONS = [
  {
    value: true,
    title: "SINCRONIZADAS",
    detail: "Pausa GIF/MP4 con la canción, ajusta su velocidad al pitch y, si el panel derecho ya está abierto, espera a que su contenido visual esté listo antes de reproducir. Activado por defecto.",
  },
  {
    value: false,
    title: "INDEPENDIENTES",
    detail: "Mantiene las portadas animadas reproduciéndose siempre a velocidad normal, como antes.",
  },
] as const;

export default function ProfileAdvancedCoverPreference() {
  const [enabled, setEnabled] = useState(DEFAULT_ADVANCED_COVER_SYNC);

  useEffect(() => {
    const refresh = () => setEnabled(getAdvancedCoverSyncEnabled());
    const onStorage = (event: StorageEvent) => {
      if (event.key === ADVANCED_COVER_SYNC_STORAGE_KEY) refresh();
    };

    refresh();
    window.addEventListener(ADVANCED_COVER_SYNC_CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener(ADVANCED_COVER_SYNC_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return (
    <section className={styles.card} aria-labelledby="advanced-cover-playback-title">
      <div className={styles.heading}>
        <span><FilmIcon size={20} /></span>
        <div>
          <h2 id="advanced-cover-playback-title">Portadas animadas</h2>
          <p>Preferencia local para PC. Controla GIF y vídeo de las portadas avanzadas del panel derecho.</p>
        </div>
      </div>

      <div className={styles.options} role="radiogroup" aria-label="Comportamiento de las portadas animadas">
        {OPTIONS.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={enabled === option.value}
            className={`${styles.option} ${enabled === option.value ? styles.optionActive : ""}`}
            onClick={() => {
              setEnabled(option.value);
              setAdvancedCoverSyncEnabled(option.value);
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
