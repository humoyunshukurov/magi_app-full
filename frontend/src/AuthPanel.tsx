// login, the exam list, and running one attempt (bearer token, see ADR-0004)

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatedButton } from "./components/AnimatedButton";
import {
  ApiError,
  listExams,
  login,
  logout,
  me,
  startAttempt,
  type AttemptSummary,
  type ExamSummary,
  type UserSummary,
} from "./api";
import { listen } from "@tauri-apps/api/event";
import { examLock, launchPayloadSchema, LAUNCH_EVENT } from "./ipc";
import { PreExam, type CheckIn } from "./PreExam";
import { AttemptSession, type AttemptView } from "./AttemptSession";
import { inputClass, primaryButtonClass } from "./ui";

interface Session {
  token: string;
  user: UserSummary;
}

// so they don't have to log in every time
const SESSION_KEY = "magi_session";

function loadStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function storeSession(session: Session | null) {
  try {
    if (session) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // storage unavailable (private mode, restricted webview) - session just won't persist
  }
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mb-4 p-4 rounded-xl bg-red-50 border border-red-200">
      <p className="text-sm text-magi-destructive font-medium">{message}</p>
    </div>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
        />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    );
  }
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M3 3l18 18M10.584 10.587a2 2 0 002.829 2.828M9.363 5.365A9.466 9.466 0 0112 5c4.478 0 8.268 2.943 9.542 7a10.05 10.05 0 01-4.132 5.411M6.423 6.423C4.5 7.86 3.023 9.767 2.458 12c.51 2.042 1.716 3.826 3.34 5.147"
      />
    </svg>
  );
}

function ReloadIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg className={`w-4 h-4 ${spinning ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h5M20 20v-5h-5" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4.5 9a7.5 7.5 0 0113-4.5M19.5 15a7.5 7.5 0 01-13 4.5" />
    </svg>
  );
}

function PasswordInput({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        className={`${inputClass} pr-10`}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? t("authPanel.hidePassword") : t("authPanel.showPassword")}
        className="absolute inset-y-0 right-0 flex items-center px-3 text-magi-secondary hover:text-magi-primary"
      >
        <EyeIcon open={visible} />
      </button>
    </div>
  );
}

// sign in only: student accounts are made by the professor in the admin panel
function AuthForm({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fillTestAccount = () => {
    setEmail("humoyun@test.com");
    setPassword("123456");
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      onSignedIn(await login(email, password));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="glass-card py-8 px-6 sm:px-10 max-w-md mx-auto">
      <h2 className="text-2xl font-extrabold font-outfit tracking-tight text-magi-primary text-center mb-1">{t("authPanel.signIn")}</h2>
      <p className="text-center text-sm text-magi-secondary font-light mb-6">{t("authPanel.accountsFromProfessor")}</p>

      <button
        type="button"
        onClick={fillTestAccount}
        className="mb-4 w-full text-left p-3 rounded-[10px] bg-magi-surface border border-dashed border-magi-border hover:border-magi-primary transition-colors"
      >
        <p className="text-xs font-semibold text-magi-primary">{t("authPanel.testAccount")}</p>
        <p className="text-xs text-magi-secondary font-mono mt-0.5">humoyun@test.com / 123456</p>
      </button>

      {error && <ErrorBanner message={error} />}

      <form className="space-y-4" onSubmit={(e) => void onSubmit(e)}>
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-magi-primary">
            {t("authPanel.emailAddress")}
          </label>
          <input
            id="email"
            className={`mt-1 ${inputClass}`}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-sm font-medium text-magi-primary">
            {t("authPanel.password")}
          </label>
          <div className="mt-1">
            <PasswordInput id="password" value={password} onChange={setPassword} />
          </div>
        </div>
        <AnimatedButton type="submit" disabled={isLoading} className={`w-full ${primaryButtonClass}`}>
          {isLoading ? t("authPanel.pleaseWait") : t("authPanel.signIn")}
        </AnimatedButton>
      </form>
    </div>
  );
}

function ExamAction({
  exam,
  startingId,
  onStart,
}: {
  exam: ExamSummary;
  startingId: number | null;
  onStart: (examId: number) => void;
}) {
  const { t } = useTranslation();
  // ExamList only ever renders an actionable exam (see isActionable) - a done one never reaches here.
  const resuming = exam.attempt_status === "in_progress";
  const busy = startingId === exam.id;
  return (
    <AnimatedButton
      disabled={startingId !== null}
      onClick={() => onStart(exam.id)}
      className="px-4 py-2 bg-magi-primary hover:bg-magi-hover text-white text-xs font-bold rounded-[10px] transition-colors disabled:opacity-60"
    >
      {resuming ? (busy ? t("authPanel.resuming") : t("authPanel.resume")) : busy ? t("authPanel.starting") : t("authPanel.start")}
    </AnimatedButton>
  );
}

// what can be started/resumed now, the rest is on the web. past the end it can still be
// taken, it just counts as late (the backend scores it 0)
// statuses must match STARTABLE_EXAM_STATUSES in the backend
const STARTABLE_STATUSES = new Set(["scheduled", "ongoing", "demo"]);
function isActionable(exam: ExamSummary): boolean {
  if (exam.attempt_status === "in_progress") return true;
  if (exam.attempt_status) return false; // submitted/auto_submitted/graded - nothing left to do
  if (!STARTABLE_STATUSES.has(exam.status)) return false;
  return Date.now() >= new Date(exam.scheduled_start).getTime();
}

// newest first by id (scheduled_start can be anything)
const STATUS_RANK: Record<ExamSummary["status"], number> = {
  ongoing: 0,
  demo: 0,
  scheduled: 1,
  delayed: 1,
  completed: 2,
  cancelled: 3,
};

function sortExams(exams: ExamSummary[]): ExamSummary[] {
  return [...exams].sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    return rank !== 0 ? rank : b.id - a.id;
  });
}

function formatSchedule(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const date = s.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const startTime = s.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const endTime = e.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date}, ${startTime}–${endTime}`;
}

function ExamList({
  exams,
  startingId,
  onStart,
}: {
  exams: ExamSummary[];
  startingId: number | null;
  onStart: (examId: number) => void;
}) {
  const { t } = useTranslation();
  const actionable = exams.filter(isActionable);
  if (actionable.length === 0) {
    return (
      <div className="glass-card px-6 py-12 text-center">
        <p className="text-sm text-magi-muted">{t("authPanel.noExams")}</p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
      {sortExams(actionable).map((exam) => (
        <div key={exam.id} className="glass-card lift p-[22px] flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-magi-primary">{exam.name}</h3>
              <span className="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide bg-[#F2F2F2] text-magi-secondary">
                {exam.kind === "homework" ? t("authPanel.homeworkAbbr") : t("authPanel.examLabel")}
              </span>
            </div>
            <p
              className={`text-[11px] font-bold mt-2.5 uppercase tracking-wider ${
                exam.status === "ongoing" || exam.attempt_status === "in_progress" ? "text-magi-success" : "text-magi-muted"
              }`}
            >
              {exam.status}
            </p>
            {Date.now() >= new Date(exam.scheduled_end).getTime() && exam.attempt_status !== "in_progress" && (
              <p className="text-[11px] font-bold text-magi-destructive mt-1">{t("authPanel.overdue")}</p>
            )}
            <p className="text-magi-muted text-xs tabular-nums mt-0.5">{formatSchedule(exam.scheduled_start, exam.scheduled_end)}</p>
          </div>
          <div className="mt-5 pt-4 border-t border-[#F2F2F2] flex justify-between items-center text-xs">
            <span className="text-magi-muted">{t("authPanel.marksPassAt", { max: exam.max_marks, passing: exam.passing_marks })}</span>
            <ExamAction exam={exam} startingId={startingId} onStart={onStart} />
          </div>
        </div>
      ))}
    </div>
  );
}

function formatLate(seconds: number): string {
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function AttemptResult({ result, reason }: { result: AttemptSummary; reason?: "left_window" }) {
  const { t } = useTranslation();
  const lateNote = result.late_seconds > 0 ? t("authPanel.lateBy", { time: formatLate(result.late_seconds) }) : null;
  // auto_submitted is always false now, reason is what tells us they left the window
  if (result.status !== "graded") {
    const message = reason === "left_window" ? t("authPanel.leftWindowSubmitted") : t("authPanel.answersSubmitted");
    return (
      <div className="glass-card p-5">
        <p className="text-sm font-semibold text-magi-primary">{message}</p>
        {lateNote && <p className="text-xs text-magi-destructive font-medium mt-1">{lateNote}</p>}
        <p className="text-xs text-magi-secondary mt-1">{t("authPanel.gradedSoon")}</p>
      </div>
    );
  }
  return (
    <div className="p-5 rounded-[18px] bg-magi-success/10 border border-magi-success/20">
      <p className="text-sm font-semibold text-magi-success">
        {t("authPanel.gradedResult", {
          score: result.score ?? "?",
          max: result.exam.max_marks,
          status: result.passed ? t("authPanel.passed") : t("authPanel.notPassed"),
        })}
      </p>
      {lateNote && <p className="text-xs text-magi-destructive font-medium mt-1">{lateNote}</p>}
      {result.zeroed_for_late && (
        <p className="text-xs text-magi-destructive font-medium mt-1">
          {t("authPanel.zeroedForLate", { marked: result.marked_score ?? 0, max: result.exam.max_marks })}
        </p>
      )}
    </div>
  );
}

export function AuthPanel({
  onSessionChange,
  onExamRunning,
}: {
  onSessionChange?: (session: { user: UserSummary; token: string } | null) => void;
  /** Tells the app whether an exam is open, so it can keep the rest of the app out of the way. */
  onExamRunning?: (running: boolean) => void;
}) {
  const { t } = useTranslation();
  const [session, setSession] = useState<Session | null>(null);
  const [restoringSession, setRestoringSession] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exams, setExams] = useState<ExamSummary[] | null>(null);
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [result, setResult] = useState<AttemptSummary | null>(null);
  const [resultReason, setResultReason] = useState<"left_window" | undefined>(undefined);
  const [startingId, setStartingId] = useState<number | null>(null);
  const [resumed, setResumed] = useState(false);
  const [checking, setChecking] = useState<{ examId: number; resumes: boolean } | null>(null);
  const [checkIn, setCheckIn] = useState<CheckIn | null>(null);
  const [reloading, setReloading] = useState(false);
  const [pendingExamId, setPendingExamId] = useState<number | null>(null);

  useEffect(() => {
    onSessionChange?.(session ? { user: session.user, token: session.token } : null);
  }, [session, onSessionChange]);

  // magi://launch?examId=... can arrive before login
  useEffect(() => {
    const unlisten = listen(LAUNCH_EVENT, (event) => {
      const parsed = launchPayloadSchema.safeParse(event.payload);
      if (parsed.success && parsed.data.exam_id !== null) setPendingExamId(parsed.data.exam_id);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // same path as pressing Start
  useEffect(() => {
    if (pendingExamId === null || !session || !exams || attempt || checking) return;
    const target = exams.find((e) => e.id === pendingExamId);
    setPendingExamId(null);
    if (!target) return;
    if (target.attempt_status === "graded" || target.attempt_status === "submitted" || target.attempt_status === "auto_submitted") return;
    onStart(target.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingExamId, session, exams, attempt, checking]);

  useEffect(() => {
    onExamRunning?.(attempt !== null || checking !== null);
  }, [attempt, checking, onExamRunning]);

  useEffect(() => {
    const stored = loadStoredSession();
    if (!stored) {
      setRestoringSession(false);
      return;
    }
    me(stored.token)
      .then(async (user) => {
        const restored = { token: stored.token, user };
        setSession(restored);
        // failing to load exams isn't a bad token, don't log them out over it
        try {
          setExams(await listExams(restored.token));
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        }
      })
      .catch((err) => {
        // only log out on a real auth error, not when the server is down
        if (err instanceof ApiError && err.kind === "response") storeSession(null);
      })
      .finally(() => setRestoringSession(false));
  }, []);

  async function onSignedIn(newSession: Session) {
    setSession(newSession);
    storeSession(newSession);
    // otherwise it just looks like "no exams"
    try {
      setExams(await listExams(newSession.token));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function onLogout() {
    if (!session) return;
    await logout(session.token).catch(() => undefined);
    storeSession(null);
    setSession(null);
    setExams(null);
    setAttempt(null);
    setResult(null);
    setResultReason(undefined);
  }

  async function reloadExams() {
    if (!session) return;
    setReloading(true);
    // min spinner time so the click looks like it did something
    const minSpin = new Promise((resolve) => setTimeout(resolve, 400));
    try {
      const [fresh] = await Promise.all([listExams(session.token), minSpin]);
      setExams(fresh);
    } catch (err) {
      await minSpin;
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setReloading(false);
    }
  }

  // Start first goes through the checks; the attempt is only created (and its clock started) after them.
  function onStart(examId: number) {
    setError(null);
    setChecking({ examId, resumes: exams?.find((e) => e.id === examId)?.attempt_status === "in_progress" });
  }

  async function onStartAttempt(examId: number, resumes: boolean, checkedIn: CheckIn) {
    if (!session) return;
    setChecking(null);
    setStartingId(examId);
    // lock right away, useExamGuard locking again is fine
    await examLock(true).catch(() => undefined);
    try {
      setAttempt(await startAttempt(session.token, examId));
      setResumed(resumes);
      setCheckIn(checkedIn);
      setResult(null);
      setResultReason(undefined);
    } catch (err) {
      await examLock(false).catch(() => undefined);
      setError(err instanceof ApiError ? err.message : String(err));
      // the list may be out of date (the attempt ended in the meantime)
      listExams(session.token).then(setExams, () => undefined);
    } finally {
      setStartingId(null);
    }
  }

  if (restoringSession) {
    return <p className="text-center text-sm text-magi-secondary font-light py-10">{t("authPanel.loading")}</p>;
  }

  if (!session) {
    return <AuthForm onSignedIn={(s) => void onSignedIn(s)} />;
  }

  return (
    <div className={`mx-auto ${attempt || checking ? "glass-card p-6 w-[95%]" : "max-w-4xl"}`}>
      <div className="flex items-center justify-between mb-8 pb-5 border-b border-magi-border">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-full bg-magi-primary text-white flex items-center justify-center text-sm font-bold font-outfit">
            {session.user.first_name.charAt(0).toUpperCase()}
          </span>
          <div>
            <h2 className="text-base font-bold font-outfit text-magi-primary">
              {session.user.first_name} {session.user.last_name}
            </h2>
            <p className="text-xs text-magi-muted">{session.user.email}</p>
          </div>
        </div>
        {/* hidden while locked - logging out would skip the violation logging */}
        {!checking && !attempt && (
          <button onClick={() => void onLogout()} className="text-sm text-magi-secondary hover:text-magi-primary transition-colors">
            {t("authPanel.logOut")}
          </button>
        )}
      </div>

      {error && <ErrorBanner message={error} />}
      {result && (
        <div className="mb-4">
          <AttemptResult result={result} reason={resultReason} />
        </div>
      )}

      {checking ? (
        <PreExam
          examName={exams?.find((e) => e.id === checking.examId)?.name ?? t("authPanel.examFallbackName")}
          withPhotos={!checking.resumes}
          token={session.token}
          onReady={(checkedIn) => void onStartAttempt(checking.examId, checking.resumes, checkedIn)}
          onCancel={() => setChecking(null)}
        />
      ) : attempt ? (
        <AttemptSession
          userId={session.user.id}
          token={session.token}
          attempt={attempt}
          resumed={resumed}
          checkIn={checkIn ?? undefined}
          onFinished={(finished, reason) => {
            setResult(finished);
            setResultReason(reason);
            setAttempt(null);
            listExams(session.token).then(setExams, () => undefined);
          }}
        />
      ) : (
        <div>
          <div className="flex items-end justify-between mb-7">
            <div>
              <h3 className="text-3xl font-bold font-outfit tracking-tight text-magi-primary">{t("authPanel.examsHeading")}</h3>
              <p className="text-sm text-magi-muted mt-1.5">{t("authPanel.examsSubtitle")}</p>
            </div>
            <button
              type="button"
              onClick={() => void reloadExams()}
              disabled={reloading}
              title={t("authPanel.reload")}
              aria-label={t("authPanel.reloadExams")}
              className="w-9 h-9 flex items-center justify-center rounded-[10px] border border-magi-border text-magi-muted hover:text-magi-primary hover:border-magi-primary transition-colors disabled:opacity-50"
            >
              <ReloadIcon spinning={reloading} />
            </button>
          </div>
          <ExamList exams={exams ?? []} startingId={startingId} onStart={onStart} />
        </div>
      )}
    </div>
  );
}
