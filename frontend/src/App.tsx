import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { setUpdating } from "./updateState";
import { AuthPanel } from "./AuthPanel";
import { LOCALE_KEY } from "./i18n";

const LANGUAGES = [
  { code: "en", label: "EN" },
  { code: "uz", label: "UZ" },
] as const;

function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const setLanguage = (code: "en" | "uz") => {
    void i18n.changeLanguage(code);
    localStorage.setItem(LOCALE_KEY, code);
  };
  return (
    <div className="flex items-center gap-0.5 p-[3px] rounded-[10px] border border-magi-border">
      {LANGUAGES.map(({ code, label }) => (
        <button
          key={code}
          type="button"
          onClick={() => setLanguage(code)}
          aria-pressed={i18n.language === code}
          className={`px-3 py-1.5 rounded-[7px] text-xs font-bold transition-colors ${
            i18n.language === code ? "bg-magi-primary text-white" : "text-magi-muted hover:text-magi-primary"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function UpdateScreen({ update }: { update: Update }) {
  const { t } = useTranslation();
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  // windows quits by itself after installing, mac/linux need relaunch()
  const install = async () => {
    setInstalling(true);
    setFailed(false);
    setUpdating(true);
    let total = 0;
    let done = 0;
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress" && total) {
          done += e.data.chunkLength;
          setProgress(Math.min(100, Math.round((done / total) * 100)));
        }
      });
      await relaunch();
    } catch (e) {
      console.error("update failed:", e);
      setUpdating(false);
      setInstalling(false);
      setProgress(null);
      setFailed(true);
    }
  };

  return (
    <div className="min-h-screen bg-magi-white text-magi-primary flex items-center justify-center px-6">
      <div className="glass-card max-w-sm w-full text-center space-y-4 p-8">
        <p className="font-outfit font-extrabold text-lg tracking-tight">{t("app.title")}</p>
        <h1 className="text-xl font-bold font-outfit">{t("update.title")}</h1>
        <p className="text-sm text-magi-secondary">{t("update.body", { version: update.version })}</p>
        <button
          type="button"
          onClick={() => void install()}
          disabled={installing}
          className="w-full py-3 rounded-[10px] bg-magi-primary text-white font-bold hover:bg-magi-hover transition-colors disabled:opacity-60"
        >
          {installing ? (progress === null ? t("update.installing") : t("update.progress", { progress })) : t("update.button")}
        </button>
        {failed && (
          <p role="alert" className="text-sm text-magi-destructive">
            {t("update.failed")}
          </p>
        )}
      </div>
    </div>
  );
}

export function App() {
  const { t } = useTranslation();
  const [examRunning, setExamRunning] = useState(false);
  // undefined while checking, null when up to date
  const [update, setUpdate] = useState<Update | null | undefined>(undefined);
  const [version, setVersion] = useState("");

  // ADR-0008: check once per launch. a newer version blocks everything, even sign in
  useEffect(() => {
    getVersion().then(setVersion).catch(() => undefined);
    check({ timeout: 15000 })
      .then((found) => setUpdate(found))
      .catch((e) => {
        console.error("update check failed:", e);
        setUpdate(null);
      });
  }, []);

  if (update === undefined) {
    return (
      <div className="min-h-screen bg-magi-white flex items-center justify-center">
        <p className="text-sm text-magi-secondary font-light">{t("update.checking")}</p>
      </div>
    );
  }
  if (update) return <UpdateScreen update={update} />;

  return (
    <div className="min-h-screen bg-magi-white text-magi-primary flex flex-col">
      {/* no header/footer during an exam */}
      <header hidden={examRunning} className="sticky top-0 z-50 bg-magi-white border-b border-magi-border">
        <div className="max-w-5xl mx-auto px-6 h-[84px] flex items-center justify-between">
          <span className="font-outfit font-extrabold text-[22px] tracking-tight">{t("app.title")}</span>
          <LanguageSwitcher />
        </div>
      </header>

      <div className="flex flex-grow">
        <main className={`flex-grow min-w-0 w-full ${examRunning ? "px-4 py-4" : "max-w-5xl mx-auto px-6 py-12"}`}>
          <AuthPanel onExamRunning={setExamRunning} />
        </main>
      </div>

      <footer hidden={examRunning} className="bg-magi-white border-t border-magi-border py-6">
        <p className="text-center text-xs text-magi-muted">{t("app.footer", { year: new Date().getFullYear() })}
          {version && ` · v${version}`}
        </p>
      </footer>
    </div>
  );
}
