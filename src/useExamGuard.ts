// What the exam keeps an eye on and holds back while it is open: copying and pasting, the
// developer tools, leaving the window, extra screens, forbidden apps and browsers, and the
// permitted links. Everything that matters is written to the Activity log.

import { useCallback, useEffect, useRef } from "react";
import type { ActivityKind } from "./activity";
import { appQuit, environmentCheck, examLock, linkClose, linkOpen, onCloseAttempt, onLinkBlocked, onLinkClosed, onLinkFocus, onWindowFocusChanged, screenshotTake } from "./ipc";

export type GuardLog = (kind: ActivityKind, detail: string, extra?: { questionId?: number; data?: Record<string, unknown> }) => void;

export const POLL_MS = 5000;
/** Moving between the exam window and a permitted link's window isn't leaving; it may take this long. */
export const LINK_GRACE_MS = 400;
/** After the student leaves, the other app needs a moment to come to the front before the screen is taken. */
export const SHOT_DELAY_MS = 500;
/** Screenshots are kept on this computer, so there is a cap per exam, and no burst of them. */
export const SHOT_LIMIT = 10;
export const SHOT_GAP_MS = 5000;
/** How long the exam waits to write down a try to close the app before it lets it close. */
export const QUIT_DELAY_MS = 300;

function developerToolsKey(e: KeyboardEvent): string | null {
  const key = e.key.toLowerCase();
  if (e.key === "F12") return "F12";
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && ["i", "j", "c", "k"].includes(key)) return `${e.metaKey ? "Cmd" : "Ctrl"}+Shift+${key.toUpperCase()}`;
  if (e.metaKey && e.altKey && ["i", "j", "c"].includes(key)) return `Cmd+Alt+${key.toUpperCase()}`;
  if ((e.ctrlKey || e.metaKey) && key === "u") return `${e.metaKey ? "Cmd" : "Ctrl"}+U`;
  return null;
}

const names = (list: string[]) => list.join(", ");

export function useExamGuard({
  enabled,
  log,
  where,
  questionId,
  permittedUrls,
  onLeave,
}: {
  enabled: boolean;
  log: GuardLog;
  /** Where the student is, for the log: "question 2 (essay)". */
  where: () => string;
  questionId: () => number | undefined;
  permittedUrls: string[];
  /** Called the moment the student actually leaves (not for a permitted link) - ends the exam. */
  onLeave: () => void;
}) {
  const latest = useRef({ log, where, questionId, permittedUrls, onLeave });
  latest.current = { log, where, questionId, permittedUrls, onLeave };
  // shared between the focus watching below and openLink
  const focus = useRef({ main: true, link: false, linkFocused: false, leftAt: null as number | null, linkOpenedAt: null as number | null });
  const settleFocus = useRef<() => void>(() => undefined);
  const shots = useRef({ count: 0, lastAt: 0 });

  /** Writes down a picture of the screen; `force` skips the cap and the gap (when the app is being closed). */
  const shoot = useRef(async (detail: string, reason: string, delayMs: number, force = false) => {
    const s = shots.current;
    const now = Date.now();
    if (!force && (s.count >= SHOT_LIMIT || now - s.lastAt < SHOT_GAP_MS)) return;
    s.count += 1;
    s.lastAt = now;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const jpeg = await screenshotTake();
      latest.current.log("screenshot", detail, { questionId: latest.current.questionId(), data: { image: `data:image/jpeg;base64,${jpeg}`, reason } });
    } catch (err) {
      latest.current.log("screenshot_failed", `Couldn't take a screenshot: ${String(err)}`, { data: { reason } });
    }
  });

  // Copying and pasting inside the exam is fine; text that comes from outside it is held back, as
  // are the developer tools, and each try is written down.
  useEffect(() => {
    if (!enabled) return;
    const note = (kind: ActivityKind, detail: string, data?: Record<string, unknown>) =>
      latest.current.log(kind, detail, { questionId: latest.current.questionId(), data });
    const plain = (text: string) => text.replace(/\r\n/g, "\n");
    const selected = () => {
      const el = document.activeElement;
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return plain(el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0));
      return plain(window.getSelection()?.toString() ?? "");
    };
    // the last text that was copied, cut or dragged inside the exam
    let inside = "";

    const remember = () => {
      inside = selected();
    };
    const onPaste = (e: ClipboardEvent) => {
      const text = plain(e.clipboardData?.getData("text") ?? "");
      if (text === "" || text === inside) return;
      e.preventDefault();
      note("paste", `Tried to paste ${text.length} characters from outside the exam into ${latest.current.where()} (blocked)`, { chars: text.length });
    };
    const onDrop = (e: DragEvent) => {
      const text = plain(e.dataTransfer?.getData("text") ?? "");
      if (text !== "" && text === inside) return;
      e.preventDefault();
      if (text.length > 0) note("paste", `Tried to drop ${text.length} characters from outside the exam into ${latest.current.where()} (blocked)`, { chars: text.length });
    };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    const onKeyDown = (e: KeyboardEvent) => {
      const combo = developerToolsKey(e);
      if (!combo) return;
      e.preventDefault();
      note("devtools_attempt", `Tried to open the developer tools (${combo}) (blocked)`);
    };

    document.addEventListener("paste", onPaste);
    document.addEventListener("copy", remember);
    document.addEventListener("cut", remember);
    document.addEventListener("dragstart", remember);
    document.addEventListener("drop", onDrop);
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("copy", remember);
      document.removeEventListener("cut", remember);
      document.removeEventListener("dragstart", remember);
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled]);

  // Leaving the exam window. A permitted link is a window of its own, and looking at it isn't leaving.
  useEffect(() => {
    if (!enabled) return;
    const f = focus.current;
    f.main = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const note = (kind: ActivityKind, detail: string, data?: Record<string, unknown>) =>
      latest.current.log(kind, detail, { questionId: latest.current.questionId(), data });

    const evaluate = () => {
      const away = !f.main && !(f.link && f.linkFocused);
      if (away && f.leftAt === null) {
        f.leftAt = Date.now();
        note("window_left", `Left the exam window while on ${latest.current.where()}`);
        void shoot.current("Screenshot after leaving the exam window", "window_left", SHOT_DELAY_MS);
        latest.current.onLeave();
      } else if (!away && f.leftAt !== null) {
        const seconds = Math.round((Date.now() - f.leftAt) / 1000);
        f.leftAt = null;
        note("window_returned", `Came back to the exam window after ${seconds} s`, { away_seconds: seconds });
      }
    };
    const settle = () => {
      clearTimeout(timer);
      if (f.link) timer = setTimeout(evaluate, LINK_GRACE_MS);
      else evaluate();
    };
    settleFocus.current = settle;

    const listening = Promise.all([
      // The native window-focus event, not the webview's own `window.blur`/`focus` DOM events -
      // those don't reliably reach the page on every platform (seen on this very app on Linux).
      onWindowFocusChanged((focused) => {
        f.main = focused;
        settle();
      }),
      onLinkFocus((focused) => {
        f.linkFocused = focused;
        settle();
      }),
      onLinkClosed(() => {
        if (!f.link) return;
        const seconds = f.linkOpenedAt === null ? 0 : Math.round((Date.now() - f.linkOpenedAt) / 1000);
        f.link = false;
        f.linkFocused = false;
        f.linkOpenedAt = null;
        note("link_closed", `Closed the permitted link after ${seconds} s`, { seconds });
        settle();
      }),
      onLinkBlocked((url) => note("link_blocked", `The permitted link tried to go to ${url} (blocked)`, { url })),
      // closing the app during the exam is written down, with a picture of the screen, and then allowed
      onCloseAttempt(() => {
        note("app_closed", "Tried to close the app during the exam");
        void shoot.current("Screenshot when the app was closed", "app_closed", 0, true).finally(() => {
          setTimeout(() => void appQuit().catch(() => undefined), QUIT_DELAY_MS);
        });
      }),
    ]).catch(() => undefined);

    return () => {
      clearTimeout(timer);
      void listening.then((unlisten) => unlisten?.forEach((fn) => fn()));
      f.link = false;
      f.linkFocused = false;
      f.leftAt = null;
      void linkClose().catch(() => undefined);
    };
  }, [enabled]);

  // Screens and apps are read when the exam opens and again every few seconds.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let before: Awaited<ReturnType<typeof environmentCheck>> | null = null;
    const note = (kind: ActivityKind, detail: string, data?: Record<string, unknown>) =>
      latest.current.log(kind, detail, { data });

    const poll = async () => {
      try {
        const now = await environmentCheck();
        if (cancelled) return;
        if (before === null) {
          if (now.monitor_count > 1 && !now.extra_screens_allowed) note("monitor_added", `More than one screen is connected (${now.monitor_count})`, { monitors: now.monitor_count });
          for (const app of now.forbidden_apps) note("app_detected", `A forbidden app is running: ${app}`, { app });
        } else {
          if (now.monitor_count > before.monitor_count) {
            note("monitor_added", `A screen was connected during the exam (${now.monitor_count} now)`, { monitors: now.monitor_count });
          } else if (now.monitor_count < before.monitor_count) {
            note("monitor_removed", `A screen was disconnected (${now.monitor_count} now)`, { monitors: now.monitor_count });
          }
          for (const app of now.forbidden_apps.filter((a) => !before!.forbidden_apps.includes(a))) {
            note("app_detected", `A forbidden app was started: ${app}`, { app });
          }
          const opened = now.browsers.filter((b) => !before!.browsers.includes(b));
          if (opened.length > 0) note("app_detected", `A browser was opened: ${names(opened)}`, { browsers: opened });
        }
        before = now;
      } catch {
        // outside the app there is nothing to read
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled]);

  // Full screen for as long as the exam is open.
  useEffect(() => {
    if (!enabled) return;
    examLock(true).catch(() => undefined);
    return () => {
      examLock(false).catch(() => undefined);
    };
  }, [enabled]);

  /** Opens one of the permitted links in its own window. */
  const openLink = useCallback((url: string) => {
    const f = focus.current;
    f.link = true;
    f.linkOpenedAt ??= Date.now();
    linkOpen(url, latest.current.permittedUrls).then(
      () => latest.current.log("link_opened", `Opened the permitted link ${url}`, { questionId: latest.current.questionId(), data: { url } }),
      () => {
        f.link = false;
        f.linkOpenedAt = null;
        settleFocus.current();
      },
    );
  }, []);

  return { openLink };
}
