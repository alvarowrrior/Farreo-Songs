"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { onAuthStateChanged } from "firebase/auth";
import {
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  ListMusicIcon,
  PencilIcon,
  Share2Icon,
} from "lucide-react";
import FarreoContextMenu, { type FarreoContextMenuItem } from "@/components/FarreoContextMenu";
import { auth } from "@/lib/firebase";
import { addSongToPrivatePlaylist, listOwnPrivatePlaylists, type PrivatePlaylist } from "@/lib/privatePlaylists";
import { getMediaUrl, type ApiSong } from "@/lib/radioApi";
import { listAdminSongs } from "@/lib/songThemes";

interface SongRowBinding {
  key: string;
  row: HTMLElement;
  actions: HTMLElement;
}

interface SongMenuState {
  x: number;
  y: number;
  row: HTMLElement;
  song: ApiSong | null;
}

const normalize = (value: string) => value.trim().toLocaleLowerCase("es");

const formatDuration = (value?: number | null) => {
  if (!value || !Number.isFinite(value) || value <= 0) return "";
  const total = Math.floor(value);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const safeFileName = (value: string) => (
  value.replace(/[\\/:*?"<>|]+/g, "_").trim() || "cancion"
);

const audioExtension = (song: ApiSong) => {
  const candidate = `${song.id} ${song.url}`.match(/\.(mp3|m4a|wav|ogg|flac|aac)(?:\?|#|\s|$)/i)?.[1];
  return candidate ? `.${candidate.toLowerCase()}` : ".mp3";
};

export default function AdminSongContextEnhancer() {
  const [songs, setSongs] = useState<ApiSong[]>([]);
  const [privatePlaylists, setPrivatePlaylists] = useState<PrivatePlaylist[]>([]);
  const [bindings, setBindings] = useState<SongRowBinding[]>([]);
  const [menu, setMenu] = useState<SongMenuState | null>(null);

  useEffect(() => {
    if (!auth) return;
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        setSongs([]);
        setPrivatePlaylists([]);
        return;
      }
      void listAdminSongs().then(setSongs).catch(() => setSongs([]));
      void listOwnPrivatePlaylists(user.uid).then(setPrivatePlaylists).catch(() => setPrivatePlaylists([]));
    });
    return () => unsubscribe();
  }, []);

  const resolveSong = useCallback((row: HTMLElement) => {
    const titleElement = row.querySelector<HTMLElement>(".playlist-admin__item-title");
    const directTitle = titleElement
      ? Array.from(titleElement.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join("")
        .trim()
      : "";
    // Hidden admin rows render the badge "Oculta" inside the same title span.
    // Reading textContent therefore produced "SongOculta" and the enhancer
    // could not resolve the underlying admin song. Only use direct text nodes.
    const title = directTitle || titleElement?.textContent?.replace(/\s*Oculta\s*$/i, "").trim() || "";
    if (!title) return null;

    const candidates = songs.filter((song) => normalize(song.name) === normalize(title));
    if (candidates.length <= 1) return candidates[0] || null;

    const rowText = row.textContent || "";
    const byDuration = candidates.filter((song) => {
      const duration = formatDuration(song.duration);
      return Boolean(duration && rowText.includes(duration));
    });
    if (byDuration.length === 1) return byDuration[0];

    const imageSrc = row.querySelector<HTMLImageElement>("img")?.src || "";
    const byArtwork = candidates.filter((song) => {
      if (!song.iconUrl) return false;
      const fileName = String(song.iconUrl).split("/").pop()?.split("?")[0] || "";
      return Boolean(fileName && imageSrc.includes(fileName));
    });
    return byArtwork[0] || byDuration[0] || candidates[0] || null;
  }, [songs]);

  useEffect(() => {
    let sequence = 0;
    const scan = () => {
      const next: SongRowBinding[] = [];
      document.querySelectorAll<HTMLElement>(".playlist-admin__item").forEach((row) => {
        const edit = row.querySelector<HTMLButtonElement>('button[title="Editar canción"]');
        const actions = edit?.closest<HTMLElement>(".playlist-admin__item-actions");
        if (!edit || !actions) return;
        let key = row.dataset.adminSongEnhancerKey;
        if (!key) {
          sequence += 1;
          key = `admin-song-row-${Date.now()}-${sequence}`;
          row.dataset.adminSongEnhancerKey = key;
        }
        next.push({ key, row, actions });
      });
      setBindings((current) => {
        if (
          current.length === next.length
          && current.every((item, index) => item.row === next[index]?.row && item.actions === next[index]?.actions)
        ) return current;
        return next;
      });
    };

    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleContext = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest<HTMLElement>(".playlist-admin__item");
      if (!row?.querySelector('button[title="Editar canción"]')) return;
      event.preventDefault();
      event.stopPropagation();
      setMenu({
        x: event.clientX,
        y: event.clientY,
        row,
        song: resolveSong(row),
      });
    };
    document.addEventListener("contextmenu", handleContext, true);
    return () => document.removeEventListener("contextmenu", handleContext, true);
  }, [resolveSong]);

  const downloadSong = useCallback(async (song: ApiSong | null) => {
    if (!song?.url) {
      window.alert("No se pudo identificar la canción para descargarla.");
      return;
    }
    try {
      const response = await fetch(getMediaUrl(song.url));
      if (!response.ok) throw new Error("download failed");
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${safeFileName(song.name)}${audioExtension(song)}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      window.alert("No se pudo descargar la canción desde el servidor.");
    }
  }, []);

  const clickExistingAction = (row: HTMLElement, selector: string) => {
    row.querySelector<HTMLButtonElement>(selector)?.click();
  };

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      window.alert("No se pudo copiar el enlace.");
    }
  };

  const menuItems = useMemo<FarreoContextMenuItem[]>(() => {
    if (!menu) return [];
    const { row, song } = menu;
    const visibilityButton = row.querySelector<HTMLButtonElement>('button[title^="Ocultar"], button[title^="Mostrar"]');
    const existingShareButton = row.querySelector<HTMLButtonElement>('button[title="Compartir enlace de reproduccion"]');
    const isHidden = Boolean(visibilityButton?.title.startsWith("Mostrar"));

    return [
      {
        label: "Compartir",
        icon: <Share2Icon size={15} />,
        onSelect: () => undefined,
        children: [
          {
            label: song ? "Copiar enlace de Farreo" : "Abrir compartir",
            onSelect: () => song
              ? void copyText(`${window.location.origin}/play/${encodeURIComponent(song.id)}`)
              : existingShareButton?.click(),
            disabled: !song && !existingShareButton,
          },
          {
            label: "Copiar enlace MP3",
            onSelect: () => song ? void copyText(getMediaUrl(song.url)) : undefined,
            disabled: !song?.url,
          },
        ],
      },
      {
        label: "Añadir a playlist",
        icon: <ListMusicIcon size={15} />,
        disabled: !song || privatePlaylists.length === 0,
        onSelect: () => undefined,
        children: privatePlaylists.map((playlist) => ({
          label: playlist.nombre,
          onSelect: () => song
            ? void addSongToPrivatePlaylist(playlist.id, song.id).catch(() => window.alert("No se pudo añadir la canción."))
            : undefined,
        })),
      },
      {
        label: "Descargar canción",
        icon: <DownloadIcon size={15} />,
        disabled: !song?.url,
        onSelect: () => void downloadSong(song),
      },
      {
        label: "Editar formulario",
        icon: <PencilIcon size={15} />,
        onSelect: () => clickExistingAction(row, 'button[title="Editar canción"]'),
      },
      ...(visibilityButton ? [{
        label: isHidden ? "Mostrar a todos" : "Ocultar canción",
        icon: isHidden ? <EyeIcon size={15} /> : <EyeOffIcon size={15} />,
        onSelect: () => visibilityButton.click(),
      } satisfies FarreoContextMenuItem] : []),
    ];
  }, [downloadSong, menu, privatePlaylists]);

  return (
    <>
      {bindings.map(({ key, row, actions }) => createPortal(
        <button
          key={`${key}-download`}
          type="button"
          className="playlist-admin__item-edit"
          title="Descargar canción"
          aria-label="Descargar canción"
          onClick={(event) => {
            event.stopPropagation();
            void downloadSong(resolveSong(row));
          }}
        >
          <DownloadIcon size={16} />
        </button>,
        actions,
        `${key}-download-portal`,
      ))}

      {menu && (
        <FarreoContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
