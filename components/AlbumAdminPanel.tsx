"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarClockIcon, ChevronDownIcon, ChevronUpIcon, Disc3Icon, PencilIcon, PlusIcon, TrashIcon, XIcon } from "lucide-react";
import {
  addAlbumTrack,
  createAlbum,
  deleteAlbum,
  getAdminAlbum,
  listAlbums,
  removeAlbumTrack,
  reorderAlbumTracks,
  updateAlbum,
  updateAlbumTrack,
  type AlbumCard,
  type AlbumDetail,
} from "@/lib/albums";
import { getMediaUrl } from "@/lib/radioApi";
import SongArtwork from "@/components/SongArtwork";

interface AdminSong {
  id: string;
  name: string;
  iconUrl?: string | null;
}

export default function AlbumAdminPanel({
  songs,
  onMessage,
  onChanged,
}: {
  songs: AdminSong[];
  onMessage: (type: "success" | "error", text: string) => void;
  onChanged: () => void | Promise<void>;
}) {
  const [albums, setAlbums] = useState<AlbumCard[]>([]);
  const [editor, setEditor] = useState<AlbumDetail | "new" | null>(null);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<File | null>(null);
  const [revelation, setRevelation] = useState(false);
  const [songQuery, setSongQuery] = useState("");
  const [selectedSong, setSelectedSong] = useState("");
  const [releaseAt, setReleaseAt] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    const data = await listAlbums();
    setAlbums(data);
    await onChanged();
  };

  useEffect(() => { void refresh().catch(() => setAlbums([])); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredSongs = useMemo(() => {
    const query = songQuery.trim().toLowerCase();
    return songs.filter(song => !query || song.name.toLowerCase().includes(query)).slice(0, 60);
  }, [songQuery, songs]);

  const openNew = () => {
    setEditor("new");
    setName("");
    setIcon(null);
    setRevelation(false);
  };

  const openEdit = async (album: AlbumCard) => {
    try {
      const detail = await getAdminAlbum(album.id);
      setEditor(detail);
      setName(detail.nombre);
      setIcon(null);
      setRevelation(detail.revelationEnabled);
    } catch (reason) {
      onMessage("error", reason instanceof Error ? reason.message : "No se pudo abrir el álbum.");
    }
  };

  const saveMetadata = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const form = new FormData();
      form.append("nombre", name.trim());
      form.append("revelationEnabled", String(revelation));
      if (icon) form.append("icon", icon);
      if (editor === "new") {
        const result = await createAlbum(form);
        await refresh();
        await openEdit({ id: result.id } as AlbumCard);
        onMessage("success", "Álbum creado.");
      } else if (editor) {
        await updateAlbum(editor.id, form);
        const detail = await getAdminAlbum(editor.id);
        setEditor(detail);
        await refresh();
        onMessage("success", "Álbum actualizado.");
      }
    } catch (reason) {
      onMessage("error", reason instanceof Error ? reason.message : "No se pudo guardar el álbum.");
    } finally {
      setSaving(false);
    }
  };

  const addTrack = async () => {
    if (!editor || editor === "new" || !selectedSong) return;
    try {
      await addAlbumTrack(editor.id, { songId: selectedSong, releaseAt: releaseAt ? new Date(releaseAt).toISOString() : null });
      setEditor(await getAdminAlbum(editor.id));
      setSelectedSong("");
      setReleaseAt("");
      await refresh();
    } catch (reason) {
      onMessage("error", reason instanceof Error ? reason.message : "No se pudo añadir la canción.");
    }
  };

  const move = async (index: number, direction: -1 | 1) => {
    if (!editor || editor === "new") return;
    const next = [...editor.tracks];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setEditor({ ...editor, tracks: next });
    try {
      await reorderAlbumTracks(editor.id, next.map(track => track.entryId));
    } catch (reason) {
      onMessage("error", reason instanceof Error ? reason.message : "No se pudo reordenar.");
      setEditor(await getAdminAlbum(editor.id));
    }
  };

  const remove = async (entryId: string) => {
    if (!editor || editor === "new" || !window.confirm("¿Quitar esta canción del álbum?")) return;
    await removeAlbumTrack(editor.id, entryId);
    setEditor(await getAdminAlbum(editor.id));
    await refresh();
  };

  const changeSchedule = async (entryId: string, value: string) => {
    if (!editor || editor === "new") return;
    try {
      await updateAlbumTrack(editor.id, entryId, value ? new Date(value).toISOString() : null);
      setEditor(await getAdminAlbum(editor.id));
      await refresh();
    } catch (reason) {
      onMessage("error", reason instanceof Error ? reason.message : "No se pudo cambiar el estreno.");
    }
  };

  return (
    <section className="playlist-admin__section album-admin">
      <div className="playlist-admin__section-header">
        <h2 className="playlist-admin__section-title"><Disc3Icon size={20} /> Álbumes</h2>
        <button type="button" className="playlist-admin__btn-create" onClick={openNew}><PlusIcon size={16} /> Nuevo álbum</button>
      </div>
      <div className="playlist-admin__list">
        {albums.map(album => (
          <div key={album.id} className="playlist-admin__item playlist-admin__item--playlist">
            <div className="playlist-admin__item-index"><SongArtwork src={getMediaUrl(album.iconUrl)} alt={album.nombre} className="playlist-admin__playlist-icon" /></div>
            <div className="playlist-admin__item-info"><strong>{album.nombre}</strong><small>{album.revelationEnabled ? "En revelación" : "Publicado"}</small></div>
            <div className="playlist-admin__item-date">
              {album.numCanciones - (album.scheduledCount || 0)} publicadas · {album.scheduledCount || 0} programadas
              {album.revelationEnabled ? ` · ${Math.max(0, album.numCanciones - (album.scheduledCount || 0))} por revelar` : ""}
            </div>
            <div className="playlist-admin__item-actions">
              <button type="button" className="playlist-admin__item-edit" onClick={() => void openEdit(album)}><PencilIcon size={16} /></button>
              <button type="button" className="playlist-admin__item-delete" onClick={() => {
                if (!window.confirm(`¿Eliminar el álbum "${album.nombre}"?`)) return;
                void deleteAlbum(album.id).then(refresh).catch(reason => onMessage("error", reason.message));
              }}><TrashIcon size={16} /></button>
            </div>
          </div>
        ))}
        {albums.length === 0 && <p className="playlist-admin__empty">No hay álbumes.</p>}
      </div>

      {editor && (
        <div className="playlist-admin__modal-overlay" onClick={() => setEditor(null)}>
          <div className="playlist-admin__modal album-admin__modal" onClick={event => event.stopPropagation()}>
            <div className="playlist-admin__modal-header"><h3>{editor === "new" ? "Nuevo álbum" : `Editar ${editor.nombre}`}</h3><button type="button" className="playlist-admin__btn-cancel-small" onClick={() => setEditor(null)}><XIcon /></button></div>
            <label className="playlist-admin__upload-form-group"><span className="playlist-admin__upload-form-label">Nombre</span><input className="playlist-admin__upload-form-input" value={name} onChange={event => setName(event.target.value)} /></label>
            <label className="playlist-admin__upload-form-group"><span className="playlist-admin__upload-form-label">Icono</span><input type="file" accept="image/*" className="playlist-admin__upload-form-input" onChange={event => setIcon(event.target.files?.[0] || null)} /></label>
            <label className="album-admin__toggle"><input type="checkbox" checked={revelation} onChange={event => setRevelation(event.target.checked)} /><span>Modo Revelación</span></label>
            <button type="button" className="playlist-admin__upload-btn" disabled={saving} onClick={() => void saveMetadata()}>{saving ? "Guardando..." : "Guardar propiedades"}</button>

            {editor !== "new" && (
              <>
                <div className="album-admin__add">
                  <h4><PlusIcon size={16} /> Añadir canción</h4>
                  <input className="playlist-admin__upload-form-input" placeholder="Buscar canción" value={songQuery} onChange={event => setSongQuery(event.target.value)} />
                  <div className="album-admin__song-picker">
                    {filteredSongs.map(song => (
                      <button key={song.id} type="button" className={selectedSong === song.id ? "album-admin__song-choice album-admin__song-choice--selected" : "album-admin__song-choice"} onClick={() => setSelectedSong(song.id)}>
                        <SongArtwork src={getMediaUrl(song.iconUrl)} alt={song.name} /> <span>{song.name}</span>
                      </button>
                    ))}
                  </div>
                  <label><span>Estreno opcional</span><input type="datetime-local" className="playlist-admin__upload-form-input" value={releaseAt} onChange={event => setReleaseAt(event.target.value)} /></label>
                  <button type="button" className="playlist-admin__upload-btn" disabled={!selectedSong} onClick={() => void addTrack()}>Añadir al álbum</button>
                </div>

                <div className="album-admin__tracks">
                  {editor.tracks.map((track, index) => (
                    <div key={track.entryId} className="album-admin__track">
                      <SongArtwork src={getMediaUrl(track.song?.iconUrl)} alt={track.song?.name || "Canción"} />
                      <div><strong>{track.song?.name || "Canción no encontrada"}</strong><small>{track.releaseAt ? `Estreno: ${new Date(track.releaseAt).toLocaleString("es-ES")}` : "Publicación inmediata"}</small></div>
                      <input type="datetime-local" defaultValue={track.releaseAt ? new Date(new Date(track.releaseAt).getTime() - new Date(track.releaseAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ""} onBlur={event => void changeSchedule(track.entryId, event.target.value)} />
                      <button type="button" onClick={() => void move(index, -1)} disabled={index === 0}><ChevronUpIcon /></button>
                      <button type="button" onClick={() => void move(index, 1)} disabled={index === editor.tracks.length - 1}><ChevronDownIcon /></button>
                      <button type="button" onClick={() => void remove(track.entryId)}><TrashIcon /></button>
                    </div>
                  ))}
                  {editor.tracks.length === 0 && <p className="playlist-admin__empty"><CalendarClockIcon size={18} /> Añade canciones y decide cuándo se estrenan.</p>}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
