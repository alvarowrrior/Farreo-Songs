"use client";

import { useMemo, useState } from "react";
import { CheckIcon, ChevronDownIcon, PlusIcon, SearchIcon, TagIcon, Trash2Icon, XIcon } from "lucide-react";
import type { SongTheme } from "@/lib/songThemes";

interface SongThemeSelectorProps {
  themes: SongTheme[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  onCreate: (name: string) => Promise<SongTheme>;
  onDelete: (theme: SongTheme) => Promise<void>;
}

const normalize = (value: string) => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .trim();

export default function SongThemeSelector({ themes, selectedIds, onChange, onCreate, onDelete }: SongThemeSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const normalizedQuery = normalize(query);
  const selectedThemes = themes.filter(theme => selectedSet.has(theme.id));
  const filteredThemes = themes.filter(theme => !normalizedQuery || normalize(theme.name).includes(normalizedQuery));
  const exactMatch = themes.some(theme => normalize(theme.name) === normalizedQuery);

  const toggleTheme = (themeId: string) => {
    onChange(selectedSet.has(themeId)
      ? selectedIds.filter(id => id !== themeId)
      : [...selectedIds, themeId]);
  };

  const handleCreate = async () => {
    const name = query.trim();
    if (!name || exactMatch || creating) return;
    setCreating(true);
    setError("");
    try {
      const theme = await onCreate(name);
      if (!selectedSet.has(theme.id)) onChange([...selectedIds, theme.id]);
      setQuery("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo crear el tema.");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (theme: SongTheme) => {
    if (deletingId || !window.confirm(`Borrar el tema "${theme.name}"? Se quitara de todas las canciones.`)) return;
    setDeletingId(theme.id);
    setError("");
    try {
      await onDelete(theme);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo borrar el tema.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className={`song-theme-selector${open ? " song-theme-selector--open" : ""}`}>
      <button
        type="button"
        className="song-theme-selector__toggle"
        onClick={() => setOpen(current => !current)}
        aria-expanded={open}
      >
        <span className="song-theme-selector__toggle-label">
          <TagIcon size={16} />
          Temas
          {selectedIds.length > 0 && <span className="song-theme-selector__count">{selectedIds.length}</span>}
        </span>
        <span className="song-theme-selector__summary">
          <span>{selectedIds.length === 0 ? "Sin asignar" : selectedThemes.map(theme => theme.name).join(", ")}</span>
          <ChevronDownIcon size={16} />
        </span>
      </button>

      {open && (
        <div className="song-theme-selector__panel">
          <p className="song-theme-selector__hint">Solo son visibles en administración.</p>
          {selectedThemes.length > 0 && (
            <div className="song-theme-selector__selected" aria-label="Temas seleccionados">
              {selectedThemes.map(theme => (
                <button key={theme.id} type="button" onClick={() => toggleTheme(theme.id)}>
                  {theme.name}<XIcon size={13} />
                </button>
              ))}
            </div>
          )}

          <div className="song-theme-selector__search">
            <SearchIcon size={16} />
            <input
              value={query}
              onChange={event => { setQuery(event.target.value); setError(""); }}
              onKeyDown={event => {
                if (event.key === "Enter" && normalizedQuery && !exactMatch) {
                  event.preventDefault();
                  void handleCreate();
                }
              }}
              placeholder="Buscar un tema"
              maxLength={48}
            />
          </div>

          <div className="song-theme-selector__results">
            {filteredThemes.map(theme => (
              <div key={theme.id} className="song-theme-selector__option-row">
                <button
                  type="button"
                  className={selectedSet.has(theme.id) ? "song-theme-selector__option song-theme-selector__option--selected" : "song-theme-selector__option"}
                  onClick={() => toggleTheme(theme.id)}
                >
                  <span>{theme.name}</span>
                  {selectedSet.has(theme.id) && <CheckIcon size={16} />}
                </button>
                <button
                  type="button"
                  className="song-theme-selector__delete"
                  onClick={() => void handleDelete(theme)}
                  disabled={deletingId === theme.id}
                  title={`Borrar ${theme.name}`}
                  aria-label={`Borrar tema ${theme.name}`}
                >
                  <Trash2Icon size={15} />
                </button>
              </div>
            ))}
            {filteredThemes.length === 0 && (!normalizedQuery || exactMatch) && (
              <p className="song-theme-selector__empty">No hay temas coincidentes.</p>
            )}
          </div>

          {normalizedQuery && !exactMatch && (
            <button type="button" className="song-theme-selector__create" onClick={() => void handleCreate()} disabled={creating}>
              <PlusIcon size={16} />
              {creating ? "Creando..." : `Crear “${query.trim()}”`}
            </button>
          )}
          {error && <p className="song-theme-selector__error">{error}</p>}
        </div>
      )}
    </div>
  );
}
