"use client";

import { useEffect, useState } from "react";
import { RadioIcon } from "lucide-react";
import {
  DEFAULT_YOUTUBE_RADIO_BACKGROUND_ENABLED,
  YOUTUBE_RADIO_BACKGROUND_CHANGE_EVENT,
  YOUTUBE_RADIO_BACKGROUND_STORAGE_KEY,
  getYoutubeRadioBackgroundEnabled,
  setYoutubeRadioBackgroundEnabled,
} from "@/lib/youtubeVideoBackgroundPreference";
import styles from "./ProfileDiscPreference.module.scss";

const OPTIONS = [
  {
    value: true,
    title: "MOSTRAR",
    detail: "Permite videoclips de fondo mientras escuchas Radio en PC.",
  },
  {
    value: false,
    title: "OCULTAR",
    detail: "Nunca carga fondos de YouTube dentro de Radio en este navegador.",
  },
] as const;

export default function ProfileYoutubeRadioBackgroundPreference() {
  const [enabled, setEnabled] = useState(
    DEFAULT_YOUTUBE_RADIO_BACKGROUND_ENABLED,
  );

  useEffect(() => {
    const refresh = () => setEnabled(getYoutubeRadioBackgroundEnabled());
    const onStorage = (event: StorageEvent) => {
      if (event.key === YOUTUBE_RADIO_BACKGROUND_STORAGE_KEY) refresh();
    };

    refresh();
    window.addEventListener(YOUTUBE_RADIO_BACKGROUND_CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener(YOUTUBE_RADIO_BACKGROUND_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return (
    <section className={styles.card} aria-labelledby="youtube-radio-background-title">
      <div className={styles.heading}>
        <span><RadioIcon size={20} /></span>
        <div>
          <h2 id="youtube-radio-background-title">Fondos YouTube en Radio</h2>
          <p>Preferencia local de este navegador. Solo afecta a la vista de Radio en PC.</p>
        </div>
      </div>

      <div className={styles.options} role="radiogroup" aria-label="Fondos de videoclip en Radio">
        {OPTIONS.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={enabled === option.value}
            className={`${styles.option} ${enabled === option.value ? styles.optionActive : ""}`}
            onClick={() => {
              setEnabled(option.value);
              setYoutubeRadioBackgroundEnabled(option.value);
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
