"use client";

import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { ArrowRightIcon, DicesIcon, ShuffleIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { usePathname } from "next/navigation";

export interface MusicTrack {
  id: string;
  name: string;
  url?: string;
  variantes?: string[];
}

interface MusicPlayerContextValue {
  currentTrack: MusicTrack | null;
  isPlaying: boolean;
  playQueue: (tracks: MusicTrack[], index: number) => void;
  toggleTrack: (track: MusicTrack, tracks?: MusicTrack[]) => void;
}

const MusicPlayerContext = createContext<MusicPlayerContextValue | null>(null);

export function useMusicPlayer() {
  const context = useContext(MusicPlayerContext);
  if (!context) {
    throw new Error("useMusicPlayer debe usarse dentro de MusicPlayerProvider");
  }
  return context;
}

const formatTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec < 10 ? "0" : ""}${sec}`;
};

export default function MusicPlayerProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<MusicTrack[]>([]);
  const [currentTrack, setCurrentTrack] = useState<MusicTrack | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackPitch, setPlaybackPitch] = useState(1);
  const [volume, setVolume] = useState(0.8);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isShuffle, setIsShuffle] = useState(true);
  const [autoRandomPitch, setAutoRandomPitch] = useState(true);

  const startTrack = (track: MusicTrack) => {
    if (!track.url) return;

    let pitch = playbackPitch;
    if (autoRandomPitch) {
      pitch = Math.random() * (1.2 - 0.8) + 0.8;
      setPlaybackPitch(pitch);
    }

    setCurrentTrack(track);
    setIsPlaying(true);
    setTimeout(() => {
      if (!audioRef.current) return;
      audioRef.current.preservesPitch = false;
      audioRef.current.playbackRate = pitch;
      audioRef.current.volume = volume;
      audioRef.current.play().catch(() => setIsPlaying(false));
    }, 50);
  };

  const playQueue = (tracks: MusicTrack[], index: number) => {
    const track = tracks[index];
    if (!track) return;
    setQueue(tracks);
    startTrack(track);
  };

  const toggleTrack = (track: MusicTrack, tracks?: MusicTrack[]) => {
    if (tracks) setQueue(tracks);

    if (currentTrack?.id === track.id) {
      if (!audioRef.current) return;
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play().catch(() => setIsPlaying(false));
      }
      setIsPlaying(!isPlaying);
      return;
    }

    startTrack(track);
  };

  const playNext = () => {
    if (queue.length === 0) return;
    if (isShuffle) {
      let nextIndex = Math.floor(Math.random() * queue.length);
      if (queue.length > 1 && currentTrack) {
        while (queue[nextIndex].id === currentTrack.id) {
          nextIndex = Math.floor(Math.random() * queue.length);
        }
      }
      startTrack(queue[nextIndex]);
      return;
    }

    if (!currentTrack) {
      startTrack(queue[0]);
      return;
    }

    const idx = queue.findIndex((track) => track.id === currentTrack.id);
    startTrack(queue[(idx + 1) % queue.length]);
  };

  const playPrev = () => {
    if (queue.length === 0) return;
    if (isShuffle) {
      playNext();
      return;
    }

    if (!currentTrack) {
      startTrack(queue[queue.length - 1]);
      return;
    }

    const idx = queue.findIndex((track) => track.id === currentTrack.id);
    startTrack(queue[(idx - 1 + queue.length) % queue.length]);
  };

  const togglePlayPause = () => {
    if (!currentTrack && queue.length > 0) {
      startTrack(queue[0]);
      return;
    }

    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(() => setIsPlaying(false));
    }
    setIsPlaying(!isPlaying);
  };

  const handleVolumeChange = (val: number) => {
    setVolume(val);
    if (audioRef.current) audioRef.current.volume = val;
  };

  const handlePitchChange = (val: number) => {
    setPlaybackPitch(val);
    if (audioRef.current) {
      audioRef.current.preservesPitch = false;
      audioRef.current.playbackRate = val;
    }
  };

  const handleSeek = (val: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = val;
      setCurrentTime(val);
    }
  };

  return (
    <MusicPlayerContext.Provider value={{ currentTrack, isPlaying, playQueue, toggleTrack }}>
      {children}

      {!pathname.startsWith("/admin") && (
      <div className="playlist-admin__player">
        <div className="playlist-admin__now-playing">
          {currentTrack ? (
            <>
              <span className="playlist-admin__now-playing-title">{currentTrack.name}</span>
              <span className="playlist-admin__now-playing-pitch">Pitch: {playbackPitch.toFixed(2)}x</span>
            </>
          ) : (
            <span className="playlist-admin__now-playing-title" style={{ color: "#666" }}>Sin canción</span>
          )}
        </div>

        <div className="playlist-admin__player-center">
          <div className="playlist-admin__player-buttons">
            <button
              className={`playlist-admin__control-btn playlist-admin__control-btn--shuffle ${isShuffle ? "playlist-admin__control-btn--active" : ""}`}
              onClick={() => setIsShuffle((v) => !v)}
              title={isShuffle ? "Aleatorio activado" : "En orden"}
            >
              {isShuffle ? <ShuffleIcon size={16} /> : <ArrowRightIcon size={16} />}
            </button>
            <button className="playlist-admin__control-btn" onClick={playPrev}>⏮</button>
            <button className="playlist-admin__control-btn playlist-admin__control-btn--play" onClick={togglePlayPause}>
              {isPlaying ? "⏸" : "▶"}
            </button>
            <button className="playlist-admin__control-btn" onClick={playNext}>⏭</button>
          </div>

          <div className="playlist-admin__progress">
            <span className="playlist-admin__progress-time">{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              value={currentTime}
              onChange={(e) => handleSeek(Number(e.target.value))}
              className="playlist-admin__progress-bar"
            />
            <span className="playlist-admin__progress-time">{formatTime(duration)}</span>
          </div>
        </div>

        <div className="playlist-admin__player-right">
          <div className="playlist-admin__slider-group">
            <button
              className={`playlist-admin__control-btn playlist-admin__control-btn--pitch-toggle ${autoRandomPitch ? "playlist-admin__control-btn--active" : ""}`}
              onClick={() => setAutoRandomPitch((v) => !v)}
              title={autoRandomPitch ? "Pitch aleatorio al cambiar canción" : "Pitch fijo"}
            >
              <DicesIcon size={16} />
            </button>
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.01}
              value={playbackPitch}
              onChange={(e) => handlePitchChange(Number(e.target.value))}
              className="playlist-admin__mini-slider"
              title={`Pitch: ${playbackPitch.toFixed(2)}x`}
            />
          </div>

          <div className="playlist-admin__slider-group">
            <button
              className="playlist-admin__control-btn"
              onClick={() => handleVolumeChange(volume > 0 ? 0 : 0.8)}
              title={volume > 0 ? "Silenciar" : "Restaurar volumen"}
            >
              {volume > 0 ? <Volume2Icon size={16} /> : <VolumeXIcon size={16} />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
              className="playlist-admin__mini-slider"
              title={`Volumen: ${Math.round(volume * 100)}%`}
            />
          </div>
        </div>

      </div>
      )}

      <audio
        ref={audioRef}
        src={currentTrack?.url || undefined}
        onEnded={playNext}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        onTimeUpdate={() => {
          if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
        }}
        onLoadedMetadata={() => {
          if (!audioRef.current) return;
          setDuration(audioRef.current.duration);
          audioRef.current.volume = volume;
          audioRef.current.preservesPitch = false;
          audioRef.current.playbackRate = playbackPitch;
        }}
        style={{ display: "none" }}
      />
    </MusicPlayerContext.Provider>
  );
}
