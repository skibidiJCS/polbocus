"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Full-window drop target. Appears while a file is dragged over the page, framed by
 * camera-viewfinder corners, and hands the dropped file to `onFile`.
 */
export function DropOverlay({ onFile, enabled = true }: { onFile: (file: File) => void; enabled?: boolean }) {
  const [active, setActive] = useState(false);
  // Latest handler without re-subscribing (which would reset the drag counter mid-drag).
  const onFileRef = useRef(onFile);
  useEffect(() => {
    onFileRef.current = onFile;
  });

  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth++;
      setActive(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setActive(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setActive(false);
      const file = event.dataTransfer?.files[0];
      if (file) onFileRef.current(file);
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        depth = 0;
        setActive(false);
      }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("keydown", cancel);
    };
  }, [enabled]);

  return (
    <div className={`drop-overlay ${active ? "is-active" : ""}`} aria-hidden={!active} role="presentation">
      <span className="vf vf-tl" />
      <span className="vf vf-tr" />
      <span className="vf vf-bl" />
      <span className="vf vf-br" />
      <div className="drop-overlay-body">
        <p className="drop-overlay-title">Drop to upload</p>
      </div>
    </div>
  );
}
