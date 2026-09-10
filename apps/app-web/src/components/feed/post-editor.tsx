"use client";

/**
 * One post, edited in place (feed-revamp.md §8a, D15-D18).
 *
 * Left: the post itself — title, version chips, the caption editor, and the
 * actions its state allows. Right: the refine chat, hosted by the shared
 * `TuningChatPanel` against THIS post's session rather than a sticky channel.
 * There is no "open to iterate" any more: this IS the surface, and the post
 * list that used to sit beside it lives in the sidebar.
 *
 * Versions (D17): the assistant's `proposeDrafts` alternatives are immutable
 * chips; the first keystroke forks one into the operator's own version, so an
 * edit never overwrites what the model wrote and a re-proposal never
 * overwrites the edit. `Use this version` commits whichever is shown.
 *
 * [COMP:app-web/feed-post-editor]
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check,
  Copy,
  Heart,
  Link2,
  MessageCircle,
  MessageSquareText,
  Pencil,
  Plus,
  Repeat2,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { brandPreviewIdentity } from "@/lib/feed-brand";
import type { BrandRecord } from "@use-brian/shared/brand";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { StatusLabel } from "@/components/feed/feed-status";
import { CaptionEditor } from "@/components/feed/caption-editor";
import { BrandCheck } from "@/components/feed/brand-check";
import { PostMediaTray } from "@/components/feed/post-media-tray";
import type { PostMedia } from "@/lib/feed-media";
import { TuningChatPanel } from "@/components/feed/tuning-chat-panel";
import { PlanMobileSheet } from "@/components/feed/plan-mobile-sheet";
import { useLgViewport } from "@/components/feed/use-lg-viewport";
import { Skeleton } from "@/components/skeleton";
import {
  PeekResizeHandle,
  usePeekResize,
} from "@/components/operator/resizable-peek";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { webAppUrl } from "@/lib/primary-auth";
import {
  approveFeedDraft,
  deleteFeedDraftSession,
  fetchFeedDraftSessions,
  fetchFeedSavedDrafts,
  markFeedReadyPostPosted,
  rejectFeedDraft,
  saveFeedSessionDraft,
  type FeedDraftSessionSummary,
  type FeedSavedDraft,
} from "@/lib/api/feed";
import {
  extractMessageText,
} from "@/lib/api/sessions";
import { feedPath, feedPostPath, type FeedPlatform } from "@/lib/feed-nav";
import {
  displayPostTitle,
  postQueueStatus,
  type PostQueueStatus,
} from "@/lib/feed-posts";
import { notifyFeedPostsChanged } from "@/lib/feed-posts-events";
import {
  buildVersions,
  counterState,
  parseFeedPostBriefSeed,
  postFormatsForPlatform,
  resolveSelectedVersion,
  type FeedArticleFields,
  type FeedPostFormat,
  type ProposedDraft,
} from "@/lib/feed-post-versions";
import { useGlobalDockRecorder } from "@/lib/recorder/dock-recorder-bridge";

import { useIsOffline } from "@/lib/offline/use-offline-sync";
import { feedCachedJson } from "@/lib/offline/feed-cache";
import {
  FEED_LOCAL_CHANGED, blankFeedContent, createLocalFeedPost, loadFeedWorkingCopy,
  patchFeedWorkingCopy, readLocalFeedPost, forkLocalFeedPost,
  readFeedNewPostForm, writeFeedNewPostForm,
  type FeedWorkingContent, type LocalFeedPost,
} from "@/lib/offline/feed-offline";

const PROPOSE_DRAFTS_TOOL = "proposeDrafts";

/**
 * Replay `proposeDrafts` tool calls out of the session history into the
 * current alternatives. Upsert by index: reusing an index revises that
 * alternative, a new index adds one. Defensive throughout — a half-streamed
 * or malformed call must be ignored, never crash the pane.
 */
export function replayProposals(
  rows: readonly { role?: string; content?: unknown }[],
): ProposedDraft[] {
  const byIndex = new Map<number, ProposedDraft>();
  for (const row of rows) {
    if (row.role !== "assistant" || !Array.isArray(row.content)) continue;
    for (const block of row.content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b.type !== "tool_use" || b.name !== PROPOSE_DRAFTS_TOOL) continue;
      const input = b.input as { drafts?: unknown } | null;
      if (!input || !Array.isArray(input.drafts)) continue;
      for (const entry of input.drafts) {
        if (typeof entry !== "object" || entry === null) continue;
        const d = entry as Record<string, unknown>;
        const index =
          typeof d.index === "number" && Number.isInteger(d.index)
            ? d.index
            : null;
        const text = typeof d.text === "string" ? d.text : null;
        if (index === null || index < 1 || !text) continue;
        byIndex.set(index, {
          index,
          text,
          ...(typeof d.label === "string" ? { label: d.label } : {}),
          ...(typeof d.imageBrief === "string"
            ? { imageBrief: d.imageBrief }
            : {}),
        });
      }
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

type SavedComposition = Pick<
  FeedSavedDraft,
  "draftText" | "postedText" | "postFormat" | "threadSegments" | "article" | "media"
>;

/** Compare editor state with the persisted review version. Article fields are
 * checked individually because jsonb does not preserve object-key order. */
export function compositionHasChanges(args: {
  format: FeedPostFormat;
  text: string;
  threadSegments: string[];
  article: FeedArticleFields;
  saved: SavedComposition | null;
}): boolean {
  const { format, text, threadSegments, article, saved } = args;
  if (!saved) return false;
  if (format !== (saved.postFormat ?? "post")) return true;
  if (text.trim() !== (saved.draftText ?? saved.postedText ?? "").trim()) return true;
  if (format === "thread") {
    return JSON.stringify(threadSegments.map((part) => part.trim()))
      !== JSON.stringify((saved.threadSegments ?? []).map((part) => part.trim()));
  }
  if (format === "article") {
    return article.sourceUrl !== (saved.article?.sourceUrl ?? "")
      || article.title !== (saved.article?.title ?? "")
      || article.description !== (saved.article?.description ?? "");
  }
  return false;
}

export function PostEditor({
  platform,
  sessionId,
}: {
  platform: FeedPlatform;
  sessionId: string | null;
}) {
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  const te = t.postEditor;

  const assistant = team.profiles[0]?.assistant ?? team.assistants[0] ?? null;
  const assistantId = assistant?.id ?? null;

  if (!assistantId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {te.loadFailed}
      </div>
    );
  }
  if (!sessionId) {
    return (
      <NewPost
        assistantId={assistantId}
        platform={platform}
        workspaceId={team.workspaceId}
      />
    );
  }
  return (
    <PostPane
      key={sessionId}
      assistantId={assistantId}
      assistantName={assistant?.name ?? ""}
      assistantIconSeed={
        assistant && "iconSeed" in assistant ? assistant.iconSeed : undefined
      }
      platform={platform}
      sessionId={sessionId}
      workspaceId={team.workspaceId}
      connected={team.profiles.some((profile) => profile.platform === platform)}
    />
  );
}

/** The `+ New post` target: name it, then the editor opens on the real post. */
function NewPost({
  assistantId,
  platform,
  workspaceId,
}: {
  assistantId: string;
  platform: FeedPlatform;
  workspaceId: string;
}) {
  const t = useT().feedPage;
  const te = t.postEditor;
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [postFormat, setPostFormat] = useState<FeedPostFormat>("post");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formats = postFormatsForPlatform(platform);
  const { canDraft } = useFeedWorkspace();
  const [formReady, setFormReady] = useState(false);
  const formRef = useRef(blankFeedContent());
  useEffect(() => {
    let cancelled = false;
    void readFeedNewPostForm(assistantId, platform).then((form) => {
      if (cancelled) return;
      if (form) {
        formRef.current = form;
        setTitle(form.title); setBrief(form.privateBrief); setPostFormat(form.postFormat);
      }
      setFormReady(true);
    });
    return () => { cancelled = true; };
  }, [assistantId, platform]);
  function saveForm(patch: Partial<FeedWorkingContent>) {
    formRef.current = { ...formRef.current, ...patch };
    void writeFeedNewPostForm(assistantId, platform, formRef.current)
      .catch(() => setError(te.localSaveFailed));
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      if (!canDraft) return;
      const post = await createLocalFeedPost(assistantId, platform, {
        ...blankFeedContent(), title: title.trim(), privateBrief: brief, postFormat,
      });
      await writeFeedNewPostForm(assistantId, platform, blankFeedContent()).catch(() => {});
      router.push(feedPostPath(workspaceId, platform, post.session.id));
    } catch {
      setError(te.localSaveFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-muted/15">
      <div className="grid min-h-full w-full lg:grid-cols-[minmax(0,1.08fr)_minmax(340px,0.92fr)]">
        <main className="flex items-center border-b border-border/60 bg-background px-5 py-8 sm:px-8 lg:border-b-0 lg:border-r lg:px-10 xl:px-14">
          <div className="mx-auto w-full max-w-2xl space-y-8 lg:mx-0">
            <header className="space-y-3">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                <PlatformIcon platform={platform} className="size-3.5" />
                {te.newPostEyebrow}
              </div>
              <div className="space-y-2">
                <h1 className="text-xl font-semibold tracking-tight">
                  {te.newPost}
                </h1>
                <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
                  {te.newPostBody}
                </p>
              </div>
            </header>

            <div className="space-y-2">
              <div>
                <label htmlFor="feed-post-title" className="text-[12.5px] font-medium">
                  {te.newPostTitleLabel}
                </label>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {te.newPostTitleHint}
                </p>
              </div>
              <input
                id="feed-post-title"
                type="text"
                maxLength={200}
                value={title}
                onChange={(e) => { setTitle(e.target.value); saveForm({ title: e.target.value }); }}
                placeholder={te.newPostTitlePlaceholder}
                disabled={busy || !formReady || !canDraft}
                className="h-10 w-full rounded-xl border border-border/70 bg-background px-3.5 text-[16px] md:text-sm shadow-xs disabled:opacity-50"
              />
            </div>

            <FormatPicker
              platform={platform}
              value={postFormat}
              disabled={busy || !formReady || !canDraft}
              onChange={(next) => { setPostFormat(next); saveForm({ postFormat: next }); }}
            />

            <div className="space-y-2">
              <div>
                <label htmlFor="feed-post-brief" className="text-[12.5px] font-medium">
                  {te.newPostBriefLabel}
                </label>
                <p className="mt-0.5 max-w-xl text-[11px] leading-relaxed text-muted-foreground">
                  {te.newPostBriefHint}
                </p>
              </div>
              <textarea
                id="feed-post-brief"
                value={brief}
                onChange={(e) => { setBrief(e.target.value); saveForm({ privateBrief: e.target.value }); }}
                placeholder={te.newPostBriefPlaceholder}
                disabled={busy || !formReady || !canDraft}
                rows={6}
                className="w-full resize-y rounded-xl border border-border/70 bg-background px-3.5 py-3 text-[16px] md:text-sm leading-relaxed shadow-xs disabled:opacity-50"
              />
            </div>

            {error ? (
              <p role="alert" className="text-sm text-destructive">{error}</p>
            ) : null}

            <Button
              type="button"
              onClick={() => void create()}
              disabled={busy || !formReady || !canDraft}
              className="bg-foreground text-background !shadow-none [background-image:none] hover:bg-foreground/90 hover:!shadow-none"
            >
              {busy ? te.creating : te.createPost}
            </Button>
          </div>
        </main>

        <aside className="flex min-h-[420px] items-center justify-center px-5 py-8 sm:px-8 lg:px-10 xl:px-14">
          <div className="w-full max-w-md space-y-3">
            <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              <span>{te.previewLabel}</span>
              <span className="normal-case tracking-normal">{t.platformLabels[platform]}</span>
            </div>
            <PlatformPostPreview
              platform={platform}
              postFormat={postFormat}
              text=""
              threadSegments={["", ""]}
              article={{ sourceUrl: "", title: "", description: "" }}
              accountName={te.previewAccount}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

function PostPane({
  assistantId,
  assistantName,
  assistantIconSeed,
  platform,
  sessionId,
  workspaceId,
  connected,
}: {
  assistantId: string;
  assistantName: string;
  assistantIconSeed?: number;
  platform: FeedPlatform;
  sessionId: string;
  workspaceId: string;
  connected: boolean;
}) {
  // PostPane always renders inside FeedSurfaceShell's provider, so the brand
  // read is a context lookup rather than another prop threaded through.
  const workspace = useFeedWorkspace();
  const t = useT().feedPage;
  const te = t.postEditor;
  const router = useRouter();
  const dockRecorder = useGlobalDockRecorder();
  // Below `lg` the refine chat is a FAB -> bottom sheet instead of the
  // docked rail (responsive contract M5); mount-gated so exactly one panel
  // subscribes to the post's session.
  const isLg = useLgViewport();
  const [refineOpen, setRefineOpen] = useState(false);
  // User-adjustable refine-rail width — the shared peek-resize behavior
  // (drag the left edge, double-click to reset, persisted per key).
  const {
    width: railWidth,
    resizing: railResizing,
    handleProps: railHandleProps,
  } = usePeekResize("feed:refine-rail-width");

  const [session, setSession] = useState<FeedDraftSessionSummary | null>(null);
  const [drafts, setDrafts] = useState<FeedSavedDraft[]>([]);
  const [proposals, setProposals] = useState<ProposedDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleDirty, setTitleDirty] = useState(false);
  const [titleSaving, setTitleSaving] = useState(false);
  const [viewMode, setViewMode] = useState<"edit" | "preview">("edit");
  const [postFormat, setPostFormat] = useState<FeedPostFormat>("post");
  const [privateBrief, setPrivateBrief] = useState("");
  const [threadSegments, setThreadSegments] = useState<string[]>(["", ""]);
  const [article, setArticle] = useState<FeedArticleFields>({
    sourceUrl: "",
    title: "",
    description: "",
  });
  const compositionLoadedRef = useRef(false);
  const offline = useIsOffline();
  const [localPost, setLocalPost] = useState<LocalFeedPost | null>(null);
  const [localSaveError, setLocalSaveError] = useState(false);
  const [localSaving, setLocalSaving] = useState(0);
  const persist = useCallback(async (patch: Partial<FeedWorkingContent>) => {
    setLocalSaving(n => n + 1);
    try {
      const next = await patchFeedWorkingCopy(assistantId, sessionId, patch);
      setLocalPost(next); setLocalSaveError(false); return true;
    } catch { setLocalSaveError(true); return false; }
    finally { setLocalSaving(n => n - 1); }
  }, [assistantId, sessionId]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => { void readLocalFeedPost(assistantId, sessionId).then(post => {
      if (!cancelled) setLocalPost(post);
    }); };
    window.addEventListener(FEED_LOCAL_CHANGED, refresh);
    return () => { cancelled = true; window.removeEventListener(FEED_LOCAL_CHANGED, refresh); };
  }, [assistantId, sessionId]);
  const richCopyRef = useRef<HTMLDivElement>(null);
  const cancelTitleBlurRef = useRef(false);

  // The operator's fork. Null until they diverge from a proposal (D17).
  const [ownText, setOwnText] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [sessions, saved, rows] = await Promise.all([
      fetchFeedDraftSessions(assistantId, platform).catch(
        () => [] as FeedDraftSessionSummary[],
      ),
      fetchFeedSavedDrafts(assistantId, sessionId),
      readLocalFeedPost(assistantId, sessionId).then(post => post?.newSession ? [] :
        feedCachedJson<Array<{ role: string; content: unknown }>>(`/api/sessions/${sessionId}/messages`).catch(() => [])),
    ]);
    const found = sessions.find((s) => s.id === sessionId) ?? null;
    if (!found) setError(te.loadFailed);
    setSession(found);
    const savedDrafts = saved ?? [];
    setDrafts(savedDrafts);
    setProposals(replayProposals(rows));
    if (!compositionLoadedRef.current) {
      const firstUser = rows.find((row) => row.role === "user");
      const seedIntent = parseFeedPostBriefSeed(
        firstUser ? extractMessageText(firstUser.content) : null,
      );
      const savedComposition =
        savedDrafts.find((draft) => draft.status === "pending" || draft.status === "ready")
        ?? savedDrafts[0]
        ?? null;
      setMedia(savedComposition?.media ?? []);
      const restoredFormat = savedComposition?.postFormat ?? seedIntent?.format ?? "post";
      const supported = postFormatsForPlatform(platform).includes(restoredFormat)
        ? restoredFormat
        : "post";
      setPostFormat(supported);
      setPrivateBrief(seedIntent?.brief ?? "");
      if (supported === "thread") {
        const restored = savedComposition?.threadSegments?.filter(Boolean) ?? [];
        setThreadSegments(restored.length >= 2 ? restored : ["", ""]);
      }
      if (supported === "article" && savedComposition?.article) {
        setArticle(savedComposition.article);
      }
      if (found) {
        try {
          const copy = await loadFeedWorkingCopy(assistantId, found, {
            title: displayPostTitle(found.title), privateBrief: seedIntent?.brief ?? "",
            text: savedComposition?.postedText ?? savedComposition?.draftText ?? replayProposals(rows).at(-1)?.text ?? "",
            postFormat: supported, threadSegments: savedComposition?.threadSegments ?? ["", ""],
            article: savedComposition?.article ?? blankFeedContent().article, media: savedComposition?.media ?? [],
          });
          setLocalPost(copy);
          // Saved review/posted versions retain their exact reviewed content.
          const resolved = postQueueStatus(found);
          if (resolved !== "ready" && resolved !== "posted") {
            const content = copy.content;
            const authored = content.textEdited === true;
            setOwnText(authored ? content.text : null);
            setSelectedId(authored ? "mine" : null);
            setPostFormat(content.postFormat); setPrivateBrief(content.privateBrief);
            setThreadSegments(content.threadSegments); setArticle(content.article); setMedia(content.media);
            setSession({ ...found, title: `[${platform}] ${content.title || "New draft"}` });
          }
        } catch { setLocalSaveError(true); }
      }
      compositionLoadedRef.current = true;
    }
    setLoading(false);
  }, [assistantId, platform, sessionId, te.loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setTitleDraft("");
    setTitleDirty(false);
  }, [sessionId]);

  const committed = useMemo(
    () =>
      drafts.find((d) => d.status === "pending" || d.status === "ready")
      ?? drafts.find((d) => d.status === "posted")
      ?? null,
    [drafts],
  );

  const versions = useMemo(
    () =>
      buildVersions({
        proposals,
        ownText,
        savedText: committed?.postedText ?? committed?.draftText ?? null,
      }),
    [proposals, ownText, committed],
  );
  // Empty text is an authored working copy too. The version picker omits
  // empty chips, but clearing a caption must not resurrect a proposal.
  const selected: ReturnType<typeof resolveSelectedVersion> = selectedId === "mine" && ownText !== null
    ? { id: "mine", origin: "operator" as const, text: ownText }
    : resolveSelectedVersion(versions, selectedId);
  const status: PostQueueStatus = session
    ? postQueueStatus(session)
    : "drafting";

  // A committed post is read-only: editing something already approved or
  // posted would let the copy drift away from what was actually reviewed.
  const readOnly = status === "ready" || status === "posted" || !workspace.canDraft;
  const remoteBlocked = offline || !localPost || localPost.dirty || localSaveError || localSaving > 0;
  // D32. Media lives beside the caption, not inside formatData: saveDraft
  // rewrites formatData wholesale from postFormat, so a Post<->Thread switch
  // would silently erase it.
  const [media, setMedia] = useState<PostMedia[]>([]);

  useEffect(() => {
    if (
      postFormat === "thread"
      && selected?.text
      && threadSegments.every((part) => part.length === 0)
    ) {
      setThreadSegments([selected.text, ""]);
    }
  }, [postFormat, selected?.text, threadSegments]);

  async function commitVersion() {
    if (remoteBlocked || readOnly) return;
    const text = postFormat === "thread" ? threadSegments.join("\n\n") : selected?.text ?? "";
    if (!text) return;
    setBusy(true);
    try {
      const result = await saveFeedSessionDraft(assistantId, sessionId, {
        text, platform, postFormat, media,
        ...(postFormat === "thread" ? { threadSegments } : {}),
        ...(postFormat === "article" ? { article } : {}),
      });
      if (!result.ok) { setError(result.error ?? te.actionFailed); return; }
      notifyFeedPostsChanged(); await load();
    } catch { setError(te.actionFailed); }
    finally { setBusy(false); }
  }

  async function saveAsNewPost() {
    if (!localPost || !workspace.canDraft) return;
    try {
      const copy = await forkLocalFeedPost(localPost);
      router.push(feedPostPath(workspaceId, platform, copy.session.id));
    } catch { setLocalSaveError(true); }
  }

  async function act(kind: "approve" | "reject" | "posted") {
    if (remoteBlocked) return;
    const target = drafts.find((d) =>
      kind === "posted" ? d.status === "ready" : d.status === "pending",
    );
    if (!target) return;

    if (kind === "reject") {
      const ok = await confirmDialog({
        title: te.rejectTitle,
        description: te.rejectBody,
        confirmLabel: te.reject,
        variant: "destructive",
      });
      if (!ok) return;
    }
    let permalink = "";
    if (kind === "posted") {
      // The dialog hosts the input; this closure owns the value (the
      // `content` contract in confirm-dialog.tsx).
      const ok = await confirmDialog({
        title: te.markPostedTitle,
        description: te.markPostedBody,
        confirmLabel: te.markPosted,
        content: (
          <input
            type="url"
            placeholder={te.permalinkPlaceholder}
            onChange={(e) => {
              permalink = e.target.value;
            }}
            className="h-9 w-full rounded-lg border border-border bg-background px-3 text-[16px] md:text-sm focus:outline-none"
          />
        ),
      });
      if (!ok) return;
    }

    setBusy(true);
    setError(null);
    try {
      const result =
        kind === "approve"
          ? await approveFeedDraft(assistantId, target.id)
          : kind === "reject"
            ? await rejectFeedDraft(assistantId, target.id)
            : await markFeedReadyPostPosted(
                assistantId,
                target.id,
                permalink.trim() ? { permalink: permalink.trim() } : {},
              );
      if (!result.ok) {
        setError(result.error ?? te.actionFailed);
        return;
      }
      if ("error" in result && typeof result.error === "string") {
        setError(result.error);
      }
      notifyFeedPostsChanged();
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function removePost() {
    if (remoteBlocked) return;
    const ok = await confirmDialog({
      title: te.deleteTitle,
      description: te.deleteBody,
      confirmLabel: te.delete,
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await deleteFeedDraftSession(assistantId, sessionId);
      if (!result.ok) {
        setError(result.error ?? te.actionFailed);
        return;
      }
      notifyFeedPostsChanged();
      router.push(feedPath(workspaceId, { platform, segment: "posts" }));
    } finally {
      setBusy(false);
    }
  }

  async function saveTitle() {
    if (!session || !titleDirty || titleSaving) return;
    const title = titleDraft.trim();
    const persisted = displayPostTitle(session.title);
    if (!title) {
      setTitleDraft(persisted);
      setTitleDirty(false);
      return;
    }
    if (title === persisted) {
      setTitleDraft(title);
      setTitleDirty(false);
      return;
    }
    setTitleSaving(true);
    setError(null);
    try {
      if (!await persist({ title })) return;
      setSession((current) => current ? { ...current, title: `[${platform}] ${title}` } : current);
      setTitleDraft(title);
      setTitleDirty(false);
      notifyFeedPostsChanged();
    } finally {
      setTitleSaving(false);
    }
  }

  async function copyCaption() {
    const copy = postFormat === "thread"
      ? threadSegments
          .map((part, index) => `${index + 1}/${threadSegments.length} ${part.trim()}`)
          .join("\n\n")
      : postFormat === "article"
        ? [selected?.text ?? "", article.sourceUrl].filter(Boolean).join("\n\n")
        : selected?.text ?? "";
    if (!copy) return;
    try {
      const richHtml = postFormat === "thread"
        ? null
        : richCopyRef.current?.innerHTML ?? null;
      if (
        richHtml
        && typeof ClipboardItem !== "undefined"
        && typeof navigator.clipboard.write === "function"
      ) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([copy], { type: "text/plain" }),
            "text/html": new Blob([richHtml], { type: "text/html" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(copy);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(te.actionFailed);
    }
  }

  const compositionText = postFormat === "thread"
    ? threadSegments.map((part) => part.trim()).filter(Boolean).join("\n\n")
    : selected?.text ?? "";
  const threadValid =
    threadSegments.length >= 2
    && threadSegments.every(
      (part) => part.trim().length > 0 && !counterState(part, "twitter").over,
    );
  let articleUrlValid = false;
  if (article.sourceUrl) {
    try {
      const url = new URL(article.sourceUrl);
      articleUrlValid = url.protocol === "http:" || url.protocol === "https:";
    } catch {
      articleUrlValid = false;
    }
  }
  const compositionValid = postFormat === "thread"
    ? threadValid
    : postFormat === "article"
      ? Boolean(compositionText.trim() && articleUrlValid && article.title.trim())
      : Boolean(compositionText.trim() && !counterState(compositionText, platform).over);
  const compositionDirty = compositionHasChanges({
    format: postFormat,
    text: compositionText,
    threadSegments,
    article,
    saved: committed,
  });

  const planGate = useCallback(
    () => (
      // A billing state, not a crash (D18): quiet, explains what is and is not
      // affected, and offers the one action that resolves it.
      <div className="rounded-xl border border-border/60 bg-muted/40 p-3">
        <div className="text-[12.5px] font-medium">{te.planGateTitle}</div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {te.planGateBody}
        </p>
        <a
          href={`${webAppUrl()}/plans`}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex h-7 items-center rounded-lg border border-border bg-background px-2.5 text-[11px] font-medium transition-colors hover:bg-accent"
        >
          {te.planGateCta}
        </a>
      </div>
    ),
    [te],
  );

  if (loading) {
    // The editor's silhouette (header row, status strip, the caption card)
    // rather than a sentence (instant-navigation N4); the composition read is
    // the one wait this surface still pays, and it should look like a frame.
    return (
      <div aria-hidden data-post-editor-skeleton className="animate-fade-in p-4 sm:p-6 xl:p-8">
        <div className="space-y-6">
          <div className="flex items-center gap-3 border-b border-border/60 pb-4">
            <Skeleton className="size-8 rounded-xl" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-8 w-28 rounded-lg" />
          </div>
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-52 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div
      style={
        railWidth !== null
          ? ({ "--feed-refine-rail": `${railWidth}px` } as React.CSSProperties)
          : undefined
      }
      className={cn(
        "grid min-h-full lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_var(--feed-refine-rail,390px)] 2xl:grid-cols-[minmax(0,1fr)_var(--feed-refine-rail,420px)]",
        railResizing && "select-none",
      )}
    >
      <main className="min-w-0 bg-background lg:overflow-y-auto">
        <div className="min-h-full p-4 sm:p-6 xl:p-8">
          <div className="space-y-6">
            <header className="flex flex-wrap items-center gap-3 border-b border-border/60 pb-4">
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <span className="inline-flex size-8 items-center justify-center rounded-xl border border-border/60 bg-muted/40">
                  <PlatformIcon platform={platform} className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  {session ? (
                    <div className="group/title flex min-w-0 items-center gap-1.5">
                      <input
                        type="text"
                        value={titleDirty ? titleDraft : displayPostTitle(session.title)}
                        maxLength={200}
                        disabled={titleSaving || readOnly}
                        aria-label={te.editTitle}
                        title={te.editTitle}
                        onFocus={() => {
                          if (!titleDirty) setTitleDraft(displayPostTitle(session.title));
                        }}
                        onChange={(event) => {
                          setTitleDraft(event.target.value);
                          setTitleDirty(true);
                          void persist({ title: event.target.value });
                        }}
                        onBlur={() => {
                          if (cancelTitleBlurRef.current) {
                            cancelTitleBlurRef.current = false;
                            return;
                          }
                          void saveTitle();
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.blur();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            cancelTitleBlurRef.current = true;
                            setTitleDraft(displayPostTitle(session.title));
                            setTitleDirty(false);
                            void persist({ title: displayPostTitle(session.title) });
                            event.currentTarget.blur();
                          }
                        }}
                        className="h-9 md:h-7 min-w-0 w-full truncate rounded-md border border-transparent bg-transparent px-1 text-[16px] md:text-[15px] font-semibold outline-none transition-colors hover:border-border/70 focus:border-border focus:bg-background disabled:opacity-60"
                      />
                      <Pencil className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />
                    </div>
                  ) : (
                    <h1 className="truncate text-[15px] font-semibold">{te.newPost}</h1>
                  )}
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {session?.replyTarget
                      ? format(te.replyingTo, { handle: session.replyTarget.authorHandle })
                      : t.platformLabels[platform]}
                  </p>
                </div>
              </div>
              <div
                role="group"
                aria-label={te.viewModeAria}
                className="inline-flex h-10 md:h-8 items-center rounded-lg border border-border/70 bg-muted/35 p-0.5"
              >
                {(["edit", "preview"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setViewMode(mode)}
                    aria-pressed={viewMode === mode}
                    className={cn(
                      "h-9 md:h-7 rounded-md px-3 md:px-2.5 text-[11px] font-medium transition-colors",
                      viewMode === mode
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {mode === "edit" ? te.editMode : te.previewMode}
                  </button>
                ))}
              </div>
              <StatusLabel status={status} label={t.posts.status[status]} />
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {status === "drafting" ? (
                  <Button
                    size="sm"
                    type="button"
                    onClick={() => void commitVersion()}
                    disabled={busy || remoteBlocked || !compositionValid}
                    className="bg-foreground text-background !shadow-none [background-image:none] hover:bg-foreground/90 hover:!shadow-none"
                  >
                    {te.useThisVersion}
                  </Button>
                ) : status === "review" ? (
                  <>
                    {compositionDirty ? (
                      <Button
                        size="sm"
                        type="button"
                        onClick={() => void commitVersion()}
                        disabled={busy || remoteBlocked || !compositionValid}
                        className="bg-foreground text-background !shadow-none [background-image:none] hover:bg-foreground/90 hover:!shadow-none"
                      >
                        {te.saveChanges}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      type="button"
                      onClick={() => void act("approve")}
                      disabled={busy || remoteBlocked || compositionDirty}
                      title={compositionDirty ? te.saveBeforeApprove : undefined}
                      className="bg-foreground text-background !shadow-none [background-image:none] hover:bg-foreground/90 hover:!shadow-none"
                    >
                      <Check className="size-3.5" aria-hidden />
                      {te.approve}
                    </Button>
                    <Button size="sm" variant="outline" type="button" onClick={() => void act("reject")} disabled={busy || remoteBlocked}>
                      <X className="size-3.5" aria-hidden />
                      {te.reject}
                    </Button>
                  </>
                ) : status === "ready" ? (
                  <Button
                    size="sm"
                    type="button"
                    onClick={() => void act("posted")}
                    disabled={busy || remoteBlocked}
                    className="bg-foreground text-background !shadow-none [background-image:none] hover:bg-foreground/90 hover:!shadow-none"
                  >
                    {te.markPosted}
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" type="button" onClick={() => void copyCaption()} disabled={!compositionText}>
                  {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                  {copied ? te.copied : te.copyCaption}
                </Button>
                <Button variant="outline" size="icon" type="button" onClick={() => void removePost()} disabled={busy || remoteBlocked} aria-label={te.delete} title={te.delete} className="size-9 md:size-8 text-muted-foreground hover:text-destructive">
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </div>
            </header>

            <div role="status" className="rounded-xl border border-border/60 bg-muted/25 p-3 text-sm">
              {localSaveError ? te.localSaveFailed : localSaving ? te.saving :
                localPost?.error === "conflict" ? te.syncConflict : localPost?.error ? te.syncBlocked :
                localPost?.dirty ? te.savedLocally : te.synced}
              {(localPost?.error || (readOnly && localPost?.dirty)) && workspace.canDraft ? (
                <Button type="button" variant="outline" className="ml-3" onClick={() => void saveAsNewPost()}>
                  {te.saveAsNewPost}
                </Button>
              ) : null}
            </div>

            {error ? (
              <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            {privateBrief ? (
              <section className="rounded-xl border border-border/60 bg-muted/25 p-3.5">
                <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  <span className="rounded-full bg-foreground px-2 py-0.5 text-background">
                    {te.privateBriefBadge}
                  </span>
                  {te.privateBriefNotice}
                </div>
                <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/80">
                  {privateBrief}
                </p>
              </section>
            ) : null}

            <section className="min-w-0 space-y-4">
              {viewMode === "edit" ? (
                <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    {te.editorLabel}
                  </span>
                  {!readOnly ? (
                    <FormatPicker
                      platform={platform}
                      value={postFormat}
                      onChange={(next) => {
                        setPostFormat(next);
                        void persist({ postFormat: next });
                        if (next === "thread" && threadSegments.every((part) => !part)) {
                          setThreadSegments([selected?.text ?? "", ""]);
                          void persist({ threadSegments: [selected?.text ?? "", ""] });
                        }
                      }}
                      compact
                    />
                  ) : null}
                </div>

                {versions.length > 1 && postFormat !== "thread" ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      {te.versionsLabel}
                    </span>
                    {versions.map((version, index) => {
                      const active = selected?.id === version.id;
                      return (
                        <button
                          key={version.id}
                          type="button"
                          onClick={() => { setSelectedId(version.id); if (!readOnly) void persist({ text: version.text }); }}
                          aria-pressed={active}
                          className={cn(
                            "inline-flex h-9 md:h-7 items-center rounded-full border px-3 md:px-2.5 text-[11px] font-medium transition-colors",
                            active
                              ? "border-transparent bg-foreground text-background"
                              : "border-border bg-background text-muted-foreground hover:bg-muted",
                          )}
                        >
                          {version.origin === "operator"
                            ? te.versionYours
                            : (version.label ?? format(te.versionAssistant, { n: String(index + 1) }))}
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {postFormat === "thread" ? (
                  <ThreadComposer
                    segments={threadSegments}
                    readOnly={readOnly}
                    onChange={(next) => { setThreadSegments(next); void persist({ threadSegments: next }); }}
                  />
                ) : (
                  <div className="rounded-xl border border-border/60 bg-card p-5 shadow-xs transition focus-within:border-ring [&_:focus-visible]:shadow-none">
                    <CaptionEditor
                      value={selected?.text ?? ""}
                      platform={platform}
                      readOnly={readOnly}
                      onChange={(next) => {
                        setOwnText(next);
                        setSelectedId("mine");
                        void persist({ text: next });
                      }}
                      onSave={async () => true}
                      deferSave
                      saveHint={te.autosaveHint}
                    />
                  </div>
                )}

                {postFormat === "article" ? (
                  <ArticleFields
                    value={article}
                    readOnly={readOnly}
                    onChange={(next) => { setArticle(next); void persist({ article: next }); }}
                  />
                ) : null}

                {postFormat === "thread" ? (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {te.threadHint}
                  </p>
                ) : null}

                {/*
                  D38. Under the copy it describes, warn-only, and silent
                  unless the workspace has an approved brand AND the text
                  actually contains a flagged phrase.
                */}
                <BrandCheck
                  brand={workspace.brand}
                  text={
                    postFormat === "thread"
                      ? threadSegments.join("\n\n")
                      : (selected?.text ?? "")
                  }
                />

                <PostMediaTray
                  workspaceId={workspaceId}
                  platform={platform}
                  media={media}
                  imageBrief={selected?.imageBrief ?? null}
                  readOnly={readOnly || offline}
                  onChange={(next) => {
                    setMedia(next);
                    void persist({ media: next });
                  }}
                />
                </>
              ) : (
                <div className="mx-auto w-full max-w-4xl space-y-3">
                  <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    <span>{te.previewLabel}</span>
                    <span className="normal-case tracking-normal">
                      {postFormat === "post" && connected
                        ? te.connectedDelivery
                        : te.manualDelivery}
                    </span>
                  </div>
                  <PlatformPostPreview
                    platform={platform}
                    postFormat={postFormat}
                    text={selected?.text ?? ""}
                    threadSegments={threadSegments}
                    article={article}
                    accountName={assistantName || te.previewAccount}
                    brand={workspace.brand}
                  />
                </div>
              )}

              <div ref={richCopyRef} className="hidden" aria-hidden>
                <RichPostBody text={selected?.text ?? ""} />
                {postFormat === "article" && article.sourceUrl ? (
                  <p><a href={article.sourceUrl}>{article.sourceUrl}</a></p>
                ) : null}
              </div>
            </section>
          </div>
        </div>
      </main>

      {/* The refine chat, hosted ONCE: the resizable rail at `lg+`, and below
          it a FAB -> bottom sheet (responsive contract M5, the
          `MobileChatDrawer` shape) instead of a 520-680px block under the
          whole editor with its composer beneath the keyboard. `keepMounted`
          keeps a streaming turn alive while the sheet is closed; the `isLg`
          gate keeps exactly one panel subscribed to the post's session. */}
      {(() => {
        const refinePanel =
          offline || localPost?.newSession ? (
            <p className="p-5 text-sm text-muted-foreground">{te.refineNeedsConnection}</p>
          ) : (
            <TuningChatPanel
              docked
              assistantId={assistantId}
              assistantName={assistantName}
              iconSeed={assistantIconSeed}
              workspaceId={workspaceId}
              sessionId={sessionId}
              title={te.chatTitle}
              composerPlaceholder={te.chatPlaceholder}
              headline={te.chatHeadline}
              emptyTitle={te.chatEmptyTitle}
              emptyBody={te.chatEmptyBody}
              emptySuggestionsLabel={te.chatTry}
              suggestions={[
                te.chatSuggestion1,
                te.chatSuggestion2,
                te.chatSuggestion3,
              ]}
              onTurnComplete={() => void load()}
              renderPlanGate={planGate}
              dockRecorder={dockRecorder ?? undefined}
              ownsDockRecorderTarget
            />
          );
        return isLg ? (
          <aside className="relative hidden border-border/60 lg:block lg:h-auto lg:min-h-0 lg:border-l">
            <PeekResizeHandle resizing={railResizing} {...railHandleProps} />
            {refinePanel}
          </aside>
        ) : (
          <div className="lg:hidden" data-post-refine-mobile-host>
            <button
              type="button"
              onClick={() => setRefineOpen(true)}
              aria-label={te.refineOpenAria}
              aria-expanded={refineOpen}
              className={cn(
                "fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-30",
                "inline-flex h-14 w-14 items-center justify-center rounded-full bg-action text-action-foreground shadow-lg",
                "transition-[opacity,transform] duration-150 ease-out",
                refineOpen ? "pointer-events-none scale-90 opacity-0" : "scale-100 opacity-100",
              )}
            >
              <MessageSquareText className="size-5" aria-hidden />
            </button>
            <PlanMobileSheet
              open={refineOpen}
              keepMounted
              title={te.chatTitle}
              onClose={() => setRefineOpen(false)}
            >
              <div className="absolute inset-0">{refinePanel}</div>
            </PlanMobileSheet>
          </div>
        );
      })()}
    </div>
  );
}

function FormatPicker({
  platform,
  value,
  onChange,
  compact = false,
  disabled = false,
}: {
  platform: FeedPlatform;
  value: FeedPostFormat;
  onChange: (next: FeedPostFormat) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const te = useT().feedPage.postEditor;
  const formats = postFormatsForPlatform(platform);
  const label = (postFormat: FeedPostFormat) =>
    postFormat === "thread"
      ? te.formatThread
      : postFormat === "article"
        ? te.formatArticle
        : te.formatPost;
  const description = (postFormat: FeedPostFormat) =>
    postFormat === "thread"
      ? te.formatThreadDesc
      : postFormat === "article"
        ? te.formatArticleDesc
        : te.formatPostDesc;

  return (
    <div className={cn("space-y-2", compact && "space-y-0")}>
      {!compact ? (
        <div className="text-[12.5px] font-medium">{te.formatLabel}</div>
      ) : null}
      <div className={cn("grid gap-2", compact ? "grid-flow-col auto-cols-max" : "sm:grid-cols-2")}>
        {formats.map((option) => {
          const active = option === value;
          return (
            <button
              key={option}
              type="button"
              onClick={() => onChange(option)}
              disabled={disabled}
              aria-pressed={active}
              className={cn(
                "rounded-xl border text-left transition-colors",
                compact ? "h-9 md:h-7 px-3 md:px-2.5 text-[11px]" : "p-3.5",
                active
                  ? "border-foreground bg-foreground text-background"
                  : "border-border/70 bg-background text-foreground hover:bg-muted/50",
              )}
            >
              <span className="block font-medium">{label(option)}</span>
              {!compact ? (
                <span className={cn("mt-1 block text-[11px] leading-relaxed", active ? "text-background/70" : "text-muted-foreground")}>
                  {description(option)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ThreadComposer({
  segments,
  readOnly,
  onChange,
}: {
  segments: string[];
  readOnly: boolean;
  onChange: (next: string[]) => void;
}) {
  const te = useT().feedPage.postEditor;
  return (
    <div className="space-y-3">
      {segments.map((segment, index) => {
        const counter = counterState(segment, "twitter");
        return (
          <div key={index} className="relative rounded-xl border border-border/60 bg-card p-4 shadow-xs focus-within:border-ring [&_:focus-visible]:shadow-none">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-[11px] font-medium text-muted-foreground">
                {format(te.threadPostLabel, { n: String(index + 1) })}
              </span>
              <div className="flex items-center gap-2">
                <span className={cn("text-[11px] tabular-nums text-muted-foreground", counter.over && "font-medium text-destructive")}>
                  {counter.count}/280
                </span>
                {!readOnly && segments.length > 2 ? (
                  <button
                    type="button"
                    onClick={() => onChange(segments.filter((_, partIndex) => partIndex !== index))}
                    aria-label={format(te.removeThreadPost, { n: String(index + 1) })}
                    title={format(te.removeThreadPost, { n: String(index + 1) })}
                    className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                ) : null}
              </div>
            </div>
            <textarea
              value={segment}
              readOnly={readOnly}
              onChange={(event) => {
                const next = [...segments];
                next[index] = event.target.value;
                onChange(next);
              }}
              rows={4}
              placeholder={te.captionPlaceholder}
              className="w-full resize-y bg-transparent text-[16px] md:text-[15px] leading-relaxed placeholder:text-muted-foreground/50 focus-visible:shadow-none"
            />
          </div>
        );
      })}
      {!readOnly ? (
        <Button variant="outline" size="sm" type="button" onClick={() => onChange([...segments, ""])}>
          <Plus className="size-3.5" aria-hidden />
          {te.addThreadPost}
        </Button>
      ) : null}
    </div>
  );
}

function ArticleFields({
  value,
  readOnly,
  onChange,
}: {
  value: FeedArticleFields;
  readOnly: boolean;
  onChange: (next: FeedArticleFields) => void;
}) {
  const te = useT().feedPage.postEditor;
  return (
    <div className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4">
      <label className="block space-y-1.5">
        <span className="text-[12px] font-medium">{te.articleSourceLabel}</span>
        <div className="relative">
          <Link2 className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="url"
            value={value.sourceUrl}
            readOnly={readOnly}
            onChange={(event) => onChange({ ...value, sourceUrl: event.target.value })}
            placeholder={te.articleSourcePlaceholder}
            className="h-9 w-full rounded-lg border border-border/70 bg-background pl-9 pr-3 text-[16px] md:text-sm"
          />
        </div>
        <span className="block text-[11px] leading-relaxed text-muted-foreground">
          {te.articleSourceHint}
        </span>
      </label>
      <label className="block space-y-1.5">
        <span className="text-[12px] font-medium">{te.articleTitleLabel}</span>
        <input
          type="text"
          value={value.title}
          readOnly={readOnly}
          onChange={(event) => onChange({ ...value, title: event.target.value })}
          placeholder={te.articleTitlePlaceholder}
          className="h-9 w-full rounded-lg border border-border/70 bg-background px-3 text-[16px] md:text-sm"
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-[12px] font-medium">{te.articleDescriptionLabel}</span>
        <textarea
          value={value.description}
          readOnly={readOnly}
          onChange={(event) => onChange({ ...value, description: event.target.value })}
          placeholder={te.articleDescriptionPlaceholder}
          rows={3}
          className="w-full resize-y rounded-lg border border-border/70 bg-background px-3 py-2 text-[16px] md:text-sm leading-relaxed"
        />
      </label>
    </div>
  );
}

function PlatformPostPreview({
  platform,
  postFormat,
  text,
  threadSegments,
  article,
  accountName,
  brand = null,
}: {
  platform: FeedPlatform;
  postFormat: FeedPostFormat;
  text: string;
  threadSegments: string[];
  article: FeedArticleFields;
  accountName: string;
  /** The workspace's APPROVED brand record, or null (D36). */
  brand?: BrandRecord | null;
}) {
  const t = useT().feedPage;
  const te = t.postEditor;
  const identity = brandPreviewIdentity(brand);
  const displayName =
    identity.displayName || accountName.trim() || te.previewAccount;
  /*
    D36. This used to be `displayName.toLowerCase().replace(...)` -- a handle
    invented from the assistant's name, shown confidently on the one surface
    whose whole job is previewing how the post appears in public. A workspace
    whose real handle differed saw a lie. Now it is the brand's actual handle
    or nothing at all; no handle renders no handle.
  */
  const handle = identity.handle;
  const parts = postFormat === "thread" ? threadSegments : [text];
  let sourceHost = "";
  try {
    sourceHost = article.sourceUrl ? new URL(article.sourceUrl).hostname.replace(/^www\./, "") : "";
  } catch {
    sourceHost = "";
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-background shadow-xs">
      <div className="flex items-center gap-2 border-b border-border/50 px-4 py-3 text-[11px] text-muted-foreground">
        <PlatformIcon platform={platform} className="size-3.5" />
        <span>{t.platformLabels[platform]}</span>
        <span aria-hidden>·</span>
        <span>{te.previewNow}</span>
      </div>
      <div className="p-4 sm:p-5">
        {parts.map((part, index) => (
          <article key={index} className={cn("relative flex gap-3", index > 0 && "pt-5")}>
            {postFormat === "thread" && index < parts.length - 1 ? (
              <span className="absolute bottom-[-20px] left-[17px] top-9 w-px bg-border" aria-hidden />
            ) : null}
            <div className="relative z-10 inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
              {displayName.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm">
                <span className="truncate font-semibold">{displayName}</span>
                {handle ? (
                  <span className="truncate text-[12px] text-muted-foreground">@{handle}</span>
                ) : null}
              </div>
              {part ? (
                <RichPostBody
                  text={part}
                  className="mt-1.5 break-words text-[14px] leading-relaxed"
                />
              ) : (
                <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground/60">
                  {te.previewEmpty}
                </p>
              )}
              {postFormat === "article" && index === 0 ? (
                <div className="mt-3 overflow-hidden rounded-xl border border-border/70 bg-muted/25">
                  <div className="flex aspect-[2.2/1] items-center justify-center border-b border-border/60 bg-muted/50 text-muted-foreground">
                    <Link2 className="size-5" aria-hidden />
                  </div>
                  <div className="space-y-1 p-3">
                    {sourceHost ? <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{sourceHost}</div> : null}
                    <div className="text-[13px] font-medium leading-snug">
                      {article.title || te.articleFallbackTitle}
                    </div>
                    <div className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                      {article.description || te.articleFallbackDescription}
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="mt-3 flex items-center gap-6 text-[10px] text-muted-foreground/70">
                <MessageCircle className="size-3.5" aria-hidden />
                <Repeat2 className="size-3.5" aria-hidden />
                <Heart className="size-3.5" aria-hidden />
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

/**
 * The portable styling surface shared by Preview and rich clipboard copy.
 * The allowlist matches the four toolbar controls; unsupported Markdown is
 * unwrapped to readable text instead of becoming provider-shaped HTML.
 */
function RichPostBody({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "whitespace-pre-wrap",
        "[&_p:not(:first-child)]:mt-3 [&_strong]:font-semibold [&_em]:italic",
        "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5",
        "[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={["p", "strong", "em", "ul", "ol", "li", "br"]}
        unwrapDisallowed
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
