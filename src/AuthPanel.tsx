// Student-facing UI over the magi-server API client (api.ts) - login/signup, the exam list,
// and taking one attempt through to a graded result. Same visual language as the MAGI web
// frontend (magi_ap_test: glass-card, the magi-* palette, Outfit type, AnimatedButton) so the
// desktop app and the web app read as one product; adapted, not copied - that frontend logs in
// via an httpOnly cookie (ADR-0004 chose bearer tokens for this client instead), and its
// dashboard/assignment pages are pre-pivot mock content with no real API behind them.

import { useState } from "react";
import { AnimatedButton } from "./components/AnimatedButton";
import {
  ApiError,
  getAttempt,
  listExams,
  login,
  logout,
  signup,
  startAttempt,
  submitAttempt,
  syncAnswers,
  type AnswerInput,
  type AttemptSummary,
  type ExamSummary,
  type UserSummary,
} from "./api";

interface Session {
  token: string;
  user: UserSummary;
}

type AttemptView = Awaited<ReturnType<typeof getAttempt>>;

const inputClass =
  "appearance-none block w-full px-3 py-2 border border-magi-border rounded-lg bg-magi-surface " +
  "placeholder-magi-secondary text-magi-primary focus:outline-none focus:ring-1 focus:ring-magi-primary " +
  "focus:border-magi-primary text-sm transition-all";

const primaryButtonClass =
  "flex justify-center py-2.5 px-4 border border-transparent rounded-lg bg-magi-primary text-white " +
  "text-sm font-bold transition-all hover:bg-magi-hover shadow-sm disabled:opacity-70";

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mb-4 p-4 rounded-lg bg-red-50 border border-red-200">
      <p className="text-sm text-magi-destructive font-medium">{message}</p>
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
            <button type="button" className="font-semibold text-magi-primary hover:text-magi-hover" onClick={() => setMode("signup")}>
              create a student account
            </button>
          </>
        ) : (
          <>
            Already have one?{" "}
            <button type="button" className="font-semibold text-magi-primary hover:text-magi-hover" onClick={() => setMode("login")}>
              sign in
            </button>
          </>
        )}
      </p>

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
          <input
            id="password"
            className={`mt-1 ${inputClass}`}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <AnimatedButton type="submit" disabled={isLoading} className={`w-full ${primaryButtonClass}`}>
          {isLoading ? "Please wait..." : mode === "login" ? "Sign In" : "Sign Up"}
        </AnimatedButton>
      </form>
    </div>
  );
}

function ExamList({ exams, onStart }: { exams: ExamSummary[]; onStart: (examId: number) => void }) {
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
          </div>
          <div className="mt-4 pt-3 border-t border-magi-border flex justify-between items-center text-xs">
            <span className="text-magi-secondary">{exam.max_marks} marks, pass at {exam.passing_marks}</span>
            <AnimatedButton
              onClick={() => onStart(exam.id)}
              className="px-2.5 py-1 bg-magi-primary hover:bg-magi-hover text-white text-[10px] font-bold rounded-lg transition-colors"
            >
              Start
            </AnimatedButton>
          </div>
        </div>
      ))}
    </div>
  );
}

function AttemptRunner({
  attempt,
  onAnswer,
  onSubmit,
}: {
  attempt: AttemptView;
  onAnswer: (questionId: number, optionId: number) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between pb-3 border-b border-magi-border">
        <h3 className="text-lg font-bold font-outfit text-magi-primary">{attempt.exam.name}</h3>
        <span className="px-2.5 py-1 rounded-lg bg-magi-surface border border-magi-border text-xs font-semibold text-magi-primary">
          {attempt.remaining_seconds}s left
        </span>
      </div>

      {attempt.questions.map((q) => (
        <div key={q.question_id} className="glass-card p-4">
          <p className="text-sm font-medium text-magi-primary mb-3">{q.question}</p>
          <div className="flex flex-wrap gap-2">
            {q.options.map((opt) => {
              const selected = q.selected_option_ids.includes(opt.id);
              return (
                <button
                  key={opt.id}
                  onClick={() => onAnswer(q.question_id, opt.id)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                    selected
                      ? "border-magi-primary bg-magi-primary text-white"
                      : "border-magi-border bg-magi-surface text-magi-primary hover:border-magi-primary"
                  }`}
                >
                  {opt.option_text}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <AnimatedButton onClick={onSubmit} className={primaryButtonClass}>
        Submit attempt
      </AnimatedButton>
    </div>
  );
}

function GradedResult({ result }: { result: AttemptSummary }) {
  return (
    <div className="p-4 rounded-lg bg-magi-success/10 border border-magi-success/20">
      <p className="text-sm font-semibold text-magi-success">
        Graded: {result.score ?? "?"} / {result.exam.max_marks} - {result.passed ? "passed" : "not passed"}
      </p>
    </div>
  );
}

export function AuthPanel() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exams, setExams] = useState<ExamSummary[] | null>(null);
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [result, setResult] = useState<AttemptSummary | null>(null);

  async function onSignedIn(newSession: Session) {
    setSession(newSession);
    setExams(await listExams(newSession.token));
  }

  async function onLogout() {
    if (!session) return;
    await logout(session.token).catch(() => undefined);
    setSession(null);
    setExams(null);
    setAttempt(null);
    setResult(null);
  }

  async function onStartAttempt(examId: number) {
    if (!session) return;
    setError(null);
    try {
      setAttempt(await startAttempt(session.token, examId));
      setResult(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function onAnswer(questionId: number, optionId: number) {
    if (!session || !attempt) return;
    const input: AnswerInput = { question_id: questionId, option_ids: [optionId] };
    await syncAnswers(session.token, attempt.id, [input]);
    setAttempt(await getAttempt(session.token, attempt.id));
  }

  async function onSubmitAttempt() {
    if (!session || !attempt) return;
    const submitted = await submitAttempt(session.token, attempt.id);
    setResult(submitted.attempt);
    setAttempt(null);
  }

  if (!session) {
    return <AuthForm onSignedIn={(s) => void onSignedIn(s)} />;
  }

  return (
    <div className="glass-card p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-magi-border">
        <div>
          <h2 className="text-lg font-bold font-outfit text-magi-primary">
            {session.user.first_name} {session.user.last_name}
          </h2>
          <p className="text-xs text-magi-secondary">{session.user.email}</p>
        </div>
        <button onClick={() => void onLogout()} className="text-sm text-magi-secondary hover:text-magi-primary transition-colors">
          Log out
        </button>
      </div>

      {error && <ErrorBanner message={error} />}
      {result && (
        <div className="mb-4">
          <GradedResult result={result} />
        </div>
      )}

      {attempt ? (
        <AttemptRunner attempt={attempt} onAnswer={(q, o) => void onAnswer(q, o)} onSubmit={() => void onSubmitAttempt()} />
      ) : (
        <ExamList exams={exams ?? []} onStart={(id) => void onStartAttempt(id)} />
      )}
    </div>
  );
}
