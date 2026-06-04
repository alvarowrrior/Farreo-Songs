export interface LyricCue {
  id: string;
  start: number;
  end: number;
  text: string;
}

const parseSrtTime = (value: string) => {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length < 2) return 0;

  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length > 0 ? Number(parts.pop()) : 0;

  if ([hours, minutes, seconds].some((part) => Number.isNaN(part))) {
    return 0;
  }

  return (hours * 3600) + (minutes * 60) + seconds;
};

/**
 * Parses an SRT/VTT subtitle string into ordered lyric cues.
 * Accepts both comma and dot millisecond separators, ignores blocks without
 * a timing line or with end <= start, and sorts by start time.
 */
export const parseSrt = (srt?: string | null): LyricCue[] => {
  if (!srt) return [];

  return srt
    .replace(/\r/g, "")
    .split(/\n\s*\n/g)
    .map((block) => {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex === -1) return null;

      const [rawStart, rawEnd] = lines[timingIndex].split("-->").map((part) => part.trim());
      const text = lines
        .slice(timingIndex + 1)
        .join(" ")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();

      if (!rawStart || !rawEnd || !text) return null;

      const start = parseSrtTime(rawStart.split(/\s+/)[0]);
      const end = parseSrtTime(rawEnd.split(/\s+/)[0]);
      if (end <= start) return null;

      return {
        id: `${start}-${end}-${text}`,
        start,
        end,
        text,
      };
    })
    .filter((cue): cue is LyricCue => Boolean(cue))
    .sort((a, b) => a.start - b.start);
};

export interface CurrentLyric {
  id: string;
  text: string;
  state: "active" | "past" | "silence";
}

/**
 * Given cues sorted by start time and the current playback position, returns
 * the lyric line to show, mirroring exactly how the player renders lyrics:
 * the active line, the last line as "past", or a "♫" silence marker in gaps.
 * Shared by the player and the lyrics editor preview so they never drift.
 */
export const computeCurrentLyric = (
  cues: LyricCue[],
  currentTime: number,
  duration: number,
): CurrentLyric | null => {
  if (cues.length === 0) return null;

  const activeCue = cues.find((cue) => currentTime >= cue.start && currentTime <= cue.end);
  if (activeCue) {
    return { id: activeCue.id, text: activeCue.text, state: "active" };
  }

  const firstCue = cues[0];
  if (currentTime < firstCue.start) {
    if (firstCue.start > 2) {
      return { id: `silence-start-${firstCue.id}`, text: "♫", state: "silence" };
    }
    return null;
  }

  let previousIndex = -1;
  for (let i = 0; i < cues.length; i += 1) {
    if (currentTime > cues[i].end) previousIndex = i;
    else break;
  }

  const previousCue = previousIndex >= 0 ? cues[previousIndex] : null;
  if (previousCue) {
    const nextCue = cues[previousIndex + 1];
    if (nextCue && currentTime < nextCue.start && nextCue.start - previousCue.end > 2) {
      return { id: `silence-${previousCue.id}-${nextCue.id}`, text: "♫", state: "silence" };
    }

    const hasLongOutro = duration > 0
      ? duration - previousCue.end > 2
      : currentTime - previousCue.end > 2;
    if (!nextCue && hasLongOutro) {
      return { id: `silence-end-${previousCue.id}`, text: "♫", state: "silence" };
    }

    return { id: previousCue.id, text: previousCue.text, state: "past" };
  }

  return null;
};

/** Formats seconds as the SRT timestamp `HH:MM:SS,mmm`. */
export const formatSrtTime = (seconds: number): string => {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(ms, 3)}`;
};

export interface BuildableCue {
  start: number;
  end: number;
  text: string;
}

/**
 * Builds a valid SRT string from cues. Skips cues without text or with
 * end <= start, sorts by start time and renumbers the blocks from 1.
 */
export const buildSrt = (cues: BuildableCue[]): string => {
  return cues
    .filter((cue) => cue.text.trim() && cue.end > cue.start)
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((cue, index) => {
      return `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text.trim()}`;
    })
    .join("\n\n") + "\n";
};
