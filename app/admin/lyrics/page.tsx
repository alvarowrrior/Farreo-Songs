"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { getAdminShortSong, heartbeatAdminShortClaim } from "@/lib/adminShorts";
import LyricsEditor from "@/components/LyricsEditor";

const ADMIN_EMAILS = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || "").split(",");

export default function AdminLyricsPage() {
  const [isChecking, setIsChecking] = useState(Boolean(auth));
  const [isAuthorized, setIsAuthorized] = useState(false);
  const autoSelectedRef = useRef(false);

  useEffect(() => {
    if (!auth) return;

    const unsub = onAuthStateChanged(auth, (user) => {
      setIsAuthorized(Boolean(user?.email && ADMIN_EMAILS.includes(user.email)));
      setIsChecking(false);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!isAuthorized) return;
    const params = new URLSearchParams(window.location.search);
    const songId = params.get("song");
    const sessionId = params.get("session");
    if (!songId || !sessionId) return;

    const keepAlive = () => {
      void heartbeatAdminShortClaim(songId, sessionId).catch(() => undefined);
    };
    keepAlive();
    const timer = window.setInterval(keepAlive, 30_000);
    return () => window.clearInterval(timer);
  }, [isAuthorized]);

  // Admin Shorts opens /admin/lyrics?song=<id>. LyricsEditor predates deep
  // links and owns its picker internally, so this small bridge waits until its
  // song list is rendered and selects the exact server-side song once. Normal
  // visits without ?song= remain completely unchanged.
  useEffect(() => {
    if (!isAuthorized || autoSelectedRef.current) return;
    const songId = new URLSearchParams(window.location.search).get("song");
    if (!songId) return;

    let cancelled = false;
    let observer: MutationObserver | null = null;
    let timeout = 0;

    void getAdminShortSong(songId)
      .then((targetSong) => {
        if (cancelled) return;

        const trySelect = () => {
          const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".lyrics-editor__song"));
          const button = buttons.find((item) => (
            item.querySelector(".lyrics-editor__song-name")?.textContent?.trim() === targetSong.name
          ));
          if (!button) return false;
          autoSelectedRef.current = true;
          observer?.disconnect();
          button.click();
          return true;
        };

        if (trySelect()) return;
        observer = new MutationObserver(() => {
          if (trySelect()) observer?.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        timeout = window.setTimeout(() => observer?.disconnect(), 12_000);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (timeout) window.clearTimeout(timeout);
    };
  }, [isAuthorized]);

  if (isChecking) {
    return <div className="lyrics-editor__gate">Comprobando acceso...</div>;
  }

  if (!isAuthorized) {
    return (
      <div className="lyrics-editor__gate">
        <p>Acceso restringido. Necesitas una cuenta de administrador.</p>
        <Link href="/admin" className="lyrics-editor__back">
          Volver
        </Link>
      </div>
    );
  }

  return <LyricsEditor />;
}
