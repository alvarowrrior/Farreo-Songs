"use client";

import { radioPost, type RadioState } from "@/lib/radioApi";

export type RadioSongInsertMode = "last" | "next" | "now";
export type RadioSongPitchMode =
  | { kind: "random" }
  | { kind: "fixed"; pitch: number };

export interface AddSongToRadioOptions {
  insertAt: RadioSongInsertMode;
  pitch: RadioSongPitchMode;
}

const clampPitch = (value: number) => (
  Math.max(0.5, Math.min(1.5, Number.isFinite(value) ? value : 1))
);

/**
 * Adds one song to the shared radio without joining the current browser.
 * `next` means second in the effective queue (right after the current item);
 * `now` promotes it to immediate playback on the shared radio.
 */
export async function addSongToRadioQueue(
  songId: string,
  options: AddSongToRadioOptions,
) {
  if (!songId) throw new Error("Canción no válida.");

  const randomPitch = options.pitch.kind === "random";
  const pitch = options.pitch.kind === "fixed"
    ? clampPitch(options.pitch.pitch)
    : undefined;

  return radioPost<RadioState>("/radio/queue/songs", {
    songIds: [songId],
    insertAt: options.insertAt,
    randomPitch,
    pitch,
    addedBy: "web",
  });
}
