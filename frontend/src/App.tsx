import { useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { setUpdating } from "./updateState";
import { AuthPanel } from "./AuthPanel";

export function App() {
  const [examRunning, setExamRunning] = useState(false);

  // ADR-0008: checked once per launch. The download runs in the background rather than blocking
  // this effect's caller, so PreExam's environment check holds the exam back with setUpdating
  // until it's done - otherwise a student could start an exam mid-download and get pulled into a
  // relaunch partway through it. Windows exits the app itself after installing; macOS/Linux need
  // the explicit relaunch below.
  useEffect(() => {
    (async () => {
      try {
        const update = await check();
        if (!update) return;
        setUpdating(true);
        await update.downloadAndInstall();
        await relaunch();
      } catch (e) {
        console.error("update check failed:", e);
        setUpdating(false);
      }
    })();
  }, []);

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
        <main className={`flex-grow min-w-0 w-full ${examRunning ? "px-4 py-4" : "max-w-5xl mx-auto px-6 py-10"}`}>
          <AuthPanel onExamRunning={setExamRunning} />
        </main>
      </div>

      <footer hidden={examRunning} className="bg-magi-white border-t border-magi-border py-6">
        <p className="text-center text-xs text-magi-secondary font-light">&copy; {new Date().getFullYear()} MAGI</p>
      </footer>
    </div>
  );
}
