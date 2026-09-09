"use client";

/** Shared lifecycle read for the page chrome and standalone recording view.
 * [COMP:app-web/recording-chrome]
 */
import { useEffect } from "react";
import { getRecording, type RecordingSummary } from "@/lib/api/recordings";
import { useCachedResource } from "@/lib/surface-cache";
import { recordingDetailCacheKey } from "@/lib/surface-prefetch";
import {
  RECORDING_PARTICIPANTS_UPDATED_EVENT,
  type RecordingParticipantsUpdatedDetail,
} from "./recording-events";

const STATUS_POLL_MS = 10_000;

export function useRecordingSummary(workspaceId: string, recordingId: string) {
  const key = recordingDetailCacheKey(workspaceId, recordingId);
  const resource = useCachedResource<RecordingSummary>(
    key,
    () => getRecording(recordingId),
  );

  useEffect(() => {
    const summary = resource.data;
    const inFlight =
      summary?.status === "queued" || summary?.status === "processing" ||
      (summary?.status === "awaiting_upload" && (summary.durationMs ?? 0) <= 0);
    if (!inFlight) return;
    const timer = setTimeout(() => void resource.refresh(), STATUS_POLL_MS);
    return () => clearTimeout(timer);
  }, [resource.data, resource.attemptedAt, resource.refresh]);

  useEffect(() => {
    const onParticipantsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<RecordingParticipantsUpdatedDetail>).detail;
      if (detail?.recordingId === recordingId) void resource.refresh();
    };
    window.addEventListener(RECORDING_PARTICIPANTS_UPDATED_EVENT, onParticipantsUpdated);
    return () => {
      window.removeEventListener(RECORDING_PARTICIPANTS_UPDATED_EVENT, onParticipantsUpdated);
    };
  }, [recordingId, resource.refresh]);

  return {
    recordingId,
    summary: resource.data ?? null,
    error: resource.data === undefined && resource.error !== undefined,
  };
}
