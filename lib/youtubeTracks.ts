import { radioPost, type ApiSong } from "@/lib/radioApi";

export function youtubeVideoId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let videoId = "";
    if (host === "youtu.be") videoId = url.pathname.split("/")[1] || "";
    else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.pathname === "/watch") videoId = url.searchParams.get("v") || "";
      else if (["shorts", "embed", "live"].includes(parts[0])) videoId = parts[1] || "";
    }
    return /^[a-zA-Z0-9_-]{11}$/.test(videoId) ? videoId : null;
  } catch {
    return null;
  }
}

/** The original YouTube page, not Farreo's on-demand audio endpoint. */
export function youtubeSourceUrl(songId: string): string | null {
  const match = /^youtube:([a-zA-Z0-9_-]{11})$/.exec(songId);
  return match ? `https://www.youtube.com/watch?v=${match[1]}` : null;
}

export function isYoutubeTrack(song: Pick<ApiSong, "id">) {
  return song.id.startsWith("youtube:");
}

export async function importYoutubeTrack(url: string): Promise<ApiSong> {
  const response = await radioPost<{ song: ApiSong; imported: boolean }>("/youtube-tracks/import", { url });
  return response.song;
}

/** Fetches only explicitly referenced YouTube tracks, never the public catalogue. */
export async function lookupYoutubeTracks(songIds: string[]): Promise<ApiSong[]> {
  const ids = [...new Set(songIds.filter((id) => /^youtube:[a-zA-Z0-9_-]{11}$/.test(id)))];
  if (ids.length === 0) return [];
  const result = await radioPost<{ songs: ApiSong[] }>("/youtube-tracks/lookup", { songIds: ids });
  return result.songs;
}
