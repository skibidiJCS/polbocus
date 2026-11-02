"use client";

import { useEffect, useRef, useState } from "react";
import type { VideoSummary } from "@/types/video";

export function DeleteDialog({ video, onCancel, onConfirm }: {
  video: VideoSummary;
  onCancel: () => void;
  onConfirm: (includeProvider: boolean) => Promise<string | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  async function confirm(includeProvider: boolean) {
    setBusy(true);
    setError(null);
    const failure = await onConfirm(includeProvider);
    setBusy(false);
    if (failure) setError(failure);
  }

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="delete-title"
      onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}
    >
      <div className="dialog-body">
        <h2 id="delete-title">Delete <em>{video.originalName}</em>?</h2>
        {video.hasProviderCopy ? (
          <p>It was sent to TwelveLabs. You can remove it everywhere, or only from this computer. Removing the TwelveLabs copy deletes the uploaded asset and its index entry — that can’t be undone.</p>
        ) : (
          <p>Nothing from this video is stored at TwelveLabs. The local file and its library entry will be removed.</p>
        )}
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="button-solid is-danger" onClick={() => confirm(true)} disabled={busy} autoFocus>
            {busy ? "Deleting…" : video.hasProviderCopy ? "Delete everywhere" : "Delete"}
          </button>
          {video.hasProviderCopy && (
            <button className="button-ghost" onClick={() => confirm(false)} disabled={busy}>This computer only</button>
          )}
          <button className="link-button" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
        {video.hasProviderCopy && <p className="dialog-fine">“This computer only” leaves the video in your TwelveLabs index. You can remove it later in the TwelveLabs Playground.</p>}
      </div>
    </dialog>
  );
}
