type DurationEntry = { duration?: number | null };

export function getPlaylistDurationSeconds(entries: DurationEntry[]) {
  return entries.reduce((total, entry) => {
    const duration = Number(entry.duration);
    return Number.isFinite(duration) && duration > 0 ? total + duration : total;
  }, 0);
}

export function formatPlaylistDuration(entries: DurationEntry[]) {
  const totalSeconds = getPlaylistDurationSeconds(entries);
  if (totalSeconds <= 0) return "0 min";

  const totalMinutes = Math.max(1, Math.round(totalSeconds / 60));
  if (totalMinutes < 60) return `${totalMinutes} min`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
}
