import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ping, launchPayloadSchema, LAUNCH_EVENT } from "./ipc";

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
    <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-8">
      <div className="w-full max-w-lg space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">MAGI Desktop</h1>
          <p className="text-sm text-slate-400">M0 scaffold · IPC + deep-link smoke test</p>
        </header>

        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-slate-400">
            IPC: ping
          </h2>
          {error ? (
            <p className="mt-2 font-mono text-sm text-red-400">error: {error}</p>
          ) : pong ? (
            <p className="mt-2 font-mono text-sm text-emerald-400">
              {pong} <span className="text-slate-500">(core {coreVersion})</span>
            </p>
          ) : (
            <p className="mt-2 font-mono text-sm text-slate-500">calling…</p>
          )}
        </section>

        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Deep link: {LAUNCH_EVENT}
          </h2>
          {lastToken ? (
            <p className="mt-2 font-mono text-sm text-indigo-300">token: {lastToken}</p>
          ) : (
            <p className="mt-2 text-sm text-slate-500">
              Waiting for a <code className="text-slate-400">magi://launch?token=…</code> deep
              link. Try{" "}
              <code className="text-slate-400">open &apos;magi://launch?token=stub&apos;</code>.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
