// Minimal student-facing UI over the magi-server API client (api.ts) - login/signup, the
// exam list, and taking one attempt through to a graded result. Proves the frontend can
// actually drive the Rust backend end to end; the exam/question authoring UI is staff-only
// and out of scope on this (student) client.

import { useState } from "react";
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

export function AuthPanel() {
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exams, setExams] = useState<ExamSummary[] | null>(null);
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [result, setResult] = useState<AttemptSummary | null>(null);

  async function refreshExams(token: string) {
    setExams(await listExams(token));
  }

  async function onSubmitAuth(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      if (mode === "signup") {
        const message = await signup({ first_name: firstName, email, password });
        setNotice(message);
        return;
      }
      const { token, user } = await login(email, password);
      setSession({ token, user });
      await refreshExams(token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
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
    const { attempt: graded, message } = await submitAttempt(session.token, attempt.id);
    setResult(graded);
    setNotice(message);
    setAttempt(null);
  }

  if (!session) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-400">magi-server: {mode}</h2>
        <form onSubmit={(e) => void onSubmitAuth(e)} className="mt-3 space-y-2">
          {mode === "signup" && (
            <input
              className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
              placeholder="First name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
          )}
          <input
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
            placeholder="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium">
            {mode === "login" ? "Log in" : "Sign up"}
          </button>
          <button
            type="button"
            className="ml-2 text-sm text-slate-400 underline"
            onClick={() => setMode(mode === "login" ? "signup" : "login")}
          >
            {mode === "login" ? "Need an account?" : "Have an account?"}
          </button>
        </form>
        {error && <p className="mt-2 font-mono text-sm text-red-400">error: {error}</p>}
        {notice && <p className="mt-2 font-mono text-sm text-emerald-400">{notice}</p>}
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-400">
          magi-server: {session.user.email} ({session.user.role})
        </h2>
        <button onClick={() => void onLogout()} className="text-sm text-slate-400 underline">
          Log out
        </button>
      </div>

      {error && <p className="mt-2 font-mono text-sm text-red-400">error: {error}</p>}
      {notice && <p className="mt-2 font-mono text-sm text-emerald-400">{notice}</p>}

      {result && (
        <p className="mt-2 font-mono text-sm text-indigo-300">
          graded: score {result.score ?? "?"}, passed {String(result.passed)}
        </p>
      )}

      {attempt ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-slate-400">Attempt #{attempt.id} - {attempt.remaining_seconds}s left</p>
          {attempt.questions.map((q) => (
            <div key={q.question_id} className="rounded border border-slate-800 p-2">
              <p className="text-sm">{q.question}</p>
              {q.options.map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => void onAnswer(q.question_id, opt.id)}
                  className={`mr-2 mt-1 rounded border px-2 py-0.5 text-xs ${
                    q.selected_option_ids.includes(opt.id) ? "border-indigo-500 text-indigo-300" : "border-slate-700"
                  }`}
                >
                  {opt.option_text}
                </button>
              ))}
            </div>
          ))}
          <button onClick={() => void onSubmitAttempt()} className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium">
            Submit attempt
          </button>
        </div>
      ) : (
        <ul className="mt-3 space-y-1">
          {(exams ?? []).map((exam) => (
            <li key={exam.id} className="flex items-center justify-between text-sm">
              <span>
                {exam.name} <span className="text-slate-500">({exam.status})</span>
              </span>
              <button onClick={() => void onStartAttempt(exam.id)} className="rounded bg-indigo-600 px-2 py-0.5 text-xs">
                Start
              </button>
            </li>
          ))}
          {exams?.length === 0 && <li className="text-sm text-slate-500">No exams assigned.</li>}
        </ul>
      )}
    </section>
  );
}
