"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import styles from "./OfflineServiceWorker.module.scss";

/** Envia al service worker los recursos que ha cargado esta pagina para guardarlos. */
export function cacheLoadedResources(extra: string[] = []) {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready.then((registration) => {
    const urls = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          const url = new URL(name);
          return url.origin === window.location.origin && url.pathname.startsWith("/_next/static/");
        } catch {
          return false;
        }
      });
    registration.active?.postMessage({ type: "farreo-cache-urls", urls: [...new Set([...extra, ...urls])] });
  });
}

// Registra el service worker del modo sin conexion (solo en produccion, para no
// interferir con la recarga en caliente de `next dev`) y avisa si se pierde la red.
export default function OfflineServiceWorker() {
  const router = useRouter();
  const pathname = usePathname();
  const [lostConnection, setLostConnection] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;

    let timer: number | undefined;
    const onLoad = () => {
      navigator.serviceWorker.register("/sw.js").catch((error) => {
        console.warn("No se pudo activar el modo sin conexion:", error);
      });
      // Precarga /offline para que su codigo quede guardado aunque no se visite.
      router.prefetch("/offline");
      timer = window.setTimeout(() => cacheLoadedResources(["/offline"]), 4000);
    };

    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });

    return () => {
      window.removeEventListener("load", onLoad);
      if (timer) window.clearTimeout(timer);
    };
  }, [router]);

  useEffect(() => {
    const goneOffline = () => setLostConnection(true);
    const backOnline = () => setLostConnection(false);
    window.addEventListener("offline", goneOffline);
    window.addEventListener("online", backOnline);
    return () => {
      window.removeEventListener("offline", goneOffline);
      window.removeEventListener("online", backOnline);
    };
  }, []);

  if (!lostConnection || pathname.startsWith("/offline")) return null;

  return (
    <div className={styles.toast} role="status">
      <span>Te has quedado sin conexion</span>
      <a href="/offline">Musica descargada</a>
      <button type="button" onClick={() => setLostConnection(false)} aria-label="Cerrar">×</button>
    </div>
  );
}
