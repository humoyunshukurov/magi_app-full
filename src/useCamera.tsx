// The webcam: opens it, keeps it open while the screen that asked for it is shown, and can take a
// photo of what it sees. Used by the check before the exam and by the exam itself.

import { useEffect, useRef, useState } from "react";
import { cameraStart, cameraStop, onCameraFrame, onCameraLost } from "./ipc";

export type CameraEventKind = "camera_on" | "camera_off" | "camera_failed";
export type CameraSource = "app" | "webview";

const PHOTO_SIDE = 640;

export function useCamera(onEvent: (kind: CameraEventKind, detail: string) => void) {
  const video = useRef<HTMLVideoElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const report = useRef(onEvent);
  report.current = onEvent;
  // "app": the app reads the camera and sends frames (Linux). "webview": the page opens it.
  const [source, setSource] = useState<CameraSource | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let release: (() => void) | null = null;

    const failed = (reason: string) => {
      setProblem(reason);
      report.current("camera_failed", `The camera isn't available: ${reason}`);
    };

    const useAppCamera = async (name: string) => {
      setSource("app");
      const unlisten = await Promise.all([
        onCameraFrame((jpeg) => {
          if (image.current) image.current.src = `data:image/jpeg;base64,${jpeg}`;
        }),
        onCameraLost((reason) => failed(reason)),
      ]);
      release = () => {
        unlisten.forEach((fn) => fn());
        void cameraStop().catch(() => undefined);
      };
      if (stopped) return release();
      report.current("camera_on", `Camera on: ${name}`);
    };

    const useWebviewCamera = async () => {
      if (!navigator.mediaDevices?.getUserMedia) return failed("this computer can't give the app a camera");
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (err) {
        return failed(err instanceof DOMException ? err.name : String(err));
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      setSource("webview");
      if (video.current) video.current.srcObject = stream;
      release = () => stream.getTracks().forEach((t) => t.stop());
      const track = stream.getVideoTracks()[0];
      report.current("camera_on", track?.label ? `Camera on: ${track.label}` : "Camera on");
      track?.addEventListener("ended", () => failed("the camera stopped during the exam"));
    };

    (async () => {
      let name: string | null;
      try {
        name = await cameraStart();
      } catch (err) {
        return failed(String(err));
      }
      if (stopped) return name === null ? undefined : void cameraStop().catch(() => undefined);
      await (name === null ? useWebviewCamera() : useAppCamera(name));
    })();

    return () => {
      stopped = true;
      if (release) {
        release();
        report.current("camera_off", "Camera off");
      }
    };
  }, []);

  /** A photo of what the camera sees right now, as a JPEG data URL; null when there is no picture yet. */
  const grab = (): string | null => {
    const picture = source === "app" ? image.current : video.current;
    if (!picture) return null;
    const w = picture instanceof HTMLVideoElement ? picture.videoWidth : picture.naturalWidth;
    const h = picture instanceof HTMLVideoElement ? picture.videoHeight : picture.naturalHeight;
    if (!w || !h) return null;
    const scale = Math.min(1, PHOTO_SIDE / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext("2d")?.drawImage(picture, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8);
  };

  return { source, problem, video, image, grab };
}

/** The camera picture itself, mirrored like a mirror; put the refs from `useCamera` on it. */
export function CameraPicture({ camera, className = "" }: { camera: ReturnType<typeof useCamera>; className?: string }) {
  return camera.source === "app" ? (
    <img ref={camera.image} alt="Your camera" className={`w-full block -scale-x-100 ${className}`} />
  ) : (
    <video ref={camera.video} autoPlay muted playsInline aria-label="Your camera" className={`w-full block -scale-x-100 ${className}`} />
  );
}
