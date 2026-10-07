// The webcam, on for as long as an exam is open. It is only shown to the student for now;
// nothing is recorded or sent anywhere.

import { useRef, useState } from "react";
import { CameraPicture, useCamera, type CameraEventKind } from "./useCamera";
import { useCameraWatch, type WatchEventKind } from "./useCameraWatch";

export type { CameraEventKind };
export type PreviewEventKind = CameraEventKind | WatchEventKind;

const TILE_WIDTH = 160;
const TILE_HEIGHT = 120;
const EDGE_MARGIN = 16;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function CameraPreview({
  onEvent,
}: {
  onEvent: (kind: PreviewEventKind, detail: string, data?: Record<string, unknown>) => void;
}) {
  const camera = useCamera(onEvent);

  useCameraWatch(
    () => (camera.source === "app" ? camera.image.current : camera.video.current),
    camera.source !== null && camera.problem === null,
    onEvent,
  );

  // The tile can be dragged anywhere the student likes (it can sit over the text they're
  // writing) - tracked as distance from the bottom-right corner, where it starts.
  const [pos, setPos] = useState({ bottom: EDGE_MARGIN, right: EDGE_MARGIN });
  const drag = useRef<{ pointerId: number; startX: number; startY: number; startBottom: number; startRight: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, startBottom: pos.bottom, startRight: pos.right };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || drag.current.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.current.startX;
    const dy = e.clientY - drag.current.startY;
    setPos({
      right: clamp(drag.current.startRight - dx, 0, window.innerWidth - TILE_WIDTH),
      bottom: clamp(drag.current.startBottom - dy, 0, window.innerHeight - TILE_HEIGHT),
    });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  if (camera.problem) {
    return (
      <div role="alert" className="fixed bottom-4 right-4 z-40 w-64 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-magi-destructive">
        Camera isn't available ({camera.problem}). The exam goes on, and this is recorded.
      </div>
    );
  }

  return (
    <div
      style={{ bottom: pos.bottom, right: pos.right, width: TILE_WIDTH }}
      className="fixed z-40 rounded-lg overflow-hidden border border-magi-border bg-black shadow-lg cursor-move select-none touch-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDragStart={(e) => e.preventDefault()}
    >
      <CameraPicture camera={camera} />
      <p className="px-2 py-1 bg-magi-white text-[11px] font-semibold text-magi-primary flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-magi-destructive" />
        {camera.source === null ? "Starting camera…" : "Camera on"}
      </p>
    </div>
  );
}
