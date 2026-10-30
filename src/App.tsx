import { useCallback, useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { UserSummary } from "./api";
import { AuthPanel } from "./AuthPanel";
import { GradesPage } from "./GradesPage";

type Page = "exams" | "grades";

const PAGES: Array<{ id: Page; label: string }> = [
  { id: "exams", label: "Exams" },
  { id: "grades", label: "Grades" },
];

export function App() {
  const [page, setPage] = useState<Page>("exams");
  const [session, setSession] = useState<{ user: UserSummary; token: string } | null>(null);
  const [examRunning, setExamRunning] = useState(false);
  const user = session?.user ?? null;

  const onSessionChange = useCallback((next: { user: UserSummary; token: string } | null) => {
    setSession(next);
    if (!next) setPage("exams");
  }, []);

  // ADR-0008: checked once per launch, before anything else the student might do - an exam is
  // never interrupted mid-attempt, since a relaunch only happens here, at startup. Windows exits
  // the app itself after installing; macOS/Linux need the explicit relaunch below.
  useEffect(() => {
    (async () => {
      try {
        const update = await check();
        if (!update) return;
        await update.downloadAndInstall();
        await relaunch();
      } catch (e) {
        console.error("update check failed:", e);
      }
    })();
  }, []);

  const shownPage = examRunning ? "exams" : page;

  return (
    <div className="min-h-screen bg-magi-white text-magi-primary flex flex-col">
      {/* An open exam gets the whole window, the way a document fills a word processor - no
          branding bar competing with it for space. */}
      <header hidden={examRunning} className="sticky top-0 z-50 bg-magi-white border-b border-magi-border">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <span className="font-outfit font-extrabold text-lg tracking-tight">MAGI Desktop</span>
        </div>
      </header>

      <div className="flex flex-grow">
        {user && !examRunning && (
          <nav className="w-44 shrink-0 border-r border-magi-border p-4 space-y-1">
            {PAGES.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setPage(id)}
                aria-current={shownPage === id ? "page" : undefined}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                  shownPage === id ? "bg-magi-surface font-semibold text-magi-primary" : "text-magi-secondary hover:bg-magi-surface"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
        )}

        {/* pages stay mounted and only toggle visibility, so an open attempt survives switching */}
        <main className={`flex-grow min-w-0 w-full ${examRunning ? "px-4 py-4" : "max-w-5xl mx-auto px-6 py-10"}`}>
          <div hidden={shownPage !== "exams"} className="space-y-8">
            <AuthPanel onSessionChange={onSessionChange} onExamRunning={setExamRunning} />
          </div>

          {session && (
            <div hidden={shownPage !== "grades"}>
              <GradesPage token={session.token} visible={shownPage === "grades"} />
            </div>
          )}
        </main>
      </div>

      <footer hidden={examRunning} className="bg-magi-white border-t border-magi-border py-6">
        <p className="text-center text-xs text-magi-secondary font-light">&copy; {new Date().getFullYear()} MAGI</p>
      </footer>
    </div>
  );
}
