"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { ZapIcon } from "lucide-react";
import styles from "@/components/AdminShorts.module.scss";

export default function AdminShortsEntry() {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let attempts = 0;
    let mount: HTMLSpanElement | null = null;

    const attach = () => {
      if (cancelled) return;
      const lyricsLink = document.querySelector<HTMLElement>(".playlist-admin__lyrics-editor-link");
      if (!lyricsLink?.parentElement) {
        attempts += 1;
        if (attempts < 75) timer = window.setTimeout(attach, 80);
        return;
      }

      mount = document.createElement("span");
      mount.className = styles.adminEntryMount;
      lyricsLink.insertAdjacentElement("afterend", mount);
      setTarget(mount);
    };

    attach();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      mount?.remove();
    };
  }, []);

  if (!target) return null;
  return createPortal(
    <Link href="/admin/shorts" className={styles.adminEntryLink}>
      <ZapIcon size={17} fill="currentColor" /> Admin Shorts
    </Link>,
    target,
  );
}
