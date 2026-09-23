import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ping, launchPayloadSchema, LAUNCH_EVENT } from "./ipc";
import { AuthPanel } from "./AuthPanel";

export function App() {
  const [pong, setPong] = useState<string | null>(null);
  const [coreVersion, setCoreVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastToken, setLastToken] = useState<string | null>(null);

  // Demo IPC: call `ping` once on mount.
  useEffect(() => {
    ping()
      .then((res) => {
        setPong(res.message);
        setCoreVersion(res.core_version);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  // Subscribe to launch hand-offs. M0 only observes the token (claiming is M3).
  useEffect(() => {
    const unlisten = listen(LAUNCH_EVENT, (event) => {
      const parsed = launchPayloadSchema.safeParse(event.payload);
      if (parsed.success) {
        // eslint-disable-next-line no-console
        console.log("launch token received:", parsed.data.token);
        setLastToken(parsed.data.token);
      } else {
        console.error("invalid launch payload", parsed.error);
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="min-h-screen bg-magi-white text-magi-primary flex flex-col">
      <header className="sticky top-0 z-50 bg-magi-white border-b border-magi-border">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center">
          <span className="font-outfit font-extrabold text-lg tracking-tight">MAGI Desktop</span>
        </div>
      </header>

      <main className="flex-grow max-w-5xl w-full mx-auto px-6 py-10 space-y-8">
        <AuthPanel />

        <details className="glass-card p-4 max-w-3xl mx-auto text-xs">
          <summary className="cursor-pointer font-semibold text-magi-secondary uppercase tracking-wide">
            Diagnostics: IPC + deep link
          </summary>
          <div className="mt-3 space-y-3">
            <div>
              <h3 className="font-medium text-magi-secondary">IPC: ping</h3>
              {error ? (
                <p className="mt-1 font-mono text-magi-destructive">error: {error}</p>
              ) : pong ? (
                <p className="mt-1 font-mono text-magi-success">
                  {pong} <span className="text-magi-secondary">(core {coreVersion})</span>
                </p>
              ) : (
                <p className="mt-1 font-mono text-magi-secondary">calling…</p>
              )}
            </div>
            <div>
              <h3 className="font-medium text-magi-secondary">Deep link: {LAUNCH_EVENT}</h3>
              {lastToken ? (
                <p className="mt-1 font-mono text-magi-primary">token: {lastToken}</p>
              ) : (
                <p className="mt-1 text-magi-secondary">
                  Waiting for a <code>magi://launch?token=…</code> deep link. Try{" "}
                  <code>open &apos;magi://launch?token=stub&apos;</code>.
                </p>
              )}
            </div>
          </div>
        </details>
      </main>

      <footer className="bg-magi-white border-t border-magi-border py-6">
        <p className="text-center text-xs text-magi-secondary font-light">&copy; {new Date().getFullYear()} MAGI</p>
      </footer>
    </div>
  );
}
