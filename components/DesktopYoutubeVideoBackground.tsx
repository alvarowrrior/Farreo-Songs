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
  getYoutubeVideoWaitForReady,
  isYoutubeVideoBackgroundContext,
} from "@/lib/youtubeVideoBackgroundPreference";
import {
  registerYoutubeVideoSeekHandler,
  registerYoutubeVideoStartHandler,
  type YoutubeVideoStartRequest,
} from "@/lib/youtubeVideoStartCoordinator";
import { onActiveAudioPlaying, onQueuedAudioPrepared } from "@/lib/queueMediaPreload";
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
// Keep the first decoded frame hidden until its seek catches up with the audio.
const FIRST_FRAME_SYNC_TOLERANCE_SECONDS = 0.20;
const MAX_INITIAL_SEEK_ATTEMPTS = 2;

export default function DesktopYoutubeVideoBackground() {
  const pathname = usePathname();
  const {
    currentSource,
    currentTrack,
    nextTrackId,
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
  const nonBlockingLoadsRef = useRef(new Set<string>());
  const initialSeekAttemptsRef = useRef(0);

  const [stream, setStream] = useState<StreamInfo | null>(null);
  // Only the immediate next video's stream is allowed to warm. Its CDN URL
  // and the first video bytes are requested AFTER the audio prewarm signal.
  const [queuedVideoStream, setQueuedVideoStream] = useState<StreamInfo | null>(null);
  const [audioReadySongId, setAudioReadySongId] = useState<string | null>(null);
  const [readySongId, setReadySongId] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(
    DEFAULT_YOUTUBE_VIDEO_BACKGROUND_ENABLED,
  );
  const [radioEnabled, setRadioEnabled] = useState(
    DEFAULT_YOUTUBE_RADIO_BACKGROUND_ENABLED,
  );
  const [isDesktop, setIsDesktop] = useState(false);
  const [loadRetryNonce, setLoadRetryNonce] = useState(0);
  // A ready cached video may emit canplay in the same paint as its mount.
  // Present it one or two frames later so the CSS fade is never skipped.
  const [presentedStreamKey, setPresentedStreamKey] = useState<string | null>(null);

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
  const currentStreamKey = stream ? `${stream.songId}:${stream.directUrl}` : null;
  const backgroundVisible = backgroundReadyForCurrentTrack && presentedStreamKey === currentStreamKey;

  useEffect(() => {
    if (!backgroundReadyForCurrentTrack || !currentStreamKey) {
      setPresentedStreamKey(null);
      return;
    }
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => setPresentedStreamKey(currentStreamKey));
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [backgroundReadyForCurrentTrack, currentStreamKey]);

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
    initialSeekAttemptsRef.current = 0;
    setReadySongId(null);
    streamRef.current = null;
    setStream(null);
  }, []);

  const setActiveStream = useCallback((value: StreamInfo) => {
    const previous = streamRef.current;
    // Two overlapping async lookups (e.g. playback starts while an earlier
    // lookup is still finishing) must never reset a live decoder or fade.
    if (previous?.songId === value.songId && previous.directUrl === value.directUrl) {
      return;
    }

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
    initialSeekAttemptsRef.current = 0;
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
    }, 7_000);

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

  // React isPlaying can be set by the early 'play' event; only the browser's
  // 'playing' event proves the audio has enough decoded data to run.
  useEffect(() => {
    setAudioReadySongId(null);
    if (!currentTrack?.id || playerMode !== "local") return;
    return onActiveAudioPlaying(currentTrack.id, (ready) => {
      setAudioReadySongId(ready ? currentTrack.id : null);
    });
  }, [currentTrack?.id, playerMode]);

  // Non-blocking load for Radio, mid-song activation/navigation, and hidden-tab
  // track changes. This path never gates or pauses audio.
  useEffect(() => {
    const trackId = currentTrack?.id || null;
    if (!contextEligible || !trackId) return;

    // In "No esperar" mode the local AUDIO must actually be playing before
    // we resolve or download any video. Otherwise yt-dlp/video bandwidth can
    // compete with the first bytes of the new YouTube audio track.
    // The explicit wait-for-video mode has its own prepareVideoBeforeLocalStart
    // path and is not affected by this rule.
    if (!isPlaying && (playerMode === "radio" || !getYoutubeVideoWaitForReady())) return;
    if (playerMode === "local" && !getYoutubeVideoWaitForReady()
      && audioReadySongId !== trackId) return;

    if (
      streamRef.current?.songId === trackId
      || nonBlockingLoadsRef.current.has(trackId)
      || (Date.now() - (noVideoTracksRef.current.get(trackId) ?? 0) < MISSING_VIDEO_CACHE_MS)
      || (
        pendingVideoStartRef.current
        && !pendingVideoStartRef.current.settled
      )
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (nonBlockingLoadsRef.current.has(trackId)) return;
      nonBlockingLoadsRef.current.add(trackId);
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
            && enabledRef.current
            && isDesktopRef.current
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
        } finally {
          nonBlockingLoadsRef.current.delete(trackId);
        }
      })();
    }, playerMode === "radio" ? 650 : 250);

    return () => window.clearTimeout(timer);
  }, [
    contextEligible,
    currentTrack?.id,
    audioReadySongId,
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

  // The stream can signal canplay before its first seek completes. Revealing
  // that frame displays the wrong part of the clip, sometimes just for a few
  // frames before the browser seeks/buffers again. Wait for the seek instead.
  const revealVideoWhenAligned = useCallback((video: HTMLVideoElement, songId: string) => {
    if (
      videoRef.current !== video
      || currentTrackRef.current?.id !== songId
      || streamRef.current?.songId !== songId
      || video.seeking
      || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
    ) return;
    if (readySongIdRef.current !== songId) {
      readySongIdRef.current = songId;
      setReadySongId(songId);
    }
    clearNonBlockingRetry(songId);
    const pending = pendingVideoStartRef.current;
    if (pending?.songId === songId && !pending.settled) {
      settlePendingVideoStart(false, pending.signal);
    }
    applyVideoPlaybackState();
  }, [applyVideoPlaybackState, clearNonBlockingRetry, settlePendingVideoStart]);

  // Use the audio's *current* clock for the initial frame, not time zero from
  // when yt-dlp resolution began. A bounded second seek handles slow networks.
  const alignFirstVideoFrame = useCallback((video: HTMLVideoElement, songId: string) => {
    if (
      currentTrackRef.current?.id !== songId
      || streamRef.current?.songId !== songId
      || video.seeking
      || !Number.isFinite(video.duration)
      || video.duration <= 0
    ) return false;

    const target = playerModeRef.current === "radio" && radioStateRef.current
      ? getLiveRadioPosition(radioStateRef.current)
      : currentTimeRef.current;
    const safeTarget = Math.max(0, Math.min(target, Math.max(0, video.duration - 0.05)));
    if (
      Math.abs(video.currentTime - safeTarget) <= FIRST_FRAME_SYNC_TOLERANCE_SECONDS
      || initialSeekAttemptsRef.current >= MAX_INITIAL_SEEK_ATTEMPTS
    ) return false;

    try {
      video.currentTime = safeTarget;
      initialSeekAttemptsRef.current += 1;
      return video.seeking;
    } catch {
      return false;
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
    if (backgroundVisible) {
      document.documentElement.dataset.farreoYoutubeVideoBackground = "true";
    } else {
      delete document.documentElement.dataset.farreoYoutubeVideoBackground;
    }

    return () => {
      delete document.documentElement.dataset.farreoYoutubeVideoBackground;
    };
  }, [backgroundVisible]);

  useEffect(() => {
    return () => {
      settlePendingVideoStart(true);
      nonBlockingRetryTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      nonBlockingRetryTimersRef.current.clear();
      nonBlockingLoadsRef.current.clear();
      unloadCurrentVideo();
    };
  }, [settlePendingVideoStart, unloadCurrentVideo]);

  // Next-song video preparation follows a real AUDIO readiness signal from
  // MusicPlayerProvider. Never try to resolve a queued video's yt-dlp URL or
  // open its media stream concurrently with the next song's audio prewarm.
  // A single muted, offscreen <video> warms the first video bytes only after
  // the audio has priority. The cached URL still helps when browsers decide
  // not to reuse the offscreen element's video buffer.
  useEffect(() => {
    setQueuedVideoStream(null);
    if (!contextEligible || playerMode !== "local" || !isPlaying
      || audioReadySongId !== currentTrack?.id
      || !nextTrackId || nextTrackId === currentTrack?.id
      || getYoutubeVideoWaitForReady()) return;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData) return;
    let cancelled = false;
    let timer = 0;
    let scheduled = false;
    const unsubscribe = onQueuedAudioPrepared(nextTrackId, () => {
      if (scheduled || cancelled) return;
      scheduled = true;
      // A deliberate head start for the next audio's resolver/byte buffer.
      timer = window.setTimeout(() => {
        void hasVideoAssociation(nextTrackId).then((available) => {
          if (cancelled || !available) return null;
          return getStreamInfo(nextTrackId);
        }).then((info) => {
          if (!cancelled && info?.songId === nextTrackId) {
            setQueuedVideoStream(info);
          }
        }).catch(() => undefined);
      }, 1600);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, [contextEligible, currentTrack?.id, nextTrackId, isPlaying,
      audioReadySongId, getStreamInfo, hasVideoAssociation, playerMode]);

  if (!stream && !queuedVideoStream) return null;

  return (
    <>
    {stream ? (
    <div
      className={`${styles.root} ${backgroundVisible ? styles.ready : ""}`}
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
        onCanPlay={(event) => {
          const video = event.currentTarget;
          const isCurrentSong = currentTrackRef.current?.id === stream.songId;
          const pending = pendingVideoStartRef.current;
          const isPendingStart = pending?.songId === stream.songId;
          if (
            (!isCurrentSong && !isPendingStart)
            || streamRef.current?.songId !== stream.songId
            || streamRef.current.directUrl !== stream.directUrl
          ) return;

          // Only run first-frame synchronization once per stream. A player
          // resuming after buffering must not repeatedly seek back and hide.
          const syncKey = `${stream.songId}:${stream.directUrl}`;
          if (initialVideoSyncKeyRef.current !== syncKey) {
            initialVideoSyncKeyRef.current = syncKey;
            if (isCurrentSong && alignFirstVideoFrame(video, stream.songId)) return;
          }
          if (video.seeking) return;

          if (isCurrentSong) {
            revealVideoWhenAligned(video, stream.songId);
          } else if (isPendingStart && pending && !pending.settled) {
            // The legacy opt-in can prepare a *future* song. Keep its ready
            // state so that a subsequent track switch does not need another
            // canplay event (which browsers are not obliged to emit).
            readySongIdRef.current = stream.songId;
            setReadySongId(stream.songId);
            clearNonBlockingRetry(stream.songId);
            settlePendingVideoStart(false, pending.signal);
          }
        }}
        onSeeked={(event) => {
          const video = event.currentTarget;
          if (
            currentTrackRef.current?.id !== stream.songId
            || streamRef.current?.songId !== stream.songId
            || streamRef.current.directUrl !== stream.directUrl
          ) return;
          if (readySongIdRef.current !== stream.songId && alignFirstVideoFrame(video, stream.songId)) return;
          revealVideoWhenAligned(video, stream.songId);
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
    ) : null}
    {queuedVideoStream && queuedVideoStream.songId !== stream?.songId ? (
      <video
        key={`${queuedVideoStream.songId}:${queuedVideoStream.directUrl}`}
        src={queuedVideoStream.directUrl}
        muted
        playsInline
        preload="metadata"
        aria-hidden="true"
        // Resolve the next video's stream URL, but fetch only metadata while
        // it is queued. A hidden preload=auto video could otherwise download
        // continuously, then race the NEXT audio at exactly the worst moment.
        // The active video loads fully when the next audio has real headroom.
        style={{ position: "fixed", left: "-8px", top: "-8px", width: 1,
          height: 1, opacity: 0, pointerEvents: "none", zIndex: -1 }}
      />
    ) : null}
    </>
  );
}
