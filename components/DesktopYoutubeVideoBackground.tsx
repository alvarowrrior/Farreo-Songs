"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  useMusicPlayer,
  useMusicPlayerTime,
} from "@/components/MusicPlayerProvider";
import {
  MUSIC_API_URL,
  getLiveRadioPosition,
} from "@/lib/radioApi";
import {
  DEFAULT_YOUTUBE_RADIO_BACKGROUND_ENABLED,
  DEFAULT_YOUTUBE_VIDEO_BACKGROUND_ENABLED,
  YOUTUBE_RADIO_BACKGROUND_CHANGE_EVENT,
  YOUTUBE_RADIO_BACKGROUND_STORAGE_KEY,
  YOUTUBE_VIDEO_BACKGROUND_CHANGE_EVENT,
  YOUTUBE_VIDEO_BACKGROUND_STORAGE_KEY,
  getYoutubeRadioBackgroundEnabled,
  getYoutubeVideoBackgroundEnabled,
  isYoutubeVideoBackgroundContext,
} from "@/lib/youtubeVideoBackgroundPreference";
import {
  registerYoutubeVideoSeekHandler,
  registerYoutubeVideoStartHandler,
  type YoutubeVideoStartRequest,
} from "@/lib/youtubeVideoStartCoordinator";
import styles from "./DesktopYoutubeVideoBackground.module.scss";

interface StreamInfo {
  directUrl: string;
  songId: string;
  youtubeUrl?: string | null;
}

interface CachedStream {
  value: StreamInfo;
  cachedAt: number;
}

interface AudioTimelineSample {
  trackId: string;
  time: number;
  at: number;
  rate: number;
  playing: boolean;
}

interface PendingVideoStart {
  songId: string;
  resolve: () => void;
  timeout: number;
  signal: AbortSignal;
  abortHandler: () => void;
  onWaitingChange: (waiting: boolean) => void;
  settled: boolean;
}

const STREAM_CACHE_MS = 4 * 60_000;
const MISSING_VIDEO_CACHE_MS = 30_000;
const MAX_STREAM_CACHE_ENTRIES = 6;
const SEEK_DISCONTINUITY_SECONDS = 1.15;

export default function DesktopYoutubeVideoBackground() {
  const pathname = usePathname();
  const {
    currentSource,
    currentTrack,
    isPlaying,
    playbackPitch,
    playerMode,
    radioState,
  } = useMusicPlayer();
  const { currentTime } = useMusicPlayerTime();

  const videoRef = useRef<HTMLVideoElement>(null);
  const retriedFreshRef = useRef(false);
  const currentTrackRef = useRef(currentTrack);
  const currentSourceRef = useRef(currentSource);
  const pathnameRef = useRef(pathname);
  const playerModeRef = useRef(playerMode);
  const radioStateRef = useRef(radioState);
  const currentTimeRef = useRef(currentTime);
  const isPlayingRef = useRef(isPlaying);
  const playbackPitchRef = useRef(playbackPitch);
  const enabledRef = useRef(DEFAULT_YOUTUBE_VIDEO_BACKGROUND_ENABLED);
  const isDesktopRef = useRef(false);
  const noVideoTracksRef = useRef(new Map<string, number>());
  // Only URLs/metadata are cached here. No HTMLVideoElement or decoded frames.
  const streamCacheRef = useRef(new Map<string, CachedStream>());
  const streamRef = useRef<StreamInfo | null>(null);
  const readySongIdRef = useRef<string | null>(null);
  const initialVideoSyncKeyRef = useRef<string | null>(null);
  const audioTimelineRef = useRef<AudioTimelineSample | null>(null);
  const pendingVideoStartRef = useRef<PendingVideoStart | null>(null);
  const nonBlockingRetryCountRef = useRef(new Map<string, number>());
  const nonBlockingRetryTimersRef = useRef(new Map<string, number>());

  const [stream, setStream] = useState<StreamInfo | null>(null);
  const [readySongId, setReadySongId] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(
    DEFAULT_YOUTUBE_VIDEO_BACKGROUND_ENABLED,
  );
  const [radioEnabled, setRadioEnabled] = useState(
    DEFAULT_YOUTUBE_RADIO_BACKGROUND_ENABLED,
  );
  const [isDesktop, setIsDesktop] = useState(false);
  const [loadRetryNonce, setLoadRetryNonce] = useState(0);

  currentTrackRef.current = currentTrack;
  currentSourceRef.current = currentSource;
  pathnameRef.current = pathname;
  playerModeRef.current = playerMode;
  radioStateRef.current = radioState;
  currentTimeRef.current = currentTime;
  isPlayingRef.current = isPlaying;
  playbackPitchRef.current = playbackPitch;
  enabledRef.current = enabled;
  isDesktopRef.current = isDesktop;
  streamRef.current = stream;
  readySongIdRef.current = readySongId;

  const contextActive = isYoutubeVideoBackgroundContext(
    pathname,
    currentSource,
    playerMode,
  );
  const radioAllowed = playerMode !== "radio" || radioEnabled;

  // Visibility is deliberately excluded. Keeping the current song's one video
  // element mounted while hidden preserves its loaded data for instant return.
  const contextEligible = (
    enabled
    && radioAllowed
    && isDesktop
    && contextActive
    && Boolean(currentTrack?.id)
  );

  const streamMatchesCurrentTrack = Boolean(
    stream
    && currentTrack?.id
    && stream.songId === currentTrack.id
  );

  const backgroundReadyForCurrentTrack = Boolean(
    contextEligible
    && streamMatchesCurrentTrack
    && readySongId === currentTrack?.id
  );

  const settlePendingVideoStart = useCallback((
    clear = false,
    expectedSignal?: AbortSignal,
  ) => {
    const pending = pendingVideoStartRef.current;
    if (
      !pending
      || (expectedSignal && pending.signal !== expectedSignal)
    ) return;

    if (!pending.settled) {
      pending.settled = true;
      window.clearTimeout(pending.timeout);
      pending.signal.removeEventListener("abort", pending.abortHandler);
      pending.onWaitingChange(false);
      pending.resolve();
    }

    if (clear && pendingVideoStartRef.current === pending) {
      pendingVideoStartRef.current = null;
    }
  }, []);

  const hasVideoAssociation = useCallback(async (songId: string) => {
    const missingAt = noVideoTracksRef.current.get(songId);
    if (missingAt && Date.now() - missingAt < MISSING_VIDEO_CACHE_MS) return false;
    noVideoTracksRef.current.delete(songId);
    if (streamCacheRef.current.has(songId)) return true;

    const response = await fetch(
      `${MUSIC_API_URL}/youtube-backgrounds/${encodeURIComponent(songId)}`,
      { cache: "no-store" },
    );

    if (response.status === 404) {
      noVideoTracksRef.current.set(songId, Date.now());
      return false;
    }

    if (!response.ok) {
      throw new Error(`Videoclip association HTTP ${response.status}`);
    }

    const association = await response.json().catch(() => ({})) as {
      youtubeUrl?: string | null;
    };

    if (!association.youtubeUrl) {
      noVideoTracksRef.current.set(songId, Date.now());
      return false;
    }

    noVideoTracksRef.current.delete(songId);
    return true;
  }, []);

  const unloadCurrentVideo = useCallback(() => {
    retriedFreshRef.current = false;
    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        // Best-effort decoder/buffer release.
      }
    }

    readySongIdRef.current = null;
    initialVideoSyncKeyRef.current = null;
    setReadySongId(null);
    streamRef.current = null;
    setStream(null);
  }, []);

  const setActiveStream = useCallback((value: StreamInfo) => {
    const previous = streamRef.current;

    if (
      previous
      && (
        previous.songId !== value.songId
        || previous.directUrl !== value.directUrl
      )
    ) {
      const video = videoRef.current;
      if (video) {
        try {
          video.pause();
          video.removeAttribute("src");
          video.load();
        } catch {
          // React will replace the element immediately anyway.
        }
      }
    }

    readySongIdRef.current = null;
    initialVideoSyncKeyRef.current = null;
    setReadySongId(null);
    streamRef.current = value;
    setStream(value);
  }, []);

  const clearNonBlockingRetry = useCallback((songId: string) => {
    const timer = nonBlockingRetryTimersRef.current.get(songId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      nonBlockingRetryTimersRef.current.delete(songId);
    }
    nonBlockingRetryCountRef.current.delete(songId);
  }, []);

  const scheduleNonBlockingRetry = useCallback((songId: string) => {
    if (!songId || nonBlockingRetryTimersRef.current.has(songId)) return;

    const attempt = nonBlockingRetryCountRef.current.get(songId) || 0;
    if (attempt >= 2) return;

    nonBlockingRetryCountRef.current.set(songId, attempt + 1);
    const timer = window.setTimeout(() => {
      nonBlockingRetryTimersRef.current.delete(songId);
      if (currentTrackRef.current?.id === songId) {
        setLoadRetryNonce((value) => value + 1);
      }
    }, attempt === 0 ? 900 : 2500);

    nonBlockingRetryTimersRef.current.set(songId, timer);
  }, []);

  useEffect(() => {
    const refresh = () => setEnabled(getYoutubeVideoBackgroundEnabled());
    const onStorage = (event: StorageEvent) => {
      if (event.key === YOUTUBE_VIDEO_BACKGROUND_STORAGE_KEY) refresh();
    };

    refresh();
    window.addEventListener(YOUTUBE_VIDEO_BACKGROUND_CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(YOUTUBE_VIDEO_BACKGROUND_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    const refresh = () => setRadioEnabled(getYoutubeRadioBackgroundEnabled());
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

  useEffect(() => {
    const media = window.matchMedia("(min-width: 760px)");
    const refresh = () => setIsDesktop(media.matches);
    refresh();
    media.addEventListener("change", refresh);
    return () => media.removeEventListener("change", refresh);
  }, []);

  const getStreamInfo = useCallback(async (
    songId: string,
    fresh = false,
  ) => {
    if (!fresh) {
      const cached = streamCacheRef.current.get(songId);
      if (cached && Date.now() - cached.cachedAt < STREAM_CACHE_MS) {
        return cached.value;
      }
    }

    const suffix = fresh ? "?fresh=1" : "";
    const response = await fetch(
      `${MUSIC_API_URL}/youtube-backgrounds/${encodeURIComponent(songId)}/stream${suffix}`,
      { cache: "no-store" },
    );

    if (response.status === 404) {
      noVideoTracksRef.current.set(songId, Date.now());
      return null;
    }

    const data = await response.json().catch(() => ({})) as StreamInfo & {
      error?: string;
    };

    if (!response.ok || !data.directUrl) {
      throw new Error(data.error || "No se pudo resolver el videoclip.");
    }

    noVideoTracksRef.current.delete(songId);
    streamCacheRef.current.set(songId, {
      value: data,
      cachedAt: Date.now(),
    });

    if (streamCacheRef.current.size > MAX_STREAM_CACHE_ENTRIES) {
      const oldest = [...streamCacheRef.current.entries()]
        .sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0]?.[0];
      if (oldest) streamCacheRef.current.delete(oldest);
    }

    return data;
  }, []);

  const prepareVideoBeforeLocalStart = useCallback(async (
    request: YoutubeVideoStartRequest,
  ) => {
    const contextStillEligible = () => (
      !request.signal.aborted
      && enabledRef.current
      && isDesktopRef.current
      && isYoutubeVideoBackgroundContext(
        pathnameRef.current,
        request.source,
        "local",
      )
    );

    // Radio, mobile, disabled backgrounds and the wrong playlist never gate.
    if (
      document.visibilityState !== "visible"
      || !contextStillEligible()
    ) {
      return;
    }

    // Claim the one transition slot before the first await. This prevents the
    // normal visual loader from racing the exact same song start.
    if (pendingVideoStartRef.current) {
      settlePendingVideoStart(true);
    }

    request.onWaitingChange(true);
    retriedFreshRef.current = false;

    let resolveWait!: () => void;
    const waitForVideo = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });

    const abortHandler = () => {
      settlePendingVideoStart(true, request.signal);
    };

    const timeout = window.setTimeout(() => {
      // Video is optional: release the audio, but an already-running video
      // request may continue warming for this same song.
      settlePendingVideoStart(false, request.signal);
    }, 15_000);

    pendingVideoStartRef.current = {
      songId: request.trackId,
      resolve: resolveWait,
      timeout,
      signal: request.signal,
      abortHandler,
      onWaitingChange: request.onWaitingChange,
      settled: false,
    };
    request.signal.addEventListener("abort", abortHandler, { once: true });

    try {
      // The local association lookup is expected to be very fast. If that
      // endpoint is unhealthy, fail open rather than making audio depend on it.
      const hasVideo = await Promise.race([
        hasVideoAssociation(request.trackId),
        new Promise<null>((resolve) => {
          window.setTimeout(() => resolve(null), 3000);
        }),
      ]);

      if (request.signal.aborted) {
        settlePendingVideoStart(true, request.signal);
        await waitForVideo;
        return;
      }

      if (hasVideo !== true) {
        settlePendingVideoStart(false, request.signal);
        if (hasVideo === null) {
          scheduleNonBlockingRetry(request.trackId);
        }
        await waitForVideo;
        return;
      }

      // If the tab became hidden while probing, audio continuity wins
      // immediately. The video is still allowed to keep warming below.
      if (
        document.visibilityState !== "visible"
        && pendingVideoStartRef.current?.signal === request.signal
      ) {
        settlePendingVideoStart(false, request.signal);
      }

      if (!contextStillEligible()) {
        settlePendingVideoStart(true, request.signal);
        await waitForVideo;
        return;
      }

      if (
        streamRef.current?.songId === request.trackId
        && readySongIdRef.current === request.trackId
        && videoRef.current
      ) {
        try { videoRef.current.currentTime = 0; } catch { /* best effort */ }
        settlePendingVideoStart(false, request.signal);
        await waitForVideo;
        return;
      }

      const info = await getStreamInfo(request.trackId);

      if (
        request.signal.aborted
        || !contextStillEligible()
      ) {
        settlePendingVideoStart(true, request.signal);
        await waitForVideo;
        return;
      }

      if (!info) {
        settlePendingVideoStart(false, request.signal);
        await waitForVideo;
        return;
      }

      // If the safety timeout already released audio, keep loading the same
      // song's one video in the background; it can attach whenever it is ready.
      if (
        currentTrackRef.current?.id === request.trackId
        || pendingVideoStartRef.current?.signal === request.signal
      ) {
        setActiveStream(info);
      }
    } catch {
      settlePendingVideoStart(false, request.signal);
      scheduleNonBlockingRetry(request.trackId);
    }

    await waitForVideo;
  }, [
    getStreamInfo,
    hasVideoAssociation,
    setActiveStream,
    settlePendingVideoStart,
    scheduleNonBlockingRetry,
  ]);

  useEffect(() => (
    registerYoutubeVideoStartHandler(prepareVideoBeforeLocalStart)
  ), [prepareVideoBeforeLocalStart]);

  // A settled slot can stay attached to its song for the rest of that track.
  // This protects a gapless prepare until the provider commits the swap. On the
  // next real track change it is discarded before normal loading continues.
  useEffect(() => {
    const pending = pendingVideoStartRef.current;
    if (
      pending?.settled
      && currentTrack?.id !== pending.songId
    ) {
      pendingVideoStartRef.current = null;
    }
  }, [currentTrack?.id]);

  // A song/context change releases the previous VIDEO decoder/buffer. The tiny
  // resolved URL metadata can remain cached, but there is never a pile of
  // mounted videos consuming RAM.
  useEffect(() => {
    const trackId = currentTrack?.id || null;
    const active = streamRef.current;
    const pending = pendingVideoStartRef.current;

    if (!contextEligible && pending && !pending.settled) {
      settlePendingVideoStart(false);
    }

    if (!active) return;

    const pendingSongId = pendingVideoStartRef.current?.songId || null;

    if (
      !contextEligible
      || !trackId
      || (active.songId !== trackId && active.songId !== pendingSongId)
    ) {
      retriedFreshRef.current = false;
      unloadCurrentVideo();
    }
  }, [
    contextEligible,
    currentTrack?.id,
    settlePendingVideoStart,
    unloadCurrentVideo,
  ]);

  // Non-blocking load for Radio, mid-song activation/navigation, and hidden-tab
  // track changes. This path never gates or pauses audio.
  useEffect(() => {
    const trackId = currentTrack?.id || null;
    if (!contextEligible || !trackId) return;

    // Radio audio is authoritative. A videoclip can begin resolving only after
    // this client has already joined the audio timeline, so video work can
    // never delay or define the shared Radio transition.
    if (playerMode === "radio" && !isPlaying) return;

    if (
      streamRef.current?.songId === trackId
      || (Date.now() - (noVideoTracksRef.current.get(trackId) ?? 0) < MISSING_VIDEO_CACHE_MS)
      || (
        pendingVideoStartRef.current
        && !pendingVideoStartRef.current.settled
      )
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const availabilityResponse = await fetch(
            `${MUSIC_API_URL}/youtube-backgrounds/${encodeURIComponent(trackId)}`,
            { cache: "no-store" },
          );
          if (availabilityResponse.status === 404) {
            noVideoTracksRef.current.set(trackId, Date.now());
            clearNonBlockingRetry(trackId);
            return;
          }
          if (!availabilityResponse.ok) {
            throw new Error(`Videoclip association HTTP ${availabilityResponse.status}`);
          }

          const availability = await availabilityResponse.json().catch(() => ({})) as {
            youtubeUrl?: string | null;
          };

          if (!availability.youtubeUrl) {
            noVideoTracksRef.current.set(trackId, Date.now());
            clearNonBlockingRetry(trackId);
            return;
          }

          noVideoTracksRef.current.delete(trackId);

          if (
            pendingVideoStartRef.current
            && !pendingVideoStartRef.current.settled
          ) {
            return;
          }

          if (currentTrackRef.current?.id !== trackId) return;

          const info = await getStreamInfo(trackId);

          if (
            info
            && currentTrackRef.current?.id === trackId
            && isYoutubeVideoBackgroundContext(
              pathnameRef.current,
              currentSourceRef.current,
              playerModeRef.current,
            )
          ) {
            setActiveStream(info);
          }
        } catch {
          // Optional visual only. Retry a couple of transient resolver/network
          // failures without ever blocking or pausing the audio.
          scheduleNonBlockingRetry(trackId);
        }
      })();
    }, playerMode === "radio" ? 650 : 120);

    return () => window.clearTimeout(timer);
  }, [
    contextEligible,
    currentTrack?.id,
    getStreamInfo,
    isPlaying,
    loadRetryNonce,
    playerMode,
    clearNonBlockingRetry,
    scheduleNonBlockingRetry,
    setActiveStream,
  ]);

  const seekVideoToPlayback = useCallback(() => {
    const video = videoRef.current;
    const activeTrack = currentTrackRef.current;
    const activeStream = streamRef.current;

    if (
      !video
      || !activeTrack?.id
      || !activeStream
      || activeStream.songId !== activeTrack.id
      || readySongIdRef.current !== activeTrack.id
      || !Number.isFinite(video.duration)
      || video.duration <= 0
    ) {
      return;
    }

    const target = playerModeRef.current === "radio" && radioStateRef.current
      ? getLiveRadioPosition(radioStateRef.current)
      : currentTimeRef.current;

    try {
      video.currentTime = Math.max(
        0,
        Math.min(target, Math.max(0, video.duration - 0.05)),
      );
    } catch {
      // canplay/visibility can retry.
    }
  }, []);

  useEffect(() => registerYoutubeVideoSeekHandler((trackId, time) => {
    const video = videoRef.current;
    if (
      !video
      || currentTrackRef.current?.id !== trackId
      || streamRef.current?.songId !== trackId
      || readySongIdRef.current !== trackId
      || !Number.isFinite(time)
    ) return;

    // Handle the exact requested position immediately. React's later time
    // update must not issue a duplicate seek into a progressive stream.
    const target = Number.isFinite(video.duration) && video.duration > 0
      ? Math.max(0, Math.min(time, Math.max(0, video.duration - 0.05)))
      : Math.max(0, time);
    try {
      if (Math.abs(video.currentTime - target) > 0.05) video.currentTime = target;
      audioTimelineRef.current = {
        trackId,
        time,
        at: performance.now(),
        rate: playbackPitchRef.current,
        playing: isPlayingRef.current,
      };
    } catch {
      // Video seeking is optional; the timeline effect remains the fallback.
    }
  }), []);

  const applyVideoPlaybackState = useCallback(() => {
    const video = videoRef.current;
    const activeTrack = currentTrackRef.current;
    const activeStream = streamRef.current;

    if (
      !video
      || !activeTrack?.id
      || !activeStream
      || activeStream.songId !== activeTrack.id
      || readySongIdRef.current !== activeTrack.id
    ) {
      return;
    }

    video.playbackRate = Math.max(
      0.5,
      Math.min(1.5, playbackPitchRef.current || 1),
    );

    const shouldPlay = (
      isPlayingRef.current
      || (
        playerModeRef.current === "radio"
        && radioStateRef.current?.status === "playing"
      )
    );

    if (shouldPlay) {
      // Keep the single muted video running in a hidden tab as well. Browsers
      // may throttle rendering, but this gives the progressive stream the best
      // chance to keep downloading/buffering for an instant return.
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, []);

  // Natural play/pause + pitch only. No continuous seeking here.
  useEffect(() => {
    if (!backgroundReadyForCurrentTrack) return;
    applyVideoPlaybackState();
  }, [
    applyVideoPlaybackState,
    backgroundReadyForCurrentTrack,
    isPlaying,
    playbackPitch,
    radioState?.status,
  ]);

  // Seek the video only if the AUDIO timeline itself jumped substantially
  // (manual seek / provider resync). Normal playback is left untouched.
  useEffect(() => {
    const trackId = currentTrack?.id || null;
    if (!trackId) {
      audioTimelineRef.current = null;
      return;
    }

    const now = performance.now();
    const previous = audioTimelineRef.current;

    if (
      backgroundReadyForCurrentTrack
      && previous
      && previous.trackId === trackId
    ) {
      const elapsed = Math.max(0, Math.min(3, (now - previous.at) / 1000));
      const expected = previous.playing
        ? previous.time + (elapsed * previous.rate)
        : previous.time;

      if (Math.abs(currentTime - expected) > SEEK_DISCONTINUITY_SECONDS) {
        seekVideoToPlayback();
      }
    }

    audioTimelineRef.current = {
      trackId,
      time: currentTime,
      at: now,
      rate: playbackPitch,
      playing: isPlaying,
    };
  }, [
    backgroundReadyForCurrentTrack,
    currentTime,
    currentTrack?.id,
    isPlaying,
    playbackPitch,
    seekVideoToPlayback,
  ]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        // Audio continuity wins in background tabs. If a visible-tab start was
        // waiting, release it now, but leave the one video mounted/running so
        // its network buffer can stay warm.
        if (pendingVideoStartRef.current && !pendingVideoStartRef.current.settled) {
          settlePendingVideoStart(false);
        }
        applyVideoPlaybackState();
        return;
      }

      // Force exactly one correction before the tab becomes useful again.
      // If a previous non-blocking resolution failed while hidden, selected-tab
      // visibility gives it another immediate chance to recover.
      if (!streamRef.current && currentTrackRef.current?.id) {
        setLoadRetryNonce((value) => value + 1);
      }
      seekVideoToPlayback();
      applyVideoPlaybackState();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    applyVideoPlaybackState,
    seekVideoToPlayback,
    settlePendingVideoStart,
  ]);

  useEffect(() => {
    if (backgroundReadyForCurrentTrack) {
      document.documentElement.dataset.farreoYoutubeVideoBackground = "true";
    } else {
      delete document.documentElement.dataset.farreoYoutubeVideoBackground;
    }

    return () => {
      delete document.documentElement.dataset.farreoYoutubeVideoBackground;
    };
  }, [backgroundReadyForCurrentTrack]);

  useEffect(() => {
    return () => {
      settlePendingVideoStart(true);
      nonBlockingRetryTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      nonBlockingRetryTimersRef.current.clear();
      unloadCurrentVideo();
    };
  }, [settlePendingVideoStart, unloadCurrentVideo]);

  if (!stream) return null;

  return (
    <div
      className={`${styles.root} ${backgroundReadyForCurrentTrack ? styles.ready : ""}`}
      aria-hidden="true"
    >
      <video
        ref={videoRef}
        key={`${stream.songId}:${stream.directUrl}`}
        src={stream.directUrl}
        muted
        playsInline
        preload="auto"
        className={styles.video}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          video.playbackRate = Math.max(
            0.5,
            Math.min(1.5, playbackPitchRef.current || 1),
          );
        }}
        onCanPlay={() => {
          const isCurrentSong = currentTrackRef.current?.id === stream.songId;
          const pending = pendingVideoStartRef.current;
          const isPendingStart = pending?.songId === stream.songId;

          if (
            (!isCurrentSong && !isPendingStart)
            || streamRef.current?.songId !== stream.songId
          ) {
            return;
          }

          readySongIdRef.current = stream.songId;
          setReadySongId(stream.songId);
          clearNonBlockingRetry(stream.songId);

          // Exactly one initial synchronization per direct stream. A pending
          // gapless next track starts at zero, so it needs no seek until it is
          // actually the current song.
          const syncKey = `${stream.songId}:${stream.directUrl}`;
          if (initialVideoSyncKeyRef.current !== syncKey) {
            initialVideoSyncKeyRef.current = syncKey;
            if (isCurrentSong) seekVideoToPlayback();
          }

          if (isPendingStart && pending && !pending.settled) {
            settlePendingVideoStart(false);
          }

          if (isCurrentSong) applyVideoPlaybackState();
        }}
        onError={() => {
          const failedSongId = stream.songId;
          const pending = pendingVideoStartRef.current;
          const pendingSignal = pending?.signal;
          const isPendingStart = pending?.songId === failedSongId;
          const isCurrentSong = currentTrackRef.current?.id === failedSongId;

          if (
            (!isCurrentSong && !isPendingStart)
            || streamRef.current?.songId !== failedSongId
          ) {
            return;
          }

          readySongIdRef.current = null;
          setReadySongId(null);

          if (!retriedFreshRef.current) {
            retriedFreshRef.current = true;
            streamCacheRef.current.delete(failedSongId);

            void getStreamInfo(failedSongId, true)
              .then((fresh) => {
                if (!fresh) {
                  if (isPendingStart && pendingSignal) {
                    settlePendingVideoStart(false, pendingSignal);
                  }
                  if (currentTrackRef.current?.id === failedSongId) {
                    unloadCurrentVideo();
                    scheduleNonBlockingRetry(failedSongId);
                  }
                  return;
                }

                const stillPending = pendingVideoStartRef.current?.signal === pendingSignal;
                if (currentTrackRef.current?.id === failedSongId || stillPending) {
                  setActiveStream(fresh);
                }
              })
              .catch(() => {
                if (isPendingStart && pendingSignal) {
                  settlePendingVideoStart(false, pendingSignal);
                }
                if (currentTrackRef.current?.id === failedSongId) {
                  unloadCurrentVideo();
                  scheduleNonBlockingRetry(failedSongId);
                }
              });
            return;
          }

          if (isPendingStart && pendingSignal) {
            settlePendingVideoStart(false, pendingSignal);
          }

          if (isCurrentSong) {
            streamCacheRef.current.delete(failedSongId);
            unloadCurrentVideo();
            scheduleNonBlockingRetry(failedSongId);
          }
        }}
      />
      <div className={styles.shade} />
    </div>
  );
}
