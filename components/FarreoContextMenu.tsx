"use client";

import { useEffect, type ReactNode } from "react";
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
      className="farreo-context-menu"
      style={{ left: x, top: y }}
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
