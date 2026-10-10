#!/usr/bin/env python3
"""Apply the Farreo YouTube song integration to an existing checkout.

Usage: python apply_farreo_youtube.py [repository-root] [--check]

New source files live inside this ZIP under backend/, components/ and lib/.
Existing files are edited in place only after all exact patch anchors are
validated, avoiding accidental partial or unrelated rewrites.
"""
import sys
from pathlib import Path

ROOT = Path(next((a for a in sys.argv[1:] if not a.startswith('--')), '.')).resolve()
DRY_RUN = '--check' in sys.argv
changes = {}

for added in (
    'backend/youtubeTracks.js',
    'components/YouTubeSongImport.tsx',
    'components/YouTubeSongImport.module.scss',
    'lib/youtubeTracks.ts',
):
    if not (ROOT / added).is_file():
        raise RuntimeError(f'Falta el archivo nuevo {added}; extrae TODO el ZIP en la raiz del proyecto antes de aplicar.')


def update(path, operations):
    target = ROOT / path
    if not target.is_file():
        raise RuntimeError(f'Archivo ausente: {path}')
    original = target.read_text(encoding='utf8')
    content = original
    for title, old, new in operations:
        count = content.count(old)
        if count != 1:
            if new in content:
                raise RuntimeError(f'{path}: el cambio "{title}" ya parece aplicado; usa una rama limpia o verifica manualmente.')
            raise RuntimeError(f'{path}: referencia "{title}" no unica (apariciones: {count}); no se ha modificado nada.')
        content = content.replace(old, new, 1)
    changes[target] = (original, content)


update('backend/server.js', [
    ('catalogue setup',
     "const songThemeStore = createSongThemeStore({ storage: BASE_DIR, songsDirectory: CANCIONES_DIR });",
     "const songThemeStore = createSongThemeStore({ storage: BASE_DIR, songsDirectory: CANCIONES_DIR });\nconst { createYouTubeSongCatalog } = require('./youtubeTracks');\nconst youtubeSongCatalog = createYouTubeSongCatalog(BASE_DIR);"),
    ('catalogue lookup',
     "    const canciones = await Promise.all(audioFiles.map(file => buildSongResponse(file, ensureDuration)));\n    canciones.sort((a, b) => b.createdAt.seconds - a.createdAt.seconds);",
     "    const canciones = await Promise.all(audioFiles.map(file => buildSongResponse(file, ensureDuration)));\n    canciones.push(...youtubeSongCatalog.listSongs());\n    canciones.sort((a, b) => b.createdAt.seconds - a.createdAt.seconds);"),
    ('track source serialization',
     "        id: song.id,\n        name: song.name,\n        url: song.url,\n        iconUrl: song.iconUrl || null,",
     "        id: song.id,\n        name: song.name,\n        url: song.url,\n        provider: song.provider || null,\n        youtubeUrl: song.youtubeUrl || null,\n        iconUrl: song.iconUrl || null,"),
    ('registration',
     "registerYoutubeRoutes({ app, requireAdmin: albumApi.requireAdmin });",
     "registerYoutubeRoutes({ app, requireAdmin: albumApi.requireAdmin });\nyoutubeSongCatalog.registerRoutes(app);"),
])

update('components/RadioPage.tsx', [
    ('import',
     'import { useHiddenSongs } from "@/lib/useHiddenSongs";',
     'import { useHiddenSongs } from "@/lib/useHiddenSongs";\nimport YouTubeSongImport from "@/components/YouTubeSongImport";'),
    ('radio URL action',
     '''                <div className="radio-page__song-results">
                  {filteredSongs.map((song) => (''',
     '''                <YouTubeSongImport
                  value={songQuery}
                  label="Importar y añadir a la radio"
                  onImported={async (song) => {
                    await radioPost<RadioState>("/radio/queue/songs", {
                      songIds: [song.id],
                      ...addOptions(),
                    });
                    setSongs((current) => [song, ...current.filter((entry) => entry.id !== song.id)]);
                    setSongQuery("");
                    setMessage({ type: "success", text: `"${song.name}" añadida a la radio.` });
                  }}
                />
                <div className="radio-page__song-results">
                  {filteredSongs.map((song) => ('''),
])

update('components/PrivatePlaylistPlayer.tsx', [
    ('import',
     'import SongArtwork from "@/components/SongArtwork";',
     'import SongArtwork from "@/components/SongArtwork";\nimport YouTubeSongImport from "@/components/YouTubeSongImport";'),
    ('private picker URL action',
     '''          </div>
          <div className="playlist-admin__song-picker-list">
            {filteredPickerSongs.length === 0 ? (''',
     '''          </div>
          <YouTubeSongImport
            value={songSearchQuery}
            label="Importar y añadir a esta playlist"
            onImported={async (song) => {
              if (!playlist) throw new Error("Playlist no encontrada.");
              await addSongToPrivatePlaylist(playlist.id, song.id);
              const updated = await getPrivatePlaylist(playlist.id);
              if (!updated) throw new Error("Playlist no encontrada.");
              setPlaylist(updated);
              await loadSongsForPlaylist(updated);
              setSongSearchQuery("");
              setShowSongPicker(false);
              setMessage({ type: "success", text: `"${song.name}" añadida.` });
              window.dispatchEvent(new Event("farreo:library-updated"));
            }}
          />
          <div className="playlist-admin__song-picker-list">
            {filteredPickerSongs.length === 0 ? ('''),
])

update('components/PlaylistLibrary.tsx', [
    ('import',
     'import SongArtwork from "@/components/SongArtwork";',
     'import SongArtwork from "@/components/SongArtwork";\nimport YouTubeSongImport from "@/components/YouTubeSongImport";'),
    ('library picker URL action',
     '''              </div>
              <div className="playlist-admin__song-picker-list">
                {filteredPickerSongs.length === 0 ? (''',
     '''              </div>
              {playlistScope === "private" && (
                <YouTubeSongImport
                  value={songSearchQuery}
                  label="Importar y añadir a la playlist"
                  onImported={async (song) => {
                    if (!playlistActual) throw new Error("Playlist no encontrada.");
                    await addSongToPrivatePlaylist(playlistActual, song.id);
                    const updated = privatePlaylists.map((item) =>
                      item.id === playlistActual && !item.songIds.includes(song.id)
                        ? { ...item, songIds: [...item.songIds, song.id] }
                        : item
                    );
                    setPrivatePlaylists(updated);
                    const current = updated.find((item) => item.id === playlistActual);
                    if (current) await loadPrivatePlaylistCanciones(current.songIds);
                    setShowSongPicker(false);
                    setSongSearchQuery("");
                    setMessage({ type: "success", text: `"${song.name}" añadida.` });
                    window.dispatchEvent(new Event("farreo:library-updated"));
                  }}
                />
              )}
              <div className="playlist-admin__song-picker-list">
                {filteredPickerSongs.length === 0 ? ('''),
])

update('app/mobile/page.tsx', [
    ('import',
     'import SongArtwork from "@/components/SongArtwork";',
     'import SongArtwork from "@/components/SongArtwork";\nimport YouTubeSongImport from "@/components/YouTubeSongImport";'),
    ('share YouTube source URL',
     '''    const farreoUrl = `${window.location.origin}/play?song=${encodeURIComponent(song.id)}`;
    const mediaUrl = getMediaUrl(song.url);''',
     '''    const farreoUrl = `${window.location.origin}/play?song=${encodeURIComponent(song.id)}`;
    const youtubeSource = song.id.startsWith("youtube:");
    const mediaUrl = youtubeSource
      ? `https://www.youtube.com/watch?v=${song.id.slice("youtube:".length)}`
      : getMediaUrl(song.url);'''),
    ('share label',
     '''          label: "Copiar enlace del MP3",
          detail: "Archivo de audio directo",''',
     '''          label: youtubeSource ? "Copiar enlace de YouTube" : "Copiar enlace del MP3",
          detail: youtubeSource ? "Vídeo original" : "Archivo de audio directo",'''),
    ('share success message',
     '''          onSelect: () => copyShareLink(mediaUrl, "Enlace del MP3 copiado."),''',
     '''          onSelect: () => copyShareLink(mediaUrl, youtubeSource ? "Enlace de YouTube copiado." : "Enlace del MP3 copiado."),'''),
    ('mobile search URL action',
     '''          </label>
          {hiddenLoading ? (
            <div className="mobile-farreo__empty">Preparando busqueda...</div>''',
     '''          </label>
          <YouTubeSongImport
            value={query}
            label="Importar canción desde YouTube"
            onImported={(song) => {
              setSongs((current) => [song, ...current.filter((entry) => entry.id !== song.id)]);
              setQuery("");
              setActionSheet({
                title: song.name,
                subtitle: "Canción importada de YouTube",
                items: [
                  { label: "Añadir a playlist", icon: <PlusIcon size={18} />, onSelect: () => openAddToPlaylistSheet(song) },
                  { label: "Añadir a radio", icon: <RadioIcon size={18} />, onSelect: () => void addSongToRadio(song) },
                  { label: "Reproducir", icon: <PlayIcon size={18} />, onSelect: () => void playSong(song) },
                ],
              });
            }}
          />
          {hiddenLoading ? (
            <div className="mobile-farreo__empty">Preparando busqueda...</div>'''),
])

print('Farreo YouTube Integration - preflight completado')
for target, (old, new) in changes.items():
    print(f'  {target.relative_to(ROOT)}: {len(old)} -> {len(new)} caracteres')
if DRY_RUN:
    print('Modo --check: no se han modificado archivos.')
else:
    # Stage writes first to avoid truncating a source file mid-save.
    temporary_files = []
    try:
        for target, (_, content) in changes.items():
            temporary = target.with_name(target.name + '.farreo-youtube.tmp')
            temporary.write_text(content, encoding='utf8')
            temporary_files.append((temporary, target))
        for temporary, target in temporary_files:
            temporary.replace(target)
    finally:
        for temporary, _ in temporary_files:
            if temporary.exists():
                temporary.unlink()
    print('5 archivos existentes modificados. Los archivos nuevos deben haberse extraido del ZIP.')
