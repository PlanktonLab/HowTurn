import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  title?: string;
  onClose: () => void;
  children: ReactNode;
  variant?: "modal" | "route";
}

const DISMISS_THRESHOLD_PX = 90;

export default function Sheet({ title, onClose, children, variant = "modal" }: Props) {
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  const [viewport, setViewport] = useState({ height: window.visualViewport?.height ?? window.innerHeight, bottom: 0 });

  useEffect(() => {
    const update = () => {
      const view = window.visualViewport;
      setViewport({ height: view?.height ?? window.innerHeight, bottom: view ? Math.max(0, window.innerHeight - view.height - view.offsetTop) : 0 });
    };
    update();
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, []);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (variant === "modal" && !dialog.current?.contains(previous)) dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (variant !== "modal" || event.key !== "Tab") return;
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]') ?? []);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (variant === "modal" && previous?.isConnected) previous.focus(); };
  }, [variant]);

  function onPointerDown(e: React.PointerEvent) {
    if ((e.target as Element).closest("button")) return;
    startY.current = e.clientY;
    setDragging(true);
    (e.target as Element).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging) return;
    const delta = e.clientY - startY.current;
    setDragY(Math.max(0, delta)); // only allow dragging down
  }
  function onPointerUp() {
    setDragging(false);
    if (dragY > DISMISS_THRESHOLD_PX) {
      onClose();
    }
    setDragY(0);
  }

  return (
    <>
      {variant === "modal" && <div className="sheet-scrim" onClick={onClose} />}
      <div
        className={`sheet ${variant === "route" ? "sheet-route" : ""}`}
        ref={dialog}
        role="dialog"
        aria-modal={variant === "modal" ? "true" : undefined}
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : variant === "route" ? "路線預覽" : "詳細資訊"}
        tabIndex={-1}
        style={{
          height: variant === "route" ? Math.round(Math.min(380, Math.max(320, viewport.height * 0.34))) : undefined,
          maxHeight: variant === "route" ? `calc(${viewport.height}px - var(--safe-t) - 120px)` : `calc(${viewport.height}px - var(--safe-t) - 18px)`,
          bottom: viewport.bottom > 0 ? viewport.bottom : undefined,
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: dragging ? "none" : undefined,
        }}
      >
        <div
          className="sheet-drag-zone"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="sheet-grabber" />
          {title && (
            <div className="sheet-head">
              <div className="t-section" id={titleId}>{title}</div>
              <button className="sheet-close" onClick={onClose} aria-label="關閉">
                <X size={16} />
              </button>
            </div>
          )}
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </>
  );
}
