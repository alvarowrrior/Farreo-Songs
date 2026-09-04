"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { RadioIcon } from "lucide-react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";
import {
  addSongToRadioQueue,
  type RadioSongInsertMode,
  type RadioSongPitchMode,
} from "@/lib/radioSongActions";
import { getMediaUrl } from "@/lib/radioApi";
import {
  getThemeDiscovery,
  type ThemeDiscoveryPayload,
  type ThemeDiscoverySong,
} from "@/lib/themeDiscovery";
import styles from "./DesktopSongRadioContextEnhancer.module.scss";

type ContextPoint = {
  x: number;
  y: number;
  song: ThemeDiscoverySong;
};

const POSITIONS: Array<{
  value: RadioSongInsertMode;
  label: string;
  short: string;
}> = [
  { value: "last", label: "Añadir al final", short: "al final" },
  { value: "next", label: "Añadir segunda", short: "como segunda" },
  { value: "now", label: "Reproducción inmediata", short: "en reproducción inmediata" },
];

// Hosts that are definitely a song interaction surface. These are the only
// places where Farreo may create its own fallback menu when the page does not
// already provide one.
const STRICT_SONG_HOST_SELECTOR = [
  ".playlist-song-table__row",
  ".album-track",
  ".app-sidebar__song-result",
  ".song-discovery__row",
  ".playlist-admin__recommendation-card--daily",
  ".playlist-admin__now-playing",
  ".song-info-sidebar__artwork",
  ".song-info-sidebar__advanced-cover-artwork",
  ".song-info-sidebar__song",
].join(",");

// Broader hosts are kept only so we can augment an EXISTING Farreo song menu.
// They are deliberately forbidden from creating the radio-only fallback menu:
// CSS-module class fragments such as "songCard" can occur on containers whose
// empty/background regions are not themselves song interaction targets.
const SONG_HOST_SELECTOR = [
  STRICT_SONG_HOST_SELECTOR,
  ".song-info-sidebar__body",
  "[class*='songResult']",
  "[class*='songRow']",
  "[class*='songCard']",
  "[class*='SongResult']",
  "[class*='SongRow']",
  "[class*='SongCard']",
].join(",");

const normalize = (value: string) => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .trim();

const clampPitch = (value: number) => (
  Math.max(0.5, Math.min(1.5, Number.isFinite(value) ? value : 1))
);

const comparableUrl = (value?: string | null) => {
  if (!value || typeof window === "undefined") return "";
  try {
    return new URL(getMediaUrl(value), window.location.href).href;
  } catch {
    return getMediaUrl(value);
  }
};

function findSongHost(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(SONG_HOST_SELECTOR);
}

function isStrictSongTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(STRICT_SONG_HOST_SELECTOR));
}

function candidateNames(host: HTMLElement) {
  const values: Array<{ name: string; imageUrl?: string }> = [];

  const images = Array.from(host.querySelectorAll<HTMLImageElement>("img[alt]"));
  if (host instanceof HTMLImageElement && host.alt) images.unshift(host);

  images.forEach((image) => {
    const name = image.alt.trim();
    if (name) values.push({ name, imageUrl: image.currentSrc || image.src });
  });

  const selectors = [
    ".playlist-song-table__song-title",
    ".album-track__copy strong",
    ".app-sidebar__song-result-text > span",
    ".song-discovery__play-row strong",
    ".playlist-admin__recommendation-copy small",
    ".playlist-admin__now-playing-title",
    "strong",
    "[title]",
  ];

  selectors.forEach((selector) => {
    host.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      const text = selector === "[title]"
        ? element.getAttribute("title") || ""
        : element.textContent || "";
      const name = text.trim();
      if (name && name.length <= 180) values.push({ name });
    });
  });

  return values;
}

function resolveSong(
  host: HTMLElement,
  data: ThemeDiscoveryPayload,
  songsByName: Map<string, ThemeDiscoverySong[]>,
) {
  for (const candidate of candidateNames(host)) {
    const matches = songsByName.get(normalize(candidate.name)) || [];
    if (matches.length === 0) continue;
    if (matches.length === 1) return matches[0];

    if (candidate.imageUrl) {
      const imageUrl = comparableUrl(candidate.imageUrl);
      const artworkMatch = matches.find((song) => {
        const songUrl = comparableUrl(song.iconUrl);
        if (!songUrl || !imageUrl) return false;
        return songUrl === imageUrl
          || new URL(songUrl, window.location.href).pathname === new URL(imageUrl, window.location.href).pathname;
      });
      if (artworkMatch) return artworkMatch;
    }

    return matches[0];
  }

  const hostText = Array.from(host.querySelectorAll<HTMLElement>("strong, span"))
    .map((element) => normalize(element.textContent || ""))
    .filter(Boolean);

  for (const text of hostText) {
    const matches = songsByName.get(text);
    if (matches?.length) return matches[0];
  }

  return null;
}

function visibleMenus() {
  return Array.from(document.querySelectorAll<HTMLElement>(
    ".farreo-context-menu, .playlist-song-table__menu--fixed",
  )).filter((menu) => {
    const style = window.getComputedStyle(menu);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

function closestMenuToPoint(
  x: number,
  y: number,
  menusVisibleBefore: Set<HTMLElement>,
) {
  // Only consider a menu that became visible because of THIS context-click.
  // This prevents an already-open Farreo menu elsewhere on the page from being
  // mistaken for the song menu we are trying to augment.
  const menus = visibleMenus().filter((menu) => !menusVisibleBefore.has(menu));
  if (menus.length === 0) return null;

  return menus
    .map((menu) => {
      const rect = menu.getBoundingClientRect();
      const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
      const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      return { menu, distance: Math.hypot(dx, dy) };
    })
    .sort((left, right) => left.distance - right.distance)[0]?.menu || null;
}

function pitchLabel(pitch: RadioSongPitchMode) {
  if (pitch.kind === "random") return "pitch aleatorio";
  if (Math.abs(pitch.pitch - 1) < 0.0001) return "pitch x1";
  return `pitch x${pitch.pitch.toFixed(2)}`;
}

function FallbackRadioMenu({
  point,
  onAdd,
  onClose,
}: {
  point: ContextPoint;
  onAdd: (insertAt: RadioSongInsertMode, pitch: RadioSongPitchMode) => void;
  onClose: () => void;
}) {
  const [customPitch, setCustomPitch] = useState("1.00");
  const flip = point.x + 450 > window.innerWidth;
  const style: CSSProperties = {
    left: Math.min(point.x, Math.max(8, window.innerWidth - 210)),
    top: Math.min(point.y, Math.max(8, window.innerHeight - 190)),
  };

  useEffect(() => {
    const close = () => onClose();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  return (
    <div
      className={styles.fallbackMenu}
      data-farreo-radio-flip={flip ? "true" : "false"}
      style={style}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className={styles.menuEntry}>
        <button type="button" className={styles.menuButton}>
          <RadioIcon size={16} className={styles.radioSourceIcon} />
          <span>Añadir a la radio</span>
          <span className={styles.arrow}>›</span>
        </button>

        <div className={styles.positionPanel}>
          {POSITIONS.map((position) => (
            <div key={position.value} className={styles.positionEntry}>
              <button type="button" className={styles.menuButton}>
                <span className={styles.positionDot} />
                <span>{position.label}</span>
                <span className={styles.arrow}>›</span>
              </button>

              <div className={styles.pitchPanel}>
                <button
                  type="button"
                  className={styles.pitchButton}
                  onClick={() => onAdd(position.value, { kind: "random" })}
                >
                  <span>🎲</span><span>Pitch aleatorio</span>
                </button>
                <button
                  type="button"
                  className={styles.pitchButton}
                  onClick={() => onAdd(position.value, { kind: "fixed", pitch: 1 })}
                >
                  <span>1×</span><span>Pitch x1</span>
                </button>
                <div className={styles.customPitch}>
                  <span>x Pitch</span>
                  <input
                    type="number"
                    min={0.5}
                    max={1.5}
                    step={0.01}
                    value={customPitch}
                    onChange={(event) => setCustomPitch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        onAdd(position.value, { kind: "fixed", pitch: clampPitch(Number(customPitch)) });
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => onAdd(position.value, { kind: "fixed", pitch: clampPitch(Number(customPitch)) })}
                  >
                    Añadir
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function DesktopSongRadioContextEnhancer() {
  const catalogueRef = useRef<ThemeDiscoveryPayload | null>(null);
  const songsByNameRef = useRef<Map<string, ThemeDiscoverySong[]>>(new Map());
  const catalogueRequestRef = useRef<Promise<ThemeDiscoveryPayload> | null>(null);
  const requestSerialRef = useRef(0);
  const noticeTimerRef = useRef<number | null>(null);

  const [fallback, setFallback] = useState<ContextPoint | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const showNotice = (type: "success" | "error", text: string) => {
    setNotice({ type, text });
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 2800);
  };

  const indexCatalogue = (data: ThemeDiscoveryPayload) => {
    const map = new Map<string, ThemeDiscoverySong[]>();
    data.songs.forEach((song) => {
      const key = normalize(song.name);
      const current = map.get(key) || [];
      current.push(song);
      map.set(key, current);
    });
    catalogueRef.current = data;
    songsByNameRef.current = map;
    return data;
  };

  const ensureCatalogue = () => {
    if (catalogueRef.current) return Promise.resolve(catalogueRef.current);
    if (catalogueRequestRef.current) return catalogueRequestRef.current;

    catalogueRequestRef.current = getThemeDiscovery()
      .then(indexCatalogue)
      .finally(() => {
        catalogueRequestRef.current = null;
      });

    return catalogueRequestRef.current;
  };

  const closeInjectedMenu = (menu: HTMLElement) => {
    try {
      window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    } catch {
      // PointerEvent may be unavailable in old test environments.
    }

    try {
      menu.dispatchEvent(new MouseEvent("mouseout", {
        bubbles: true,
        relatedTarget: document.body,
      }));
    } catch {
      // Best effort.
    }
  };

  const addToRadio = async (
    song: ThemeDiscoverySong,
    insertAt: RadioSongInsertMode,
    pitch: RadioSongPitchMode,
    menu?: HTMLElement | null,
  ) => {
    try {
      await addSongToRadioQueue(song.id, { insertAt, pitch });
      const position = POSITIONS.find((item) => item.value === insertAt)?.short || "en la radio";
      showNotice("success", `“${song.name}” añadida ${position} · ${pitchLabel(pitch)}.`);
    } catch (error) {
      showNotice(
        "error",
        error instanceof Error ? error.message : "No se pudo añadir la canción a la radio.",
      );
    } finally {
      if (menu) closeInjectedMenu(menu);
      setFallback(null);
    }
  };

  const createRadioIconNode = () => {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add(styles.radioSourceIcon);

    const paths = [
      "M4.9 19.1C1 15.2 1 8.8 4.9 4.9",
      "M7.8 16.2a6 6 0 0 1 0-8.5",
      "M16.2 7.8a6 6 0 0 1 0 8.5",
      "M19.1 4.9C23 8.8 23 15.1 19.1 19",
    ];
    paths.forEach((d) => {
      const path = document.createElementNS(namespace, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    });

    const circle = document.createElementNS(namespace, "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "2");
    svg.appendChild(circle);

    return svg;
  };

  const makeMenuButton = (
    label: string,
    className: string,
    leadingText = "",
  ) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;

    const leading = document.createElement("span");
    leading.className = styles.rawLeading;
    leading.textContent = leadingText;

    const copy = document.createElement("span");
    copy.textContent = label;

    const arrow = document.createElement("span");
    arrow.className = styles.injectedArrow;
    arrow.textContent = "›";

    button.append(leading, copy, arrow);
    return button;
  };

  const injectIntoMenu = (menu: HTMLElement, song: ThemeDiscoverySong) => {
    if (menu.querySelector("[data-farreo-radio-song-entry]")) return;

    const flip = menu.getBoundingClientRect().right + 450 > window.innerWidth;

    const entry = document.createElement("div");
    entry.dataset.farreoRadioSongEntry = song.id;
    entry.dataset.farreoRadioFlip = flip ? "true" : "false";
    entry.className = styles.injectedEntry;

    const parent = makeMenuButton("Añadir a la radio", styles.injectedButton);
    parent.setAttribute("aria-haspopup", "menu");
    const parentLeading = parent.firstElementChild;
    if (parentLeading) {
      parentLeading.textContent = "";
      parentLeading.appendChild(createRadioIconNode());
    }

    const positionPanel = document.createElement("div");
    positionPanel.className = styles.positionPanel;
    positionPanel.setAttribute("role", "menu");

    POSITIONS.forEach((position) => {
      const positionEntry = document.createElement("div");
      positionEntry.className = styles.positionEntry;

      const positionButton = makeMenuButton(position.label, styles.injectedButton, "•");
      positionButton.setAttribute("aria-haspopup", "menu");

      const pitchPanel = document.createElement("div");
      pitchPanel.className = styles.pitchPanel;
      pitchPanel.setAttribute("role", "menu");

      const addChoice = (label: string, badge: string, pitch: RadioSongPitchMode) => {
        const choice = document.createElement("button");
        choice.type = "button";
        choice.className = styles.pitchButton;

        const badgeNode = document.createElement("span");
        badgeNode.textContent = badge;
        const labelNode = document.createElement("span");
        labelNode.textContent = label;
        choice.append(badgeNode, labelNode);

        choice.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void addToRadio(song, position.value, pitch, menu);
        });
        pitchPanel.appendChild(choice);
      };

      addChoice("Pitch aleatorio", "🎲", { kind: "random" });
      addChoice("Pitch x1", "1×", { kind: "fixed", pitch: 1 });

      const custom = document.createElement("div");
      custom.className = styles.customPitch;

      const customLabel = document.createElement("span");
      customLabel.textContent = "x Pitch";

      const input = document.createElement("input");
      input.type = "number";
      input.min = "0.5";
      input.max = "1.5";
      input.step = "0.01";
      input.value = "1";

      const submit = document.createElement("button");
      submit.type = "button";
      submit.textContent = "Añadir";

      const submitCustom = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        const value = clampPitch(Number(input.value));
        input.value = value.toFixed(2);
        void addToRadio(song, position.value, { kind: "fixed", pitch: value }, menu);
      };

      input.addEventListener("pointerdown", (event) => event.stopPropagation());
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") submitCustom(event);
      });
      submit.addEventListener("click", submitCustom);

      custom.append(customLabel, input, submit);
      pitchPanel.appendChild(custom);

      positionEntry.append(positionButton, pitchPanel);
      positionPanel.appendChild(positionEntry);
    });

    entry.append(parent, positionPanel);
    menu.appendChild(entry);
  };

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, () => {
      catalogueRef.current = null;
      songsByNameRef.current = new Map();
      catalogueRequestRef.current = null;
    });
  }, []);

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      // A new context-click always invalidates a previous fallback menu.
      setFallback(null);

      const host = findSongHost(event.target);
      if (!host) return;
      if (host.closest(".playlist-admin__recommendation-card--concealed")) return;

      const strictTarget = isStrictSongTarget(event.target);
      const menusVisibleBefore = new Set(visibleMenus());

      // Only suppress the browser menu when the click is definitely on a song
      // surface for which we are allowed to provide our own fallback.
      // Broader/ambiguous hosts are left untouched unless their own Farreo
      // context menu appears later in this same event.
      if (strictTarget) event.preventDefault();

      const serial = ++requestSerialRef.current;
      const point = { x: event.clientX, y: event.clientY };

      void ensureCatalogue()
        .then((data) => {
          if (requestSerialRef.current !== serial || !host.isConnected) return;
          const song = resolveSong(host, data, songsByNameRef.current);
          if (!song) return;

          window.requestAnimationFrame(() => {
            if (requestSerialRef.current !== serial) return;
            const menu = closestMenuToPoint(point.x, point.y, menusVisibleBefore);
            if (menu) {
              injectIntoMenu(menu, song);
              setFallback(null);
              return;
            }

            // Never manufacture a radio-only menu from a fuzzy/broad match.
            if (strictTarget) setFallback({ ...point, song });
          });
        })
        .catch(() => undefined);
    };

    window.addEventListener("contextmenu", handleContextMenu, true);
    return () => {
      window.removeEventListener("contextmenu", handleContextMenu, true);
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {fallback ? (
        <FallbackRadioMenu
          point={fallback}
          onClose={() => setFallback(null)}
          onAdd={(insertAt, pitch) => void addToRadio(fallback.song, insertAt, pitch)}
        />
      ) : null}

      {notice ? (
        <div className={`${styles.notice} ${notice.type === "error" ? styles.noticeError : ""}`} role="status">
          {notice.text}
        </div>
      ) : null}
    </>
  );
}
