"use client";

import { Children, cloneElement, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode, type WheelEvent } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

interface InfiniteHomeCarouselProps {
  children: ReactNode;
  className?: string;
  ariaLabel: string;
  autoDirection?: "left" | "right";
}

export default function InfiniteHomeCarousel({ children, className = "", ariaLabel, autoDirection = "left" }: InfiniteHomeCarouselProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const firstSetRef = useRef<HTMLDivElement>(null);
  const adjustingRef = useRef(false);
  const [loops, setLoops] = useState(false);
  const items = Children.toArray(children);

  useEffect(() => {
    const viewport = viewportRef.current;
    const firstSet = firstSetRef.current;
    if (!viewport || !firstSet) return;
    const measure = () => {
      const styles = getComputedStyle(viewport);
      const cardWidth = Number.parseFloat(styles.getPropertyValue("--carousel-card-width")) || 190;
      const gap = Number.parseFloat(styles.columnGap || styles.gap) || 0;
      const naturalWidth = items.length * cardWidth + Math.max(0, items.length - 1) * gap;
      const shouldLoop = naturalWidth > viewport.clientWidth + 2;
      setLoops(shouldLoop);
      if (shouldLoop) requestAnimationFrame(() => {
        if (viewport.scrollLeft < 2) viewport.scrollLeft = firstSet.scrollWidth + gap;
      });
      else viewport.scrollLeft = 0;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(firstSet);
    measure();
    return () => observer.disconnect();
  }, [items.length]);

  useEffect(() => {
    if (!loops) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const timer = window.setInterval(() => {
      const hovered = viewport.parentElement?.matches(":hover") ?? false;
      if (!hovered && document.visibilityState === "visible") {
        viewport.scrollLeft += autoDirection === "left" ? 1 : -1;
      }
    }, 36);
    return () => window.clearInterval(timer);
  }, [autoDirection, loops]);

  const recenter = () => {
    if (!loops || adjustingRef.current) return;
    const viewport = viewportRef.current;
    const firstSet = firstSetRef.current;
    const gap = viewport ? Number.parseFloat(getComputedStyle(viewport).columnGap || getComputedStyle(viewport).gap) || 0 : 0;
    const width = (firstSet?.scrollWidth || 0) + gap;
    if (!viewport || !width) return;
    adjustingRef.current = true;
    if (viewport.scrollLeft <= width * 0.5) viewport.scrollLeft += width;
    else if (viewport.scrollLeft >= width * 1.5) viewport.scrollLeft -= width;
    requestAnimationFrame(() => { adjustingRef.current = false; });
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!loops || !viewportRef.current || !event.shiftKey) return;
    event.preventDefault();
    viewportRef.current.scrollLeft += event.deltaY || event.deltaX;
  };

  const nudge = (direction: -1 | 1) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollLeft += direction * Math.max(180, viewport.clientWidth * 0.72);
  };

  const renderItems = (copy: string) => items.map((child, index) => isValidElement(child)
    ? cloneElement(child as ReactElement, { key: `${copy}-${child.key ?? index}` })
    : child);

  return (
    <div
      className={`infinite-home-carousel ${loops ? "infinite-home-carousel--looping" : ""} ${className}`.trim()}
      aria-label={ariaLabel}
    >
      <div ref={viewportRef} className="infinite-home-carousel__viewport" onScroll={recenter} onWheel={onWheel}>
        {loops && <div className="infinite-home-carousel__set" aria-hidden="true">{renderItems("previous")}</div>}
        <div ref={firstSetRef} className="infinite-home-carousel__set">{renderItems("current")}</div>
        {loops && <div className="infinite-home-carousel__set" aria-hidden="true">{renderItems("next")}</div>}
      </div>
      {loops && (
        <>
          <button type="button" className="infinite-home-carousel__arrow infinite-home-carousel__arrow--left" onClick={() => nudge(1)} aria-label={`Desplazar ${ariaLabel} a la izquierda`}>
            <ChevronLeftIcon size={17} />
          </button>
          <button type="button" className="infinite-home-carousel__arrow infinite-home-carousel__arrow--right" onClick={() => nudge(-1)} aria-label={`Desplazar ${ariaLabel} a la derecha`}>
            <ChevronRightIcon size={17} />
          </button>
        </>
      )}
    </div>
  );
}
