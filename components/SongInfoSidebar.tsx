"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeftIcon, ChevronRightIcon, ListMusicIcon, Maximize2Icon, Minimize2Icon, PauseIcon, PlayIcon } from "lucide-react";
import SongArtwork from "@/components/SongArtwork";
import { useMusicPlayer, useMusicPlayerTime, type MusicPlaylistSource } from "@/components/MusicPlayerProvider";
import { getMediaUrl } from "@/lib/radioApi";
import { parseSrt } from "@/lib/lyrics";

const SIDEBAR_VISIBILITY_KEY = "farreo-song-info-sidebar";

const formatTime = (seconds: number) => {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
};

const getSourceHref = (source: MusicPlaylistSource | null) => {
  if (!source) return null;
  if (source.type === "global") return `/playlist/${encodeURIComponent(source.id)}`;
  if (source.type === "private") return `/user-playlist/${encodeURIComponent(source.id)}`;
  return null;
};

const formatCreatedAt = (value: unknown) => {
  if (!value) return "Desconocida";

  let date: Date;
  if (typeof value === "string") {
    date = new Date(value);
  } else if (value instanceof Date) {
    date = value;
  } else if (typeof value === "object" && "seconds" in value) {
    const seconds = (value as { seconds?: unknown }).seconds;
    date = typeof seconds === "number" ? new Date(seconds * 1000) : new Date("");
  } else {
    date = new Date("");
  }

  if (Number.isNaN(date.getTime())) return "Desconocida";
  return date.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "2-digit" });
};

type LyricCueList = ReturnType<typeof parseSrt>;

// Ventana de lyrics memoizada: el panel se re-renderiza con cada tick del
// audio (~4 veces/segundo), pero esta lista (que puede tener cientos de
// nodos) solo debe repintarse cuando cambia la linea activa o la cancion.
const LyricsWindow = memo(function LyricsWindow({
  trackId,
  dynamicLyrics,
  staticLyrics,
  activeLyricIndex,
  autoFollow,
  onSeek,
}: {
  trackId: string;
  dynamicLyrics: LyricCueList;
  staticLyrics: string[];
  activeLyricIndex: number;
  autoFollow: boolean;
  onSeek: (val: number) => void;
}) {
  const activeLyricRef = useRef<HTMLButtonElement | null>(null);
  const lyricsWindowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!autoFollow || activeLyricIndex < 0) return;
    activeLyricRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeLyricIndex, autoFollow]);

  useEffect(() => {
    lyricsWindowRef.current?.scrollTo({ top: 0 });
  }, [trackId]);

  return (
    <div ref={lyricsWindowRef} className="song-info-sidebar__lyrics-window">
      {dynamicLyrics.length > 0 ? (
        dynamicLyrics.map((cue, index) => (
          <button
            type="button"
            key={cue.id}
            ref={index === activeLyricIndex ? activeLyricRef : null}
            className={`song-info-sidebar__lyric-line ${index === activeLyricIndex ? "song-info-sidebar__lyric-line--active" : ""}`}
            onClick={() => onSeek(cue.start)}
            title={`Ir a ${formatTime(cue.start)}`}
          >
            <small>{formatTime(cue.start)}</small>
            <span>{cue.text}</span>
          </button>
        ))
      ) : staticLyrics.length > 0 ? (
        <div className="song-info-sidebar__static-lyrics">
          {staticLyrics.map((line, index) => (
            <p key={`${line}-${index}`}>{line}</p>
          ))}
        </div>
      ) : (
        <p className="song-info-sidebar__empty">Sin lyrics disponibles para esta cancion.</p>
      )}
    </div>
  );
});

export default function SongInfoSidebar() {
  const { currentTrack, currentSource, duration, handleSeek, isPlaying, togglePlayPause } = useMusicPlayer();
  const { visualCurrentTime } = useMusicPlayerTime();
  const [open, setOpen] = useState(() => (
    typeof window === "undefined"
      ? true
      : window.localStorage.getItem(SIDEBAR_VISIBILITY_KEY) !== "closed"
  ));
  const [lyricsExpanded, setLyricsExpanded] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const dynamicLyrics = useMemo(() => parseSrt(currentTrack?.lyricsSrt), [currentTrack?.lyricsSrt]);
  const staticLyrics = useMemo(() => (
    currentTrack?.staticLyrics
      ?.replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean) || []
  ), [currentTrack?.staticLyrics]);
  const sourceHref = getSourceHref(currentSource);
  const activeLyricIndex = dynamicLyrics.findIndex((cue) => visualCurrentTime >= cue.start && visualCurrentTime <= cue.end);
  const advancedCoverUrl = currentTrack?.advancedCoverUrl ? getMediaUrl(currentTrack.advancedCoverUrl) : "";
  const advancedCoverIsVideo = Boolean(currentTrack?.advancedCoverType?.startsWith("video/"));

  const hidePanel = () => {
    window.localStorage.setItem(SIDEBAR_VISIBILITY_KEY, "closed");
    setOpen(false);
  };

  const showPanel = () => {
    window.localStorage.setItem(SIDEBAR_VISIBILITY_KEY, "open");
    setOpen(true);
  };

  if (!currentTrack) return null;

  if (!open) {
    return (
      <button
        type="button"
        className="song-info-sidebar song-info-sidebar--collapsed"
        onClick={showPanel}
        title="Ver cancion actual"
      >
        <ChevronLeftIcon size={20} />
      </button>
    );
  }

  return (
    <aside className="song-info-sidebar song-info-sidebar--open" aria-label="Informacion de la cancion actual">
      <header className="song-info-sidebar__header">
        <button type="button" onClick={hidePanel} title="Plegar panel">
          <ChevronRightIcon size={18} />
        </button>
        {sourceHref ? (
          <Link href={sourceHref} className="song-info-sidebar__header-link">
            {currentSource?.name || "Cancion actual"}
          </Link>
        ) : (
          <span>{currentSource?.name || "Cancion actual"}</span>
        )}
      </header>

      <div className="song-info-sidebar__body">
        {advancedCoverUrl ? (
          <div className="song-info-sidebar__advanced-cover">
            {advancedCoverIsVideo ? (
              <video src={advancedCoverUrl} autoPlay loop muted playsInline />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={advancedCoverUrl} alt="" loading="lazy" />
            )}
            <div className="song-info-sidebar__advanced-cover-info">
              <SongArtwork src={currentTrack.iconUrl} alt={currentTrack.name} className="song-info-sidebar__advanced-cover-artwork" />
              <div className="song-info-sidebar__advanced-cover-text">
                <h2>{currentTrack.name}</h2>
              </div>
            </div>
            <button
              type="button"
              className={`song-info-sidebar__play-toggle song-info-sidebar__play-toggle--floating ${isPlaying ? "song-info-sidebar__play-toggle--playing" : ""}`}
              onClick={togglePlayPause}
              title={isPlaying ? "Pausar" : "Reproducir"}
            >
              {isPlaying ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
            </button>
          </div>
        ) : (
          <SongArtwork src={currentTrack.iconUrl} alt={currentTrack.name} className="song-info-sidebar__artwork" />
        )}

        {!advancedCoverUrl && (
          <section className="song-info-sidebar__song">
            <div>
              <h2>{currentTrack.name}</h2>
            </div>
            <button
              type="button"
              className={`song-info-sidebar__play-toggle ${isPlaying ? "song-info-sidebar__play-toggle--playing" : ""}`}
              onClick={togglePlayPause}
              title={isPlaying ? "Pausar" : "Reproducir"}
            >
              {isPlaying ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
            </button>
          </section>
        )}

        <section className={`song-info-sidebar__lyrics ${lyricsExpanded ? "song-info-sidebar__lyrics--expanded" : ""}`}>
          <div className="song-info-sidebar__section-header">
            <span><ListMusicIcon size={17} /> Lyrics</span>
            <div>
              {dynamicLyrics.length > 0 && (
                <button
                  type="button"
                  className={autoFollow ? "song-info-sidebar__chip song-info-sidebar__chip--active" : "song-info-sidebar__chip"}
                  onClick={() => setAutoFollow((value) => !value)}
                >
                  Seguir
                </button>
              )}
              <button
                type="button"
                className="song-info-sidebar__icon-btn"
                onClick={() => setLyricsExpanded((value) => !value)}
                title={lyricsExpanded ? "Compactar lyrics" : "Expandir lyrics"}
              >
                {lyricsExpanded ? <Minimize2Icon size={15} /> : <Maximize2Icon size={15} />}
              </button>
            </div>
          </div>

          <LyricsWindow
            trackId={currentTrack.id}
            dynamicLyrics={dynamicLyrics}
            staticLyrics={staticLyrics}
            activeLyricIndex={activeLyricIndex}
            autoFollow={autoFollow}
            onSeek={handleSeek}
          />
        </section>

        <section className="song-info-sidebar__meta">
          <div>
            <span>Duracion</span>
            <strong>{duration > 0 ? formatTime(duration) : "Desconocida"}</strong>
          </div>
          <div>
            <span>Anadida a Farreo</span>
            <strong>{formatCreatedAt(currentTrack.createdAt)}</strong>
          </div>
        </section>
      </div>
    </aside>
  );
}
