"use client";

/** Shared lifecycle read for the page chrome and standalone recording view.
 * [COMP:app-web/recording-chrome]
 */
import { useEffect, useState } from "react";
import { getRecording, type RecordingSummary } from "@/lib/api/recordings";
import {
  RECORDING_PARTICIPANTS_UPDATED_EVENT,
  type RecordingParticipantsUpdatedDetail,
} from "./recording-events";

const STATUS_POLL_MS = 10_000;

export function useRecordingSummary(recordingId: string) {
  const [state, setState] = useState<{
    recordingId: string;
    summary: RecordingSummary | null;
    error: boolean;
  } | null>(null);

  useEffect(() => {
    let live = true;
    let request = 0;
    let summary: RecordingSummary | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const reload = async () => {
      clearTimeout(timer);
      const version = ++request;
      try {
        const next = await getRecording(recordingId);
        if (!live || version !== request) return;
        summary = next;
        setState({ recordingId, summary, error: false });
      } catch {
        if (!live || version !== request) return;
        // A failed poll must not turn an in-flight recording into an empty
        // completed view or stop it from discovering eventual completion.
        setState({ recordingId, summary, error: summary === null });
      } finally {
        const inFlight =
          summary?.status === "queued" || summary?.status === "processing" ||
          (summary?.status === "awaiting_upload" && (summary.durationMs ?? 0) <= 0);
        if (live && version === request && inFlight) {
          timer = setTimeout(() => void reload(), STATUS_POLL_MS);
        }
      }
    };

    const onParticipantsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<RecordingParticipantsUpdatedDetail>).detail;
      if (detail?.recordingId === recordingId) void reload();
    };
    void reload();
    window.addEventListener(RECORDING_PARTICIPANTS_UPDATED_EVENT, onParticipantsUpdated);
    return () => {
      live = false;
      clearTimeout(timer);
      window.removeEventListener(RECORDING_PARTICIPANTS_UPDATED_EVENT, onParticipantsUpdated);
    };
  }, [recordingId]);

  return state?.recordingId === recordingId
    ? state
    : { recordingId, summary: null, error: false };
}
