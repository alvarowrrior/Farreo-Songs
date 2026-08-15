"use client";

import { useEffect, useMemo, useState, type MouseEvent, type PointerEvent } from "react";
import {
  CheckIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  TagIcon,
  Trash2Icon,
} from "lucide-react";
import { createPortal } from "react-dom";
import { listSongThemes, type SongTheme } from "@/lib/songThemes";
import styles from "@/components/SongThemeSelector.module.scss";

interface SongThemeSelectorProps {
  themes: SongTheme[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  onCreate: (name: string) => Promise<SongTheme>;
  onDelete: (theme: SongTheme) => Promise<void>;
  onCatalogChange?: (themes: SongTheme[]) => void;
}

const normalize = (value: string) => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .trim();

const sortThemes = (themes: SongTheme[]) => [...themes].sort((left, right) => (
  left.name.localeCompare(right.name, "es", { sensitivity: "base" })
));

export default function SongThemeSelector({
  themes,
  selectedIds,
  onChange,
  onCreate,
  onDelete,
  onCatalogChange,
}: SongThemeSelectorProps) {
  const [catalog, setCatalog] = useState<SongTheme[]>(() => sortThemes(themes));
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    theme: SongTheme;
  } | null>(null);

  useEffect(() => {
    setCatalog(sortThemes(themes));
  }, [themes]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const normalizedQuery = normalize(query);
  const filteredThemes = useMemo(() => catalog.filter((theme) => (
    !normalizedQuery || normalize(theme.name).includes(normalizedQuery)
  )), [catalog, normalizedQuery]);
  const exactMatch = catalog.some((theme) => normalize(theme.name) === normalizedQuery);

  const publishCatalog = (nextCatalog: SongTheme[]) => {
    const sorted = sortThemes(nextCatalog);
    setCatalog(sorted);
    onCatalogChange?.(sorted);
    return sorted;
  };

  const toggleTheme = (themeId: string) => {
    onChange(selectedSet.has(themeId)
      ? selectedIds.filter((id) => id !== themeId)
      : [...selectedIds, themeId]);
  };

  const handleCreate = async () => {
    const name = query.trim();
    if (!name || exactMatch || creating) return;
    setCreating(true);
    setError("");
    try {
      const theme = await onCreate(name);
      publishCatalog([...catalog.filter((item) => item.id !== theme.id), theme]);
      if (!selectedSet.has(theme.id)) onChange([...selectedIds, theme.id]);
      setQuery("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo crear el tema.");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (theme: SongTheme) => {
    if (deletingId) return;
    if (!window.confirm(`Borrar el tema “${theme.name}”? Se quitará de todas las canciones.`)) return;
    setDeletingId(theme.id);
    setError("");
    try {
      await onDelete(theme);
      const nextCatalog = publishCatalog(catalog.filter((item) => item.id !== theme.id));
      const valid = new Set(nextCatalog.map((item) => item.id));
      onChange(selectedIds.filter((id) => valid.has(id)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo borrar el tema.");
    } finally {
      setDeletingId(null);
      setContextMenu(null);
    }
  };

  const refreshCatalog = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError("");
    try {
      const fresh = publishCatalog(await listSongThemes());
      const valid = new Set(fresh.map((theme) => theme.id));
      const nextSelected = selectedIds.filter((id) => valid.has(id));
      if (nextSelected.length !== selectedIds.length) onChange(nextSelected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudieron actualizar las etiquetas.");
    } finally {
      setRefreshing(false);
    }
  };

  const placeDeleteMenu = (clientX: number, clientY: number, theme: SongTheme) => {
    const width = 220;
    const height = 48;
    const x = typeof window === "undefined" ? clientX : Math.max(8, Math.min(clientX, window.innerWidth - width - 8));
    const y = typeof window === "undefined" ? clientY : Math.max(8, Math.min(clientY, window.innerHeight - height - 8));
    setContextMenu({ x, y, theme });
  };

  const openDeleteMenu = (event: MouseEvent, theme: SongTheme) => {
    event.preventDefault();
    event.stopPropagation();
    placeDeleteMenu(event.clientX, event.clientY, theme);
  };

  const catchRightPointer = (event: PointerEvent<HTMLButtonElement>, theme: SongTheme) => {
    if (event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    placeDeleteMenu(event.clientX, event.clientY, theme);
  };

  return (
    <div className={styles.selector}>
      <div className={styles.header}>
        <div className={styles.title}>
          <span className={styles.titleIcon}><TagIcon size={16} /></span>
          <span>
            <strong>Temas</strong>
            <small>{selectedIds.length} seleccionados · {catalog.length} disponibles</small>
          </span>
        </div>
        <button
          type="button"
          className={styles.refresh}
          onClick={() => void refreshCatalog()}
          disabled={refreshing}
          title="Volver a pedir las etiquetas al servidor"
        >
          <RefreshCwIcon size={15} className={refreshing ? styles.spin : ""} />
          Actualizar
        </button>
      </div>

      <div className={styles.searchRow}>
        <div className={styles.search}>
          <SearchIcon size={15} />
          <input
            value={query}
            onChange={(event) => { setQuery(event.target.value); setError(""); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && normalizedQuery && !exactMatch) {
                event.preventDefault();
                void handleCreate();
              }
            }}
            placeholder="Buscar o crear una etiqueta..."
            maxLength={48}
          />
        </div>
        {normalizedQuery && !exactMatch && (
          <button type="button" className={styles.create} onClick={() => void handleCreate()} disabled={creating}>
            {creating ? <RefreshCwIcon size={15} className={styles.spin} /> : <PlusIcon size={15} />}
            {creating ? "Creando" : "Crear"}
          </button>
        )}
      </div>

      <div className={styles.cloud} aria-label="Etiquetas disponibles">
        {filteredThemes.map((theme) => {
          const selected = selectedSet.has(theme.id);
          return (
            <button
              key={theme.id}
              type="button"
              className={`${styles.chip} ${selected ? styles.chipSelected : ""}`}
              onClick={() => toggleTheme(theme.id)}
              onPointerDown={(event) => catchRightPointer(event, theme)}
              onContextMenuCapture={(event) => openDeleteMenu(event, theme)}
              title={`${selected ? "Quitar" : "Añadir"} ${theme.name} · click derecho para eliminar la etiqueta`}
            >
              {selected ? <CheckIcon size={13} /> : <SparklesIcon size={12} />}
              <span>{theme.name}</span>
            </button>
          );
        })}
        {filteredThemes.length === 0 && (
          <div className={styles.empty}>
            {normalizedQuery ? "No hay etiquetas que coincidan." : "No hay etiquetas todavía."}
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <span>Click para marcar · click derecho para eliminar globalmente</span>
        {selectedIds.length > 0 && (
          <button type="button" onClick={() => onChange([])}>Quitar selección</button>
        )}
      </div>

      {error && <p className={styles.error}>{error}</p>}

      {contextMenu && typeof document !== "undefined" && createPortal(
        <div
          className={styles.contextMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          role="menu"
        >
          <button
            type="button"
            className={styles.contextDelete}
            disabled={deletingId === contextMenu.theme.id}
            onClick={() => void handleDelete(contextMenu.theme)}
            role="menuitem"
          >
            <Trash2Icon size={15} />
            <span>{deletingId === contextMenu.theme.id ? "Eliminando…" : `Eliminar “${contextMenu.theme.name}”`}</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
