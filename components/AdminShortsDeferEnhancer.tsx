"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCwIcon, SkipForwardIcon } from "lucide-react";
import { useMusicPlayer } from "@/components/MusicPlayerProvider";
import {
  getAdminShortsSessionId,
  releaseAdminShortClaim,
  rememberDeferredAdminShort,
} from "@/lib/adminShorts";

function findNavigationHost() {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>("[data-admin-shorts-interactive='true']"),
  );

  const navigation = candidates.find((element) => {
    const directButtons = Array.from(element.children)
      .filter((child): child is HTMLButtonElement => child instanceof HTMLButtonElement);

    return (
      directButtons.length === 2
      && directButtons.every((button) => !button.textContent?.trim())
      && Boolean(element.closest("section"))
    );
  });

  if (!navigation) return null;

  let host = navigation.querySelector<HTMLElement>("[data-admin-shorts-defer-host]");
  if (!host) {
    host = document.createElement("span");
    host.dataset.adminShortsDeferHost = "true";
    host.style.display = "contents";
    navigation.appendChild(host);
  }

  return host;
}

export default function AdminShortsDeferEnhancer() {
  const { currentTrack, currentSource } = useMusicPlayer();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [deferring, setDeferring] = useState(false);

  useEffect(() => {
    const resolve = () => setHost(findNavigationHost());
    resolve();

    const observer = new MutationObserver(resolve);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, []);

  const round = useMemo(() => {
    const id = currentSource?.type === "admin" ? currentSource.id : "";
    const match = id.match(/^admin-shorts-(\d+)$/);
    return match ? Number(match[1]) : null;
  }, [currentSource]);

  const deferCurrent = async () => {
    if (deferring) return;

    const section = host?.closest("section");
    if (!section || !currentTrack || currentSource?.type !== "admin" || round === null) {
      window.alert("No se pudo identificar la canción actual de Admin Shorts.");
      return;
    }

    const visibleText = section.textContent || "";

    if (visibleText.includes("sin aplicar")) {
      window.alert("Aplica o descarta los cambios de esta canción antes de pasarla para más tarde.");
      return;
    }

    if (visibleText.includes("revisada en sesión")) {
      window.alert("Esta canción ya se marcó como revisada en esta ronda y no se puede devolver a pendiente desde este botón.");
      return;
    }

    setDeferring(true);
    try {
      const sessionId = getAdminShortsSessionId();

      // Solo se libera la reserva. No se llama al endpoint que marca la canción
      // como pasada, así que pasada_admin_short permanece intacta.
      await releaseAdminShortClaim(currentTrack.id, sessionId);
      rememberDeferredAdminShort(currentTrack.id, sessionId, round);

      // El componente principal guarda el historial de revisadas en estado
      // interno. Un remount corto lo reconstruye limpiamente sin contaminar ese
      // historial con la canción que acabamos de posponer.
      window.location.reload();
    } catch (error) {
      setDeferring(false);
      window.alert(error instanceof Error ? error.message : "No se pudo pasar la canción para más tarde.");
    }
  };

  if (!host) return null;

  return createPortal(
    <button
      type="button"
      onClick={() => void deferCurrent()}
      disabled={deferring}
      title="Pasar por ahora · no marcar como revisada"
      aria-label="Pasar esta canción por ahora sin marcarla como revisada"
      style={{
        color: deferring ? "rgba(255,255,255,.45)" : "#ffc46b",
        borderColor: "rgba(255, 181, 79, .22)",
        background: "rgba(88, 52, 14, .28)",
      }}
    >
      {deferring ? <RefreshCwIcon size={18} /> : <SkipForwardIcon size={18} />}
    </button>,
    host,
  );
}
