"use client";

import { useEffect, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { getFarreoNativeAudio } from "@/lib/nativeAudio";
import styles from "./MobileAppUpdateLegacyFeedback.module.scss";

/**
 * Migration UX: existing APKs (up to build 21) already download updates natively
 * but cannot report download bytes to the WebView. Give those users an honest
 * indeterminate progress indicator for their first upgrade to build 22.
 *
 * Build 22+ displays a real, byte-counted progress dialog in the native plugin,
 * so it deliberately never mounts this legacy overlay.
 */
export default function MobileAppUpdateLegacyFeedback() {
  const [legacyNative, setLegacyNative] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    let active = true;
    const native = getFarreoNativeAudio();
    if (!native) return;
    void native.getAppInfo().then((info) => {
      if (active) setLegacyNative(info.build < 22);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!legacyNative) return;

    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest(".mobile-farreo__update-layer .mobile-farreo__update-primary")) return;
      setShow(true);
    };
    const onVisibility = () => {
      // Android's permission screen / package installer takes foreground.
      if (document.visibilityState === "hidden") setShow(false);
    };
    window.addEventListener("click", onClick, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("click", onClick, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [legacyNative]);

  useEffect(() => {
    if (!show) return;
    // Legacy APKs do not expose an error/completion event. Never leave the
    // display stuck indefinitely if the native download fails or is interrupted.
    const timeout = window.setTimeout(() => setShow(false), 180_000);
    return () => window.clearTimeout(timeout);
  }, [show]);

  if (!show || !legacyNative) return null;
  return (
    <div className={styles.layer}>
      <section className={styles.card} role="dialog" aria-modal="true" aria-labelledby="farreo-legacy-update-title">
        <DownloadIcon size={32} className={styles.icon} />
        <h2 id="farreo-legacy-update-title">Descargando actualización</h2>
        <p>No cierres Farreo hasta que aparezca el instalador de Android.</p>
        <div
          className={styles.progress}
          role="progressbar"
          aria-label="Descargando la nueva versión"
          aria-valuetext="Descarga en curso. Porcentaje no disponible en esta versión de Farreo."
        >
          <span />
        </div>
        <small>La versión actual no permite mostrar el porcentaje exacto. Las próximas actualizaciones sí lo mostrarán.</small>
        <button type="button" onClick={() => setShow(false)}>Ocultar progreso</button>
      </section>
    </div>
  );
}
