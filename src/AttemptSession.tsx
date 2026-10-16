// The exam screen: one question at a time, answers kept in the encrypted local store on every
// keystroke and pushed to the server after a pause, a countdown that submits by itself when it
// reaches zero.

import { useEffect, useReducer, useRef, useState } from "react";
import { AnimatedButton } from "./components/AnimatedButton";
import { ApiError, getAttempt, submitAttempt, syncAnswers, uploadMedia, type AnswerInput, type AttemptSummary, type TimeUnit } from "./api";
import type { AnswerDraft } from "./generated/AnswerDraft";
import { draftClear, draftLoad, draftSave } from "./ipc";
import { logActivity, type ActivityKind } from "./activity";
import { AnswerSheet } from "./AnswerSheet";
import { CameraPreview } from "./CameraPreview";
import type { CheckIn } from "./PreExam";
import { useExamGuard } from "./useExamGuard";
import type { TypingMetrics } from "./typingMetrics";
import { primaryButtonClass } from "./ui";

export type AttemptView = Awaited<ReturnType<typeof getAttempt>>;
type Question = AttemptView["questions"][number];

/** How long the student has to stop typing before the answers are sent to the server. */
export const SYNC_IDLE_MS = 10_000;

const TEXT_TYPES = new Set(["short_answer", "essay"]);
const TYPE_LABEL: Record<Question["question_type"], string> = {
  multiple_choice: "multiple choice",
  true_false: "true/false",
  short_answer: "short answer",
  essay: "essay",
};
const UNIT_SECONDS: Record<TimeUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

interface QuestionState {
  answer: string;
  optionIds: number[];
  metrics: TypingMetrics;
  timeSpentMs: number;
  startedAt: string | null;
  answeredAt: string | null;
  /** Bumped on every change; a question is unsynced while `rev > syncedRev`. */
  rev: number;
  syncedRev: number;
}

function fromServer(q: Question): QuestionState {
  return {
    answer: q.answer,
    optionIds: q.selected_option_ids,
    metrics: {
      typed: q.text_typed,
      edited: q.text_edited,
      pasted: q.text_pasted,
      deleted: q.text_deleted,
      typingMs: q.typing_duration * UNIT_SECONDS[q.typing_duration_unit] * 1000,
      freezeCount: q.freeze_count,
      longestFreezeMs: q.longest_freeze * 1000,
    },
    timeSpentMs: 0,
    startedAt: q.started_at,
    answeredAt: q.answered_at,
    rev: 0,
    syncedRev: 0,
  };
}

function fromDraft(d: AnswerDraft): QuestionState {
  return {
    answer: d.answer,
    optionIds: d.option_ids,
    metrics: {
      typed: d.text_typed,
      edited: d.text_edited,
      pasted: d.text_pasted,
      deleted: d.text_deleted,
      typingMs: d.typing_duration * 1000,
      freezeCount: d.freeze_count,
      longestFreezeMs: d.longest_freeze * 1000,
    },
    timeSpentMs: d.time_spent * 1000,
    startedAt: d.started_at,
    answeredAt: d.answered_at,
    rev: 1,
    syncedRev: 0,
  };
}

const isAnswered = (s: QuestionState) => s.answer.trim() !== "" || s.optionIds.length > 0;

function formatClock(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function AttemptSession({
  userId,
  token,
  attempt,
  resumed = false,
  checkIn,
  onFinished,
}: {
  userId: number;
  token: string;
  attempt: AttemptView;
  /** The attempt was already open (the app was closed, say) rather than freshly started. */
  resumed?: boolean;
  /** Photos and notes from the check before the exam, written to the log once the exam is open. */
  checkIn?: CheckIn;
  onFinished: (result: AttemptSummary, reason?: "timeout" | "left_window") => void;
}) {
  const questions = [...attempt.questions].sort((a, b) => a.position - b.position);

  // Answers live in a ref so timers and event handlers always see the latest, and the screen
  // re-renders explicitly after each change.
  const store = useRef<Record<number, QuestionState>>({});
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [ready, setReady] = useState(false);
  const [index, setIndex] = useState(0);
  const [remaining, setRemaining] = useState(attempt.remaining_seconds);
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const deadline = useRef(Date.now() + attempt.remaining_seconds * 1000);
  const shownAt = useRef(Date.now());
  const currentId = useRef<number | null>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout>>();
  const inFlight = useRef<Promise<boolean> | null>(null);
  const submitInFlight = useRef(false);
  const finished = useRef(false);
  const syncFailing = useRef(false);

  // Everything the student does here goes to the Activity log as well.
  const log = (kind: ActivityKind, detail: string, extra: { questionId?: number; data?: Record<string, unknown> } = {}) =>
    logActivity({ userId, token, attemptId: attempt.id, examName: attempt.exam.name }, kind, detail, extra);
  const labelOf = (q: Question) => `question ${questions.indexOf(q) + 1} (${TYPE_LABEL[q.question_type]})`;
  const whereNow = () => {
    const q = questions.find((x) => x.question_id === currentId.current);
    return q ? labelOf(q) : "the exam";
  };

  /** Adds the time the current question has been on screen to its total. */
  const accumulateCurrent = () => {
    const id = currentId.current;
    const s = id === null ? undefined : store.current[id];
    if (s) s.timeSpentMs += Date.now() - shownAt.current;
    shownAt.current = Date.now();
  };

  const logSummary = (q: Question) => {
    const s = store.current[q.question_id];
    if (!s) return;
    const position = questions.indexOf(q) + 1;
    const typingSeconds = Math.round(s.metrics.typingMs / 1000);
    const spentSeconds = Math.round(s.timeSpentMs / 1000);
    log(
      "question_summary",
      `Question ${position}: on screen ${spentSeconds} s, typed ${s.metrics.typed}, edited ${s.metrics.edited}, deleted ${s.metrics.deleted}, pasted ${s.metrics.pasted}, typing time ${typingSeconds} s, froze ${s.metrics.freezeCount} time(s)`,
      {
        questionId: q.question_id,
        data: {
          label: `Question ${position} (${TYPE_LABEL[q.question_type]})`,
          position,
          typed: s.metrics.typed,
          edited: s.metrics.edited,
          deleted: s.metrics.deleted,
          pasted: s.metrics.pasted,
          typing_seconds: typingSeconds,
          freeze_count: s.metrics.freezeCount,
          longest_freeze_seconds: Math.round(s.metrics.longestFreezeMs / 1000),
          time_spent_seconds: spentSeconds,
          answered: isAnswered(s),
        },
      },
    );
  };

  const toDraft = (questionId: number): AnswerDraft => {
    const s = store.current[questionId]!;
    const live = questionId === currentId.current ? Date.now() - shownAt.current : 0;
    return {
      attempt_id: attempt.id,
      question_id: questionId,
      answer: s.answer,
      option_ids: s.optionIds,
      typing_duration: Math.round(s.metrics.typingMs / 1000),
      text_typed: s.metrics.typed,
      text_edited: s.metrics.edited,
      text_pasted: s.metrics.pasted,
      text_deleted: s.metrics.deleted,
      freeze_count: s.metrics.freezeCount,
      longest_freeze: Math.round(s.metrics.longestFreezeMs / 1000),
      time_spent: Math.round((s.timeSpentMs + live) / 1000),
      started_at: s.startedAt,
      answered_at: s.answeredAt,
    };
  };

  // A failing local store (see the Rust side) must never get in the student's way.
  const persist = (questionId: number) => {
    draftSave(toDraft(questionId)).catch(() => undefined);
  };

  const toInput = (q: Question): AnswerInput => {
    const s = store.current[q.question_id]!;
    const input: AnswerInput = {
      question_id: q.question_id,
      typing_duration: Math.round(s.metrics.typingMs / 1000),
      typing_duration_unit: "seconds",
      text_typed: s.metrics.typed,
      text_edited: s.metrics.edited,
      text_pasted: s.metrics.pasted,
      text_deleted: s.metrics.deleted,
      freeze_count: s.metrics.freezeCount,
      longest_freeze: Math.round(s.metrics.longestFreezeMs / 1000),
    };
    if (TEXT_TYPES.has(q.question_type)) input.answer = s.answer;
    else input.option_ids = s.optionIds;
    if (s.startedAt) input.started_at = s.startedAt;
    if (s.answeredAt) input.answered_at = s.answeredAt;
    return input;
  };

  const scheduleSync = () => {
    clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => void syncNow(), SYNC_IDLE_MS);
  };

  /** Sends every unsynced question; resolves true when there was nothing left to send or it went through. */
  const syncNow = async (): Promise<boolean> => {
    clearTimeout(syncTimer.current);
    if (inFlight.current) await inFlight.current;

    const pending = questions.filter((q) => {
      const s = store.current[q.question_id];
      return s && s.rev > s.syncedRev;
    });
    if (pending.length === 0) return true;

    const sent = pending.map((q) => [q.question_id, store.current[q.question_id]!.rev] as const);
    setSyncStatus("syncing");
    const run = (async () => {
      try {
        const res = await syncAnswers(token, attempt.id, pending.map(toInput));
        for (const [id, rev] of sent) {
          const s = store.current[id];
          if (s && s.syncedRev < rev) s.syncedRev = rev;
        }
        deadline.current = Date.now() + res.remaining_seconds * 1000;
        setSyncStatus("idle");
        if (syncFailing.current) {
          syncFailing.current = false;
          log("sync_recovered", "Connection to the server is back, the saved answers were sent");
        }
        return true;
      } catch {
        setSyncStatus("failed");
        if (!syncFailing.current) {
          syncFailing.current = true;
          log("sync_failed", "Couldn't reach the server; answers stay on this computer and will be retried");
        }
        scheduleSync();
        return false;
      }
    })();
    inFlight.current = run;
    const ok = await run;
    if (inFlight.current === run) inFlight.current = null;
    return ok;
  };

  const changed = (questionId: number) => {
    store.current[questionId]!.rev += 1;
    persist(questionId);
    scheduleSync();
    rerender();
  };

  const finish = (result: AttemptSummary, reason?: "timeout" | "left_window") => {
    finished.current = true;
    clearTimeout(syncTimer.current);
    draftClear(attempt.id).catch(() => undefined);
    onFinished(result, reason);
  };

  const submit = async (auto: boolean, reason: "timeout" | "left_window" = "timeout") => {
    if (finished.current || submitInFlight.current) return;
    submitInFlight.current = true;
    setSubmitting(true);
    setError(null);

    const current = questions.find((q) => q.question_id === currentId.current);
    accumulateCurrent();
    if (current) logSummary(current);

    const saved = await syncNow();
    if (!saved && !auto) {
      submitInFlight.current = false;
      setSubmitting(false);
      setError("Couldn't save your answers. Check your connection and try again.");
      log("submit_failed", "Submit stopped: the answers couldn't be saved to the server");
      return;
    }
    // how much of the exam was answered, for the score on the Activity page
    const answeredQuestions = questions.filter((qq) => isAnswered(store.current[qq.question_id]!));
    const completion = {
      answered: answeredQuestions.length,
      total: questions.length,
      marks_answered: answeredQuestions.reduce((sum, qq) => sum + qq.marks, 0),
      marks_total: questions.reduce((sum, qq) => sum + qq.marks, 0),
    };
    const logSubmitted = () =>
      auto
        ? log(
            "auto_submitted",
            reason === "left_window"
              ? "Left the exam window - the attempt was submitted automatically and the exam ended"
              : "Time ran out, the answers were submitted automatically",
            { data: completion },
          )
        : log("attempt_submitted", "The student submitted the attempt", { data: completion });
    try {
      const result = (await submitAttempt(token, attempt.id)).attempt;
      logSubmitted();
      finish(result, auto ? reason : undefined);
    } catch (err) {
      if (auto) {
        // The server closes an attempt whose time ran out by itself; ask for its final state.
        try {
          const result = await getAttempt(token, attempt.id);
          logSubmitted();
          finish(result, reason);
          return;
        } catch {
          // fall through to the error below
        }
      }
      submitInFlight.current = false;
      setSubmitting(false);
      const message = err instanceof ApiError ? err.message : String(err);
      setError(message);
      log("submit_failed", `Submit failed: ${message}`);
    }
  };

  // Local drafts win over what the server has; any that exist are pushed up again.
  useEffect(() => {
    let cancelled = false;
    const initial: Record<number, QuestionState> = {};
    for (const q of questions) initial[q.question_id] = fromServer(q);
    draftLoad(attempt.id)
      .catch(() => [] as AnswerDraft[])
      .then((drafts) => {
        if (cancelled) return;
        for (const d of drafts) if (initial[d.question_id]) initial[d.question_id] = fromDraft(d);
        store.current = initial;
        setReady(true);
        log(
          resumed ? "attempt_resumed" : "attempt_started",
          `${resumed ? "Resumed" : "Started"} "${attempt.exam.name}": ${questions.length} questions, ${Math.round(attempt.remaining_seconds / 60)} min ${resumed ? "left" : ""}`.trim(),
          { data: { question_count: questions.length, order: questions.map((q) => q.title) } },
        );
        if (checkIn?.idNumber) {
          log(
            "identity_check",
            `ID number ${checkIn.idNumber}${checkIn.photo ? ", photo taken before the exam" : ", no photo (no camera)"}`,
            { data: { id_number: checkIn.idNumber, ...(checkIn.photo ? { image: checkIn.photo } : {}) } },
          );
          if (checkIn.photo) {
            uploadMedia(token, attempt.id, "face-snapshots", checkIn.photo, `ID number ${checkIn.idNumber}`).catch(() => undefined);
          }
        }
        for (const note of checkIn?.notes ?? []) log(note.kind, note.detail);
        if (drafts.length > 0) {
          log("drafts_restored", `Restored ${drafts.length} saved answer(s) from this computer`, { data: { count: drafts.length } });
          scheduleSync();
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) void submit(true);
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Time on a question runs while it is on screen; leaving it saves that and flushes to the server.
  useEffect(() => {
    if (!ready) return;
    const q = questions[index];
    if (!q) return;
    const s = store.current[q.question_id]!;
    currentId.current = q.question_id;
    shownAt.current = Date.now();
    log("question_opened", `Opened ${labelOf(q)}`, { questionId: q.question_id, data: { position: index + 1 } });
    if (!s.startedAt) {
      s.startedAt = new Date().toISOString();
      changed(q.question_id);
    }
    return () => {
      if (finished.current) return;
      accumulateCurrent();
      currentId.current = null;
      logSummary(q);
      persist(q.question_id);
      void syncNow();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, index]);

  // Holds back copying, pasting and the developer tools, and watches the window, the screens,
  // the apps and the permitted links.
  const guard = useExamGuard({
    enabled: ready,
    log,
    where: whereNow,
    questionId: () => currentId.current ?? undefined,
    permittedUrls: attempt.permitted_urls.map((u) => u.url),
    // Leaving isn't just logged - it ends the exam, the same way time running out does.
    onLeave: () => void submit(true, "left_window"),
  });

  if (!ready) {
    return <p className="text-center text-sm text-magi-secondary font-light py-10">Loading…</p>;
  }

  const q = questions[index]!;
  const s = store.current[q.question_id]!;

  const choose = (optionId: number) => {
    s.optionIds = [optionId];
    s.answeredAt = new Date().toISOString();
    changed(q.question_id);
  };

  const typed = (value: string, metrics: TypingMetrics) => {
    s.answer = value;
    s.metrics = metrics;
    s.answeredAt = new Date().toISOString();
    changed(q.question_id);
  };

  const syncLabel = syncStatus === "syncing" ? "Saving…" : syncStatus === "failed" ? "Couldn't sync, retrying" : "Saved";

  return (
    <div className="space-y-4">
      <CameraPreview onEvent={(kind, detail, data) => log(kind, detail, { data })} />
      {/* Stays put while a long answer scrolls, so the countdown is never out of sight. */}
      <div className="sticky top-0 z-20 flex items-center justify-between pb-3 -mx-4 px-4 pt-2 bg-magi-white/95 backdrop-blur-sm border-b border-magi-border">
        <h3 className="text-lg font-bold font-outfit text-magi-primary">{attempt.exam.name}</h3>
        <div className="flex items-center gap-3">
          <span className={`text-xs ${syncStatus === "failed" ? "text-magi-destructive" : "text-magi-secondary"}`}>{syncLabel}</span>
          <span
            role="timer"
            className={`px-2.5 py-1 rounded-lg bg-magi-surface border border-magi-border text-xs font-semibold tabular-nums ${
              remaining <= 60 ? "text-magi-destructive" : "text-magi-primary"
            }`}
          >
            {formatClock(remaining)}
          </span>
        </div>
      </div>

      {attempt.permitted_urls.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-magi-secondary">Permitted links:</span>
          {attempt.permitted_urls.map((link) => (
            <button
              key={link.id}
              type="button"
              onClick={() => guard.openLink(link.url)}
              className="px-2.5 py-1 rounded-lg border border-magi-border text-magi-primary hover:bg-magi-surface transition-colors"
            >
              {link.url}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {questions.map((qq, i) => (
          <button
            key={qq.question_id}
            type="button"
            aria-label={`Question ${i + 1}`}
            aria-current={i === index ? "step" : undefined}
            onClick={() => setIndex(i)}
            className={`w-8 h-8 rounded-lg border text-xs font-semibold transition-colors ${
              i === index
                ? "border-magi-primary bg-magi-primary text-white"
                : isAnswered(store.current[qq.question_id]!)
                  ? "border-magi-primary bg-magi-surface text-magi-primary"
                  : "border-magi-border bg-magi-white text-magi-secondary hover:border-magi-primary"
            }`}
          >
            {i + 1}
          </button>
        ))}
      </div>

      <div className="glass-card p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm font-medium text-magi-primary">{q.question}</p>
          <span className="shrink-0 text-xs text-magi-secondary">{q.marks} marks</span>
        </div>

        {TEXT_TYPES.has(q.question_type) ? (
          <AnswerSheet
            key={q.question_id}
            value={s.answer}
            metrics={s.metrics}
            label="Your answer"
            onChange={typed}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            {q.options.map((opt) => (
              <button
                key={opt.id}
                onClick={() => choose(opt.id)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  s.optionIds.includes(opt.id)
                    ? "border-magi-primary bg-magi-primary text-white"
                    : "border-magi-border bg-magi-surface text-magi-primary hover:border-magi-primary"
                }`}
              >
                {opt.option_text}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-red-50 border border-red-200">
          <p className="text-sm text-magi-destructive font-medium">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <button
          type="button"
          disabled={index === 0}
          onClick={() => setIndex(index - 1)}
          className="px-3 py-2 text-sm rounded-lg border border-magi-border text-magi-secondary hover:text-magi-primary hover:bg-magi-surface transition-colors disabled:opacity-30"
        >
          ← Previous
        </button>
        {index === questions.length - 1 ? (
          <AnimatedButton disabled={submitting} onClick={() => void submit(false)} className={primaryButtonClass}>
            {submitting ? "Submitting…" : "Submit attempt"}
          </AnimatedButton>
        ) : (
          <button type="button" onClick={() => setIndex(index + 1)} className={primaryButtonClass}>
            Next →
          </button>
        )}
      </div>
    </div>
  );
}
