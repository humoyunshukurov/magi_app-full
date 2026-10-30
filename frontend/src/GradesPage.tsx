// What the student's attempts came back as: every exam they've started, its current status,
// and - once a professor has graded it - the score and their written feedback. Mirrors the
// "new grade" notification already built for the web student dashboard (magi-frontend), same
// localStorage-based "seen" tracking, adapted to this app's own bearer-token API client.

import { useEffect, useState } from "react";
import { listMyAttempts, type AttemptSummary } from "./api";

const SEEN_GRADES_KEY = "magi_seen_grades";

function loadSeenGrades(): number[] {
  try {
    const raw = localStorage.getItem(SEEN_GRADES_KEY);
    return raw ? (JSON.parse(raw) as number[]) : [];
  } catch {
    return [];
  }
}

function markGradeSeen(attemptId: number) {
  try {
    localStorage.setItem(SEEN_GRADES_KEY, JSON.stringify([...loadSeenGrades(), attemptId]));
  } catch {
    // storage unavailable - the notification will just show again next visit
  }
}

function statusLabel(a: AttemptSummary): string {
  if (a.status === "in_progress") return "In progress";
  if (a.status === "graded") return `Graded: ${a.score}/${a.exam.max_marks}`;
  if (a.status === "auto_submitted") return "Submitted (time ran out)";
  return "Submitted";
}

export function GradesPage({ token, visible }: { token: string; visible: boolean }) {
  const [attempts, setAttempts] = useState<AttemptSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seenGrades, setSeenGrades] = useState<number[]>([]);

  useEffect(() => {
    setSeenGrades(loadSeenGrades());
  }, []);

  // The page stays mounted while the student is on another one, so it reads afresh whenever it is shown.
  useEffect(() => {
    if (!visible) return;
    listMyAttempts(token)
      .then(setAttempts)
      .catch(() => setError("Could not load your grades. Check your connection and try again."));
  }, [token, visible]);

  const dismissGrade = (attemptId: number) => {
    markGradeSeen(attemptId);
    setSeenGrades((prev) => [...prev, attemptId]);
  };

  const newGrades = attempts?.filter((a) => a.status === "graded" && !seenGrades.includes(a.id)) ?? [];
  const gradedCount = attempts?.filter((a) => a.status === "graded").length ?? 0;
  const submittedCount = attempts?.filter((a) => a.status === "submitted" || a.status === "auto_submitted" || a.status === "graded").length ?? 0;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-extrabold font-outfit tracking-tight text-magi-primary">Grades</h2>
        <p className="text-sm text-magi-secondary font-light mt-1">Every exam you&apos;ve started, and what came back once it was graded.</p>
      </div>

      {error && (
        <div role="alert" className="p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-magi-destructive">
          {error}
        </div>
      )}

      {newGrades.length > 0 && (
        <div className="space-y-4">
          {newGrades.map((a) => (
            <div key={a.id} className="glass-card p-5 border-2 border-magi-success/30 bg-magi-success/5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-bold text-magi-success uppercase tracking-wide">Your exam was graded</p>
                  <h3 className="text-base font-bold font-outfit text-magi-primary mt-1">{a.exam.name}</h3>
                  <p className="text-sm text-magi-secondary mt-1">
                    Score: <strong className="text-magi-primary">{a.score}/{a.exam.max_marks}</strong>
                    {a.passed !== undefined && (
                      <span className={a.passed ? "text-magi-success font-semibold ml-2" : "text-magi-destructive font-semibold ml-2"}>
                        {a.passed ? "Passed" : "Not passed"}
                      </span>
                    )}
                  </p>
                  {a.feedback && (
                    <p className="text-sm text-magi-primary mt-3 p-3 rounded-lg bg-magi-white border border-magi-border whitespace-pre-wrap">
                      &ldquo;{a.feedback}&rdquo;
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => dismissGrade(a.id)}
                  className="shrink-0 text-xs font-semibold text-magi-secondary hover:text-magi-primary transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {attempts && attempts.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div className="glass-card p-6">
            <span className="text-magi-secondary text-xs uppercase tracking-widest font-semibold">Submitted</span>
            <div className="mt-4">
              <span className="text-3xl font-bold font-outfit text-magi-primary">{submittedCount}</span>
              <span className="text-magi-secondary text-xs ml-2">of {attempts.length}</span>
            </div>
          </div>
          <div className="glass-card p-6">
            <span className="text-magi-secondary text-xs uppercase tracking-widest font-semibold">Graded</span>
            <div className="mt-4">
              <span className="text-3xl font-bold font-outfit text-magi-primary">{gradedCount}</span>
              <span className="text-magi-secondary text-xs ml-2">of {attempts.length}</span>
            </div>
          </div>
        </div>
      )}

      {attempts === null ? (
        <p className="text-sm text-magi-secondary font-light">Loading…</p>
      ) : attempts.length === 0 ? (
        <p className="text-sm text-magi-secondary font-light">You haven&apos;t started an exam yet.</p>
      ) : (
        <div className="space-y-3">
          {attempts.map((a) => (
            <div key={a.id} className="glass-card p-4">
              <div className="flex items-center justify-between gap-4">
                <h3 className="text-sm font-bold text-magi-primary">{a.exam.name}</h3>
                <span className="text-xs text-magi-secondary font-semibold">{statusLabel(a)}</span>
              </div>
              {a.status === "graded" && a.feedback && (
                <p className="text-xs text-magi-secondary mt-2 pt-2 border-t border-magi-border italic">&ldquo;{a.feedback}&rdquo;</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
