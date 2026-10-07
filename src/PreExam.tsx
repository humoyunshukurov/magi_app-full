// What happens between pressing Start and the exam opening: the computer is checked (one screen,
// no remote control or screen sharing apps), then the student types their ID number and the
// camera takes one photo of them with their ID card. The exam clock only starts after this.

import { useEffect, useRef, useState } from "react";
import type { EnvironmentReport } from "./generated/EnvironmentReport";
import { environmentCheck, screenshotTake } from "./ipc";
import { inputClass, primaryButtonClass } from "./ui";
import { CameraPicture, useCamera } from "./useCamera";

export interface CheckIn {
  /** Empty when an exam that was already running is picked up again. */
  idNumber: string;
  /** The photo of the student with their ID card; null without a camera. */
  photo: string | null;
  /** Things worth writing in the log that happened during the check-in. */
  notes: Array<{ kind: "camera_failed" | "screenshot_failed"; detail: string }>;
}

export const RECHECK_MS = 3000;

const secondaryButtonClass =
  "py-2.5 px-4 rounded-lg border border-magi-border text-sm font-semibold text-magi-primary hover:bg-magi-surface transition-colors";

function problemsOf(report: EnvironmentReport): string[] {
  const problems: string[] = [];
  if (report.monitor_count > 1 && !report.extra_screens_allowed) problems.push(`${report.monitor_count} screens are connected. Disconnect all but one.`);
  for (const app of report.forbidden_apps) problems.push(`${app} is running. Close it.`);
  if (report.other_windows.length > 0 && !report.other_windows_allowed) problems.push(`Other windows are open: ${report.other_windows.join(", ")}. Close them before starting.`);
  return problems;
}

function Warning({ onContinue, onCancel }: { onContinue: () => void; onCancel: () => void }) {
  return (
    <div role="alertdialog" aria-label="Before you start" className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg bg-magi-white shadow-xl p-5 space-y-4">
        <div>
          <p className="text-sm font-bold text-magi-primary">Before you start</p>
          <p className="text-sm text-magi-secondary mt-2">
            Once you start, the window goes full screen and locks: you won't be able to close it, minimize it, or switch
            to another app. Leaving the window, even briefly, is recorded as a possible cheating attempt along with a
            screenshot. Don't start until you're ready to stay in the exam the whole time.
          </p>
        </div>
        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={onCancel} className={`${secondaryButtonClass} flex-1`}>
            Cancel
          </button>
          <button type="button" onClick={onContinue} className={`${primaryButtonClass} flex-1 justify-center`}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function Environment({ onPassed, onCancel }: { onPassed: () => void; onCancel: () => void }) {
  const [problems, setProblems] = useState<string[] | null>(null);
  const passed = useRef(onPassed);
  passed.current = onPassed;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      let found: string[];
      try {
        found = problemsOf(await environmentCheck());
      } catch {
        found = []; // outside the app there is nothing to read
      }
      if (cancelled) return;
      if (found.length === 0) return passed.current();
      setProblems(found);
      timer = setTimeout(check, RECHECK_MS);
    };
    void check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (problems === null) {
    return <p className="text-center text-sm text-magi-secondary font-light py-10">Checking your computer…</p>;
  }
  return (
    <div className="space-y-4">
      <div role="alert" className="p-4 rounded-lg bg-red-50 border border-red-200">
        <p className="text-sm font-bold text-magi-destructive">The exam can't start yet</p>
        <ul className="mt-1 text-sm text-magi-destructive list-disc pl-5">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-magi-secondary">This checks again by itself every few seconds.</p>
      <button type="button" onClick={onCancel} className={secondaryButtonClass}>
        Cancel
      </button>
    </div>
  );
}

function Identity({ onReady, onCancel }: { onReady: (checkIn: CheckIn) => void; onCancel: () => void }) {
  const notes = useRef<CheckIn["notes"]>([]);
  const camera = useCamera((kind, detail) => {
    if (kind === "camera_failed") notes.current.push({ kind, detail });
  });
  const [idNumber, setIdNumber] = useState("");
  const [notReady, setNotReady] = useState(false);
  const [screenChecked, setScreenChecked] = useState(false);

  // While the student types, the screen is tried once and the picture thrown away: on some systems
  // the computer asks for permission to take screenshots, which is better settled now than in the
  // middle of the exam.
  useEffect(() => {
    let cancelled = false;
    screenshotTake()
      .catch((err: unknown) => {
        if (!cancelled) notes.current.push({ kind: "screenshot_failed", detail: `Couldn't take a screenshot: ${String(err)}` });
      })
      .finally(() => {
        if (!cancelled) setScreenChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const id = idNumber.trim();
  const start = () => {
    if (camera.problem) return onReady({ idNumber: id, photo: null, notes: notes.current });
    const photo = camera.grab();
    setNotReady(photo === null);
    if (photo) onReady({ idNumber: id, photo, notes: notes.current });
  };
  const ready = camera.problem !== null || camera.source !== null;

  return (
    <div className="space-y-4">
      {camera.problem ? (
        <div role="alert" className="p-4 rounded-lg bg-red-50 border border-red-200">
          <p className="text-sm font-bold text-magi-destructive">The camera isn't available</p>
          <p className="text-sm text-magi-destructive mt-1">{camera.problem}. The exam can go on without it, and this is recorded.</p>
        </div>
      ) : (
        <div className="max-w-sm mx-auto rounded-lg overflow-hidden border border-magi-border bg-black">
          <CameraPicture camera={camera} />
        </div>
      )}
      <div className="max-w-sm mx-auto space-y-3 text-center">
        <h3 className="text-lg font-bold font-outfit text-magi-primary">Who is taking the exam</h3>
        <p className="text-sm text-magi-secondary">Type your ID number, then hold your ID card next to your face and take the photo.</p>
        <div className="text-left">
          <label htmlFor="id-number" className="block text-sm font-medium text-magi-primary mb-1">
            ID number
          </label>
          <input id="id-number" value={idNumber} onChange={(e) => setIdNumber(e.target.value)} autoComplete="off" className={inputClass} />
        </div>
        {notReady && <p className="text-xs text-magi-destructive">The camera picture isn't ready yet, try again in a moment.</p>}
        {!screenChecked && (
          <p role="status" className="text-xs text-magi-secondary">
            Checking your screen… If your computer asks whether to allow screenshots, allow it.
          </p>
        )}
        <button type="button" disabled={id === "" || !ready || !screenChecked} onClick={start} className={`${primaryButtonClass} mx-auto`}>
          {camera.problem ? "Start without the photo" : ready ? "Take the photo and start the exam" : "Starting camera…"}
        </button>
        <p className="text-xs text-magi-secondary">The exam clock starts when you press the button.</p>
        <button type="button" onClick={onCancel} className="text-xs text-magi-secondary hover:text-magi-primary transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function PreExam({
  examName,
  withPhotos,
  onReady,
  onCancel,
}: {
  examName: string;
  /** false when an exam that is already running is picked up again: only the computer is checked */
  withPhotos: boolean;
  onReady: (checkIn: CheckIn) => void;
  onCancel: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [checked, setChecked] = useState(false);
  const passed = () => {
    if (withPhotos) setChecked(true);
    else onReady({ idNumber: "", photo: null, notes: [] });
  };

  return (
    <div className="space-y-4">
      <div className="pb-3 border-b border-magi-border">
        <h3 className="text-lg font-bold font-outfit text-magi-primary">{examName}</h3>
        <p className="text-xs text-magi-secondary mt-0.5">Before the exam starts</p>
      </div>
      {!acknowledged ? (
        <Warning onContinue={() => setAcknowledged(true)} onCancel={onCancel} />
      ) : checked ? (
        <Identity onReady={onReady} onCancel={onCancel} />
      ) : (
        <Environment onPassed={passed} onCancel={onCancel} />
      )}
    </div>
  );
}
