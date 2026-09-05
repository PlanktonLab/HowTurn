import { useRef, useState } from "react";
import { X } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  title?: string;
  onClose: () => void;
  children: ReactNode;
}

const DISMISS_THRESHOLD_PX = 90;

export default function Sheet({ title, onClose, children }: Props) {
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);

  function onPointerDown(e: React.PointerEvent) {
    startY.current = e.clientY;
    setDragging(true);
    (e.target as Element).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging) return;
    const delta = e.clientY - startY.current;
    if (delta > 0) setDragY(delta); // only allow dragging down
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
      <div className="sheet-scrim" onClick={onClose} />
      <div
        className="sheet"
        style={{
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
              <div className="t-section">{title}</div>
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
