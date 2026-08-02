export const playlistActivityTime = (...values: Array<string | null | undefined>) => {
  for (const value of values) {
    if (!value) continue;
    const time = new Date(value).getTime();
    if (Number.isFinite(time)) return time;
  }
  return 0;
};
