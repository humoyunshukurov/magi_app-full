// Student-facing UI over the magi-server API client (api.ts) - login/signup, the exam list,
// and taking one attempt through to a graded result. Same visual language as the MAGI web
// frontend (magi_ap_test: glass-card, the magi-* palette, Outfit type, AnimatedButton) so the
// desktop app and the web app read as one product; adapted, not copied - that frontend logs in
// via an httpOnly cookie (ADR-0004 chose bearer tokens for this client instead), and its
// dashboard/assignment pages are pre-pivot mock content with no real API behind them.

import { useEffect, useState } from "react";
import { AnimatedButton } from "./components/AnimatedButton";
import {
  ApiError,
  listExams,
  login,
  logout,
  me,
  signup,
  startAttempt,
  type AttemptSummary,
  type ExamSummary,
  type UserSummary,
} from "./api";
import { examLock } from "./ipc";
import { PreExam, type CheckIn } from "./PreExam";
import { AttemptSession, type AttemptView } from "./AttemptSession";
import { inputClass, primaryButtonClass } from "./ui";

interface Session {
  token: string;
  user: UserSummary;
}

// Persisted so a returning user isn't asked for their password every time the app opens -
// the token itself is what's authoritative (server-side TTL), this is just where it lives
// between sessions.
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
    <div className="mb-4 p-4 rounded-lg bg-red-50 border border-red-200">
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
        aria-label={visible ? "Hide password" : "Show password"}
        className="absolute inset-y-0 right-0 flex items-center px-3 text-magi-secondary hover:text-magi-primary"
      >
        <EyeIcon open={visible} />
      </button>
    </div>
  );
}

function AuthForm({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [firstName, setFirstName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Switching forms must not drag the old one's banner along - a wrong-password error from
  // login has no business still showing once the student has moved on to creating an account.
  function switchMode(next: "login" | "signup") {
    setMode(next);
    setError(null);
    setNotice(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setIsLoading(true);
    try {
      if (mode === "signup") {
        setNotice(await signup({ first_name: firstName, email, password }));
      } else {
        onSignedIn(await login(email, password));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="glass-card py-8 px-6 sm:px-10 max-w-md mx-auto">
      <h2 className="text-2xl font-extrabold font-outfit tracking-tight text-magi-primary text-center mb-1">
        {mode === "login" ? "Sign In" : "Create Account"}
      </h2>
      <p className="text-center text-sm text-magi-secondary font-light mb-6">
        {mode === "login" ? (
          <>
            Or{" "}
            <button type="button" className="font-semibold text-magi-primary hover:text-magi-hover" onClick={() => switchMode("signup")}>
              create a student account
            </button>
          </>
        ) : (
          <>
            Already have one?{" "}
            <button type="button" className="font-semibold text-magi-primary hover:text-magi-hover" onClick={() => switchMode("login")}>
              sign in
            </button>
          </>
        )}
      </p>

      {mode === "login" && (
        <div className="mb-4 p-3 rounded-lg bg-magi-surface border border-dashed border-magi-border">
          <p className="text-xs font-semibold text-magi-primary">Test account</p>
          <p className="text-xs text-magi-secondary font-mono mt-0.5">humoyun@test.com / 123456</p>
        </div>
      )}

      {error && <ErrorBanner message={error} />}
      {notice && (
        <div className="mb-4 p-4 rounded-lg bg-magi-success/10 border border-magi-success/20">
          <p className="text-sm text-magi-success font-medium">{notice}</p>
        </div>
      )}

      <form className="space-y-4" onSubmit={(e) => void onSubmit(e)}>
        {mode === "signup" && (
          <div>
            <label htmlFor="first-name" className="block text-sm font-medium text-magi-primary">
              First name
            </label>
            <input
              id="first-name"
              className={`mt-1 ${inputClass}`}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
            />
          </div>
        )}
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-magi-primary">
            Email Address
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
            Password
          </label>
          <div className="mt-1">
            <PasswordInput id="password" value={password} onChange={setPassword} />
          </div>
        </div>
        <AnimatedButton type="submit" disabled={isLoading} className={`w-full ${primaryButtonClass}`}>
          {isLoading ? "Please wait..." : mode === "login" ? "Sign In" : "Sign Up"}
        </AnimatedButton>
      </form>
    </div>
  );
}

const doneChip = "px-2.5 py-1 rounded-lg border border-magi-border bg-magi-white text-[10px] font-bold text-magi-secondary";

function formatCountdown(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `Starts in ${days}d ${hours}h`;
  if (hours > 0) return `Starts in ${hours}h ${minutes}m`;
  return `Starts in ${minutes}m`;
}

// Re-renders every 30s so the countdown stays roughly live without a timer per visible digit.
function StartsIn({ scheduledStart }: { scheduledStart: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const diff = new Date(scheduledStart).getTime() - now;
  if (diff <= 0) return null;
  return <p className="text-magi-secondary text-[11px] font-mono mt-0.5">{formatCountdown(diff)}</p>;
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
  // One attempt per exam: once it is handed in there is nothing left to start.
  if (exam.attempt_status === "graded") return <span className={doneChip}>Graded</span>;
  if (exam.attempt_status === "submitted" || exam.attempt_status === "auto_submitted") {
    return <span className={doneChip}>Submitted</span>;
  }
  const resuming = exam.attempt_status === "in_progress";
  const busy = startingId === exam.id;
  return (
    <AnimatedButton
      disabled={startingId !== null}
      onClick={() => onStart(exam.id)}
      className="px-2.5 py-1 bg-magi-primary hover:bg-magi-hover text-white text-[10px] font-bold rounded-lg transition-colors disabled:opacity-60"
    >
      {resuming ? (busy ? "Resuming…" : "Resume") : busy ? "Starting…" : "Start"}
    </AnimatedButton>
  );
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
  if (exams.length === 0) {
    return <p className="text-sm text-magi-secondary font-light">No exams assigned yet.</p>;
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {exams.map((exam) => (
        <div key={exam.id} className="p-4 rounded-lg bg-magi-surface border border-magi-border flex flex-col justify-between">
          <div>
            <h3 className="text-sm font-bold text-magi-primary">{exam.name}</h3>
            <p className="text-magi-secondary text-xs font-light mt-1 uppercase tracking-wide">{exam.status}</p>
            {!exam.attempt_status && <StartsIn scheduledStart={exam.scheduled_start} />}
          </div>
          <div className="mt-4 pt-3 border-t border-magi-border flex justify-between items-center text-xs">
            <span className="text-magi-secondary">{exam.max_marks} marks, pass at {exam.passing_marks}</span>
            <ExamAction exam={exam} startingId={startingId} onStart={onStart} />
          </div>
        </div>
      ))}
    </div>
  );
}

function AttemptResult({ result, reason }: { result: AttemptSummary; reason?: "timeout" | "left_window" }) {
  // Written answers can't be graded on submit, so a submitted attempt has no score yet.
  if (result.status !== "graded") {
    const message = !result.auto_submitted
      ? "Your answers were submitted."
      : reason === "left_window"
        ? "You left the exam window, so the attempt was submitted automatically and the exam ended."
        : "Time ran out, your answers were submitted automatically.";
    return (
      <div className="p-4 rounded-lg bg-magi-surface border border-magi-border">
        <p className="text-sm font-semibold text-magi-primary">{message}</p>
        <p className="text-xs text-magi-secondary mt-1">They will be graded soon.</p>
      </div>
    );
  }
  return (
    <div className="p-4 rounded-lg bg-magi-success/10 border border-magi-success/20">
      <p className="text-sm font-semibold text-magi-success">
        Graded: {result.score ?? "?"} / {result.exam.max_marks} - {result.passed ? "passed" : "not passed"}
      </p>
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
  const [session, setSession] = useState<Session | null>(null);
  const [restoringSession, setRestoringSession] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exams, setExams] = useState<ExamSummary[] | null>(null);
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [result, setResult] = useState<AttemptSummary | null>(null);
  const [resultReason, setResultReason] = useState<"timeout" | "left_window" | undefined>(undefined);
  const [startingId, setStartingId] = useState<number | null>(null);
  const [resumed, setResumed] = useState(false);
  const [checking, setChecking] = useState<{ examId: number; resumes: boolean } | null>(null);
  const [checkIn, setCheckIn] = useState<CheckIn | null>(null);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    onSessionChange?.(session ? { user: session.user, token: session.token } : null);
  }, [session, onSessionChange]);

  useEffect(() => {
    onExamRunning?.(attempt !== null || checking !== null);
  }, [attempt, checking, onExamRunning]);

  // On launch, try the token that's already on disk before asking for a password again -
  // `me` both validates it and refreshes the user record in one round trip.
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
        // Caught right here, not left to fall into the catch below: a failure fetching exams
        // is not "the token is no good" and must not log the student back out over it, but it
        // still has to be shown - otherwise exams stays null, which renders as an empty list.
        try {
          setExams(await listExams(restored.token));
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        }
      })
      .catch((err) => {
        // Only a genuine "that token is no good" answer should force a re-login - if the
        // server just wasn't reachable (e.g. mid-restart), keep the token for next time.
        if (err instanceof ApiError && err.kind === "response") storeSession(null);
      })
      .finally(() => setRestoringSession(false));
  }, []);

  async function onSignedIn(newSession: Session) {
    setSession(newSession);
    storeSession(newSession);
    // A failure here must not vanish silently: without this, exams stays null, which the list
    // below renders as an empty "[]" - the student would see "No exams assigned yet." with no
    // hint that anything actually went wrong.
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
    // A local reload can finish in a few ms - too fast to see spin, which reads as "did
    // nothing". Keep the spinner up for at least this long so the click is visibly answered.
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
    // Lock the window the instant Start is pressed, not once the attempt has round-tripped to
    // the server - `useExamGuard` locks again once it mounts, which is a harmless no-op.
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
    return <p className="text-center text-sm text-magi-secondary font-light py-10">Loading…</p>;
  }

  if (!session) {
    return <AuthForm onSignedIn={(s) => void onSignedIn(s)} />;
  }

  return (
    <div className={`glass-card p-6 mx-auto ${attempt || checking ? "w-[95%]" : "max-w-3xl"}`}>
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-magi-border">
        <div>
          <h2 className="text-lg font-bold font-outfit text-magi-primary">
            {session.user.first_name} {session.user.last_name}
          </h2>
          <p className="text-xs text-magi-secondary">{session.user.email}</p>
        </div>
        {/* Hidden once the exam is locked - a click here would silently end the attempt with
            none of the violation logging that leaving the window or closing the app gets,
            defeating the whole "you can't get out of this" warning the student was just shown. */}
        {!checking && !attempt && (
          <button onClick={() => void onLogout()} className="text-sm text-magi-secondary hover:text-magi-primary transition-colors">
            Log out
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
          examName={exams?.find((e) => e.id === checking.examId)?.name ?? "Exam"}
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
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-magi-primary">Exams</h3>
            <button
              type="button"
              onClick={() => void reloadExams()}
              disabled={reloading}
              title="Reload"
              aria-label="Reload exams"
              className="w-8 h-8 flex items-center justify-center rounded-md border border-magi-border text-magi-secondary hover:text-magi-primary hover:border-magi-primary transition-colors disabled:opacity-50"
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
