"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import styles from "./FarreoContextMenu.module.scss";
import { createPortal } from "react-dom";

export interface FarreoContextMenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children?: FarreoContextMenuItem[];
}

interface FarreoContextMenuProps {
  x: number;
  y: number;
  items: FarreoContextMenuItem[];
  onClose: () => void;
}

export default function FarreoContextMenu({ x, y, items, onClose }: FarreoContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ x, y, flip: false });

  useLayoutEffect(() => {
    const update = () => {
      const el = menuRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const nx = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
      const ny = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
      const flip = nx + rect.width + 240 > window.innerWidth;
      setBounds((old) => old.x === nx && old.y === ny && old.flip === flip ? old : {x:nx, y:ny, flip});
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [x, y, items.length]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      className={`farreo-context-menu ${styles.menu}`}
      data-flip={bounds.flip ? "true" : "false"}
      style={{ left: bounds.x, top: bounds.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      role="menu"
    >
      {items.map((item) => (
        <div key={item.label} className="farreo-context-menu__entry">
          <button
            type="button"
            className={`farreo-context-menu__item ${item.danger ? "farreo-context-menu__item--danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled || item.children?.length) return;
              item.onSelect();
              onClose();
            }}
            role="menuitem"
          >
            {item.icon}
            <span>{item.label}</span>
            {item.children?.length ? <span aria-hidden="true">›</span> : null}
          </button>
          {item.children?.length ? (
            <div className="farreo-context-menu__submenu" role="menu">
              {item.children.map(child => (
                <button
                  key={child.label}
                  type="button"
                  className={`farreo-context-menu__item ${child.danger ? "farreo-context-menu__item--danger" : ""}`}
                  disabled={child.disabled}
                  onClick={() => {
                    if (child.disabled) return;
                    child.onSelect();
                    onClose();
                  }}
                  role="menuitem"
                >
                  {child.icon}
                  <span>{child.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>,
    document.body
  );
}
