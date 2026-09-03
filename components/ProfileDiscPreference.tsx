"use client";

import { useEffect, useState } from "react";
import { Disc3Icon } from "lucide-react";
import {
  DEFAULT_DISC_VISUAL_MODE,
  DISC_VISUAL_CHANGE_EVENT,
  DISC_VISUAL_STORAGE_KEY,
  getDiscVisualMode,
  setDiscVisualMode,
  type DiscVisualMode,
} from "@/lib/discVisualPreference";
import styles from "./ProfileDiscPreference.module.scss";

const OPTIONS: Array<{
  value: DiscVisualMode;
  title: string;
  detail: string;
}> = [
  {
    value: "always",
    title: "SIEMPRE",
    detail: "Muestra un disco pequeño en la página de Radio y el disco de fondo en playlists globales, personales, selecciones semanales y álbumes.",
  },
  {
    value: "album",
    title: "SOLO ÁLBUM",
    detail: "Comportamiento actual y predeterminado: el disco aparece únicamente al reproducir el álbum abierto.",
  },
  {
    value: "never",
    title: "NUNCA",
    detail: "No renderiza el disco en ninguna página, tampoco dentro de los álbumes.",
  },
];

export default function ProfileDiscPreference() {
  const [mode, setMode] = useState<DiscVisualMode>(DEFAULT_DISC_VISUAL_MODE);

  useEffect(() => {
    setMode(getDiscVisualMode());

    const onChange = () => setMode(getDiscVisualMode());
    const onStorage = (event: StorageEvent) => {
      if (event.key === DISC_VISUAL_STORAGE_KEY) onChange();
    };

    window.addEventListener(DISC_VISUAL_CHANGE_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(DISC_VISUAL_CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return (
    <section className={styles.card} aria-labelledby="disc-visual-title">
      <div className={styles.heading}>
        <span><Disc3Icon size={20} /></span>
        <div>
          <h2 id="disc-visual-title">Visual del disco</h2>
          <p>Preferencia local de este navegador. No modifica tu cuenta ni otros dispositivos.</p>
        </div>
      </div>

      <div className={styles.options} role="radiogroup" aria-label="Cuándo mostrar el disco">
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={mode === option.value}
            className={`${styles.option} ${mode === option.value ? styles.optionActive : ""}`}
            onClick={() => {
              setMode(option.value);
              setDiscVisualMode(option.value);
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
