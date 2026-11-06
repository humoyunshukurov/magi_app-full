// What happens between pressing Start and the exam opening: the computer is checked (one screen,
// no remote control or screen sharing apps), then the student types their ID number and the
// camera takes one photo of them with their ID card. The exam clock only starts after this.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18next from "./i18n";
import { checkIdentity, getMyIdNumber } from "./api";
import { loadDetector } from "./cameraWatch";
import type { EnvironmentReport } from "./generated/EnvironmentReport";
import { environmentCheck, screenshotTake } from "./ipc";
import { inputClass, primaryButtonClass } from "./ui";
import { CameraPicture, useCamera } from "./useCamera";
import { isUpdating } from "./updateState";

// mirrors environment.rs's FORBIDDEN_PREFIXES/FORBIDDEN_EXACT - what each one actually does,
// so the student knows why it blocks the exam instead of just that it does
const APP_REASON_KEYS: Record<string, string> = {
  teamviewer: "preExam.appReasons.remoteControl",
  anydesk: "preExam.appReasons.remoteControl",
  rustdesk: "preExam.appReasons.remoteControl",
  ultraviewer: "preExam.appReasons.remoteControl",
  remoting_host: "preExam.appReasons.remoteControl",
  x11vnc: "preExam.appReasons.remoteControl",
  vncviewer: "preExam.appReasons.remoteControl",
  vncserver: "preExam.appReasons.remoteControl",
  tigervnc: "preExam.appReasons.remoteControl",
  zoom: "preExam.appReasons.screenShare",
  simplescreen: "preExam.appReasons.screenRecord",
  vokoscreen: "preExam.appReasons.screenRecord",
  kazam: "preExam.appReasons.screenRecord",
  obs: "preExam.appReasons.screenRecord",
  obs64: "preExam.appReasons.screenRecord",
  "obs-studio": "preExam.appReasons.screenRecord",
  peek: "preExam.appReasons.screenRecord",
  camtasia: "preExam.appReasons.screenRecord",
  bandicam: "preExam.appReasons.screenRecord",
};

export interface CheckIn {
  /** Empty when an exam that was already running is picked up again. */
  idNumber: string;
  /** The photo of the student with their ID card; null without a camera. */
  photo: string | null;
  /** Things worth writing in the log that happened during the check-in. */
  notes: Array<{ kind: "camera_failed" | "screenshot_failed" | "identity_check_failed"; detail: string }>;
}

export const RECHECK_MS = 3000;

const secondaryButtonClass =
  "py-2.5 px-4 rounded-lg border border-magi-border text-sm font-semibold text-magi-primary hover:bg-magi-surface transition-colors";

function problemsOf(report: EnvironmentReport): string[] {
  const problems: string[] = [];
  if (report.monitor_count > 1 && !report.extra_screens_allowed) {
    problems.push(i18next.t("preExam.problems.extraScreens", { count: report.monitor_count }));
  }
  for (const app of report.forbidden_apps) {
    const reason = i18next.t(APP_REASON_KEYS[app] ?? "preExam.appReasons.other");
    problems.push(i18next.t("preExam.problems.forbiddenApp", { app, reason }));
  }
  if (report.other_windows.length > 0 && !report.other_windows_allowed) {
    problems.push(i18next.t("preExam.problems.otherWindows", { windows: report.other_windows.join(", ") }));
  }
  if (isUpdating()) problems.push(i18next.t("preExam.problems.updating"));
  return problems;
}

function Warning({ onContinue, onCancel }: { onContinue: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alertdialog" aria-label={t("preExam.beforeYouStart")} className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg bg-magi-white shadow-xl p-5 space-y-4">
        <div>
          <p className="text-sm font-bold text-magi-primary">{t("preExam.beforeYouStart")}</p>
          <p className="text-sm text-magi-secondary mt-2">{t("preExam.warningCopy")}</p>
        </div>
        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={onCancel} className={`${secondaryButtonClass} flex-1`}>
            {t("preExam.cancel")}
          </button>
          <button type="button" onClick={onContinue} className={`${primaryButtonClass} flex-1 justify-center`}>
            {t("preExam.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Environment({ onPassed, onCancel }: { onPassed: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
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
    return <p className="text-center text-sm text-magi-secondary font-light py-10">{t("preExam.checkingComputer")}</p>;
  }
  return (
    <div className="space-y-4">
      <div role="alert" className="p-4 rounded-lg bg-red-50 border border-red-200">
        <p className="text-sm font-bold text-magi-destructive">{t("preExam.cantStartYet")}</p>
        <ul className="mt-1 text-sm text-magi-destructive list-disc pl-5">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-magi-secondary">{t("preExam.rechecksAutomatically")}</p>
      <button type="button" onClick={onCancel} className={secondaryButtonClass}>
        {t("preExam.cancel")}
      </button>
    </div>
  );
}

function Identity({ token, onReady, onCancel }: { token: string; onReady: (checkIn: CheckIn) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const notes = useRef<CheckIn["notes"]>([]);
  const camera = useCamera((kind, detail) => {
    if (kind === "camera_failed") notes.current.push({ kind, detail });
  });
  const [idNumber, setIdNumber] = useState("");
  const [notReady, setNotReady] = useState(false);
  const [screenChecked, setScreenChecked] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [noFace, setNoFace] = useState(false);
  const [idMismatch, setIdMismatch] = useState(false);
  const detector = useRef<Awaited<ReturnType<typeof loadDetector>> | null>(null);
  // undefined: not loaded yet. null: loaded, but this account has no ID number assigned - the
  // check below is skipped rather than locking out an account from before this existed.
  const realIdNumber = useRef<string | null | undefined>(undefined);
  // the Start button used to only gate on the camera/screen checks, so typing fast enough could
  // press it before this fetch resolved - realIdNumber.current was still undefined (falsy), and
  // any ID number typed in sailed right through the check below unmatched
  const [idNumberLoaded, setIdNumberLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMyIdNumber(token).then(
      (value) => {
        if (!cancelled) realIdNumber.current = value;
      },
      () => {
        if (!cancelled) realIdNumber.current = null;
      },
    ).finally(() => {
      if (!cancelled) setIdNumberLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

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

  // Loaded ahead of time so it's ready the moment the photo is taken, same model the exam's own
  // camera watch uses - a face check this cheap shouldn't need a server round trip.
  useEffect(() => {
    let cancelled = false;
    loadDetector().then(
      (loaded) => (cancelled ? loaded.close() : void (detector.current = loaded)),
      () => undefined, // best-effort: a model that fails to load just skips the face check below
    );
    return () => {
      cancelled = true;
      detector.current?.close();
      detector.current = null;
    };
  }, []);

  const id = idNumber.trim();
  // The reference photo check only runs when a photo was actually captured - no camera means
  // nothing to compare, and that path already proceeds (and is logged) on its own above.
  const start = async () => {
    setIdMismatch(false);
    if (realIdNumber.current && id.toLowerCase() !== realIdNumber.current.trim().toLowerCase()) {
      setIdMismatch(true);
      return;
    }

    if (camera.problem) return onReady({ idNumber: id, photo: null, notes: notes.current });
    const photo = camera.grab();
    setNotReady(photo === null);
    if (!photo) return;

    setNoFace(false);
    setMismatch(false);

    if (detector.current && detector.current.look(photo.canvas, { phone: false }).faces === 0) {
      setNoFace(true);
      return;
    }

    setVerifying(true);
    let matched = true;
    try {
      const check = await checkIdentity(token, photo.dataUrl);
      matched = !check.hasReference || check.matched;
    } catch (err) {
      // a broken check must not lock a student out of an exam they're entitled to take - let
      // them in, but note it so staff can see the identity check never actually ran
      notes.current.push({ kind: "identity_check_failed", detail: `Could not verify your photo: ${String(err)}` });
    }
    setVerifying(false);

    if (!matched) return setMismatch(true);
    onReady({ idNumber: id, photo: photo.dataUrl, notes: notes.current });
  };
  const ready = camera.problem !== null || camera.source !== null;

  return (
    <div className="space-y-4">
      {camera.problem ? (
        <div role="alert" className="p-4 rounded-lg bg-red-50 border border-red-200">
          <p className="text-sm font-bold text-magi-destructive">{t("preExam.cameraUnavailable")}</p>
          <p className="text-sm text-magi-destructive mt-1">{t("preExam.cameraUnavailableDetail", { reason: camera.problem })}</p>
        </div>
      ) : (
        <div className="max-w-sm mx-auto rounded-lg overflow-hidden border border-magi-border bg-black">
          <CameraPicture camera={camera} />
        </div>
      )}
      <div className="max-w-sm mx-auto space-y-3 text-center">
        <h3 className="text-lg font-bold font-outfit text-magi-primary">{t("preExam.whoIsTaking")}</h3>
        <p className="text-sm text-magi-secondary">{t("preExam.typeIdAndPhoto")}</p>
        <div className="text-left">
          <label htmlFor="id-number" className="block text-sm font-medium text-magi-primary mb-1">
            {t("preExam.idNumber")}
          </label>
          <input id="id-number" value={idNumber} onChange={(e) => setIdNumber(e.target.value)} autoComplete="off" className={inputClass} />
        </div>
        {notReady && <p className="text-xs text-magi-destructive">{t("preExam.pictureNotReady")}</p>}
        {idMismatch && (
          <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-left">
            <p className="text-sm font-bold text-magi-destructive">{t("preExam.idMismatchTitle")}</p>
            <p className="text-xs text-magi-destructive mt-1">{t("preExam.idMismatchDetail")}</p>
          </div>
        )}
        {noFace && (
          <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-left">
            <p className="text-sm font-bold text-magi-destructive">{t("preExam.noFaceTitle")}</p>
            <p className="text-xs text-magi-destructive mt-1">{t("preExam.noFaceDetail")}</p>
          </div>
        )}
        {mismatch && (
          <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-left">
            <p className="text-sm font-bold text-magi-destructive">{t("preExam.mismatchTitle")}</p>
            <p className="text-xs text-magi-destructive mt-1">{t("preExam.mismatchDetail")}</p>
          </div>
        )}
        {!screenChecked && (
          <p role="status" className="text-xs text-magi-secondary">
            {t("preExam.checkingScreen")}
          </p>
        )}
        <button type="button" disabled={id === "" || !ready || !screenChecked || !idNumberLoaded || verifying} onClick={() => void start()} className={`${primaryButtonClass} mx-auto`}>
          {camera.problem ? t("preExam.startWithoutPhoto") : verifying ? t("preExam.verifying") : ready ? t("preExam.takePhotoAndStart") : t("preExam.startingCamera")}
        </button>
        <p className="text-xs text-magi-secondary">{t("preExam.clockStarts")}</p>
        <button type="button" onClick={onCancel} className="text-xs text-magi-secondary hover:text-magi-primary transition-colors">
          {t("preExam.cancel")}
        </button>
      </div>
    </div>
  );
}

export function PreExam({
  examName,
  withPhotos,
  token,
  onReady,
  onCancel,
}: {
  examName: string;
  /** false when an exam that is already running is picked up again: only the computer is checked */
  withPhotos: boolean;
  token: string;
  onReady: (checkIn: CheckIn) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
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
        <p className="text-xs text-magi-secondary mt-0.5">{t("preExam.beforeExamStarts")}</p>
      </div>
      {!acknowledged ? (
        <Warning onContinue={() => setAcknowledged(true)} onCancel={onCancel} />
      ) : checked ? (
        <Identity token={token} onReady={onReady} onCancel={onCancel} />
      ) : (
        <Environment onPassed={passed} onCancel={onCancel} />
      )}
    </div>
  );
}
