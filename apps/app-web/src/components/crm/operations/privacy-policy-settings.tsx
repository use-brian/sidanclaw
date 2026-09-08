"use client";

/** Member-approved replay retention. [COMP:app-web/crm-operations] */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { getCrmPrivacyPolicy, saveCrmPrivacyPolicy, type CrmPrivacyPolicy } from "@/lib/api/crm";
import { useT } from "@/lib/i18n/client";

export function CrmPrivacyPolicySettings({ workspaceId }: { workspaceId: string }) {
  const t = useT().crmPage.operations;
  const [policy, setPolicy] = useState<CrmPrivacyPolicy | null>(null);
  const [seconds, setSeconds] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    setPolicy(null); setSaved(false);
    try {
      const value = await getCrmPrivacyPolicy(workspaceId);
      setPolicy(value); setSeconds(value.policy.intakeReplay?.retentionSeconds.toString() ?? ""); setError(null);
    } catch { setError(t.replayPolicyLoadFailed); }
  }, [workspaceId, t.replayPolicyLoadFailed]);
  useEffect(() => { void load(); }, [load]);
  const valid = seconds === "" || (/^\d+$/.test(seconds) && Number(seconds) >= 1 && Number(seconds) <= 2147483647);
  async function save() {
    if (!policy || busy || !valid) return;
    setBusy(true);
    try {
      if (!await confirmDialog({ title: t.replayPolicyTitle,
        description: `${t.replayPolicyConfirm} ${seconds === "" ? t.replayPolicyUnconfigured : `${seconds} ${t.replayPolicySeconds}`}`,
        confirmLabel: t.replayPolicyApprove, cancelLabel: t.cancel })) return;
      const value = await saveCrmPrivacyPolicy(workspaceId, { expectedVersion: policy.version,
        confirmed: true, intakeReplay: seconds === "" ? null : { retentionSeconds: Number(seconds) } });
      setPolicy(value.record); setError(null); setSaved(true);
    } catch { setSaved(false); setError(t.replayPolicySaveFailed); }
    finally { setBusy(false); }
  }
  return <section className="mt-4 rounded-xl border border-border p-3" aria-label={t.replayPolicyTitle}>
    <h4 className="text-xs font-semibold">{t.replayPolicyTitle}</h4>
    <p className="mt-1 text-xs text-muted-foreground">{t.replayPolicyHelp}</p>
    <p className="mt-1 text-xs">{t.replayPolicyVersion}: {policy?.version ?? "?"}</p>
    <label className="mt-3 flex flex-col gap-1 text-xs">{t.replayPolicySeconds}
      <input type="number" min={1} max={2147483647} step={1} value={seconds}
        disabled={busy || !policy} aria-invalid={!valid}
        className="rounded-md border border-border bg-background p-2"
        placeholder={t.replayPolicyUnconfigured}
        onChange={(event) => { setSeconds(event.target.value); setSaved(false); }} />
    </label>
    <div className="mt-2 flex gap-2">
      <Button size="xs" disabled={busy || !policy || !valid} onClick={() => void save()}>{t.replayPolicyApprove}</Button>
      <Button size="xs" variant="outline" disabled={busy} onClick={() => void load()}>{t.refresh}</Button>
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    {saved && <p role="status" className="mt-2 text-xs">{t.replayPolicySaved}</p>}
  </section>;
}
