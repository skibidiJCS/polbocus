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
    <dialog ref={ref} className="confirm-dialog" aria-labelledby="delete-title" onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
      <h2 id="delete-title">Delete “{video.originalName}”?</h2>
      {video.hasProviderCopy ? (
        <p>This video was sent to TwelveLabs. Choose what to remove. Deleting the TwelveLabs copy removes the uploaded asset and its index entry; it cannot be undone.</p>
      ) : (
        <p>Nothing from this video is stored at TwelveLabs yet. Deleting removes the local file and its library entry.</p>
      )}
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="danger-button" onClick={() => confirm(true)} disabled={busy} autoFocus>
          {busy ? "Deleting…" : video.hasProviderCopy ? "Delete here and at TwelveLabs" : "Delete"}
        </button>
        {video.hasProviderCopy && (
          <button className="secondary-button" onClick={() => confirm(false)} disabled={busy}>
            Delete local copy only
          </button>
        )}
        <button className="text-button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      {video.hasProviderCopy && <small>“Local copy only” keeps the video in your TwelveLabs index; you can remove it later in the TwelveLabs Playground.</small>}
    </dialog>
  );
}
