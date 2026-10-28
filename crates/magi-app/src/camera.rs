//! The camera for the exam window on Linux. WebKitGTK's own camera support hangs or crashes
//! its web process on this hardware, taking the whole window down with it, so the frames are
//! read here instead and sent to the page. The camera hands out ready-made JPEG frames, so
//! nothing is decoded on the way. (WebView2 and WKWebView use the camera themselves.)

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use v4l::buffer::Type;
use v4l::io::traits::CaptureStream;
use v4l::prelude::*;
use v4l::video::Capture;
use v4l::{Format, FourCC};

// Big enough for the phone check and for photos worth looking at later.
const WIDTH: u32 = 640;
const HEIGHT: u32 = 480;
/// The preview and the checks don't need more than about five frames a second.
const FRAME_GAP: Duration = Duration::from_millis(200);

pub struct Running {
    pub name: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Running {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn mjpeg() -> FourCC {
    FourCC::new(b"MJPG")
}

/// The first camera that can give JPEG frames.
fn open() -> Result<(Device, String), String> {
    let mut problem = "no camera found".to_string();
    for node in v4l::context::enum_devices() {
        let Ok(dev) = Device::with_path(node.path()) else {
            continue;
        };
        let Ok(caps) = dev.query_caps() else {
            continue;
        };
        if !caps
            .capabilities
            .contains(v4l::capability::Flags::VIDEO_CAPTURE)
        {
            continue;
        }
        let gives_jpeg = dev
            .enum_formats()
            .map(|formats| formats.iter().any(|f| f.fourcc == mjpeg()))
            .unwrap_or(false);
        if !gives_jpeg {
            problem = format!("{} can't give JPEG frames", caps.card);
            continue;
        }
        match dev.set_format(&Format::new(WIDTH, HEIGHT, mjpeg())) {
            Ok(actual) if actual.fourcc == mjpeg() => return Ok((dev, caps.card)),
            Ok(_) => problem = format!("{} wouldn't switch to JPEG", caps.card),
            Err(err) => problem = format!("{}: {err}", caps.card),
        }
    }
    Err(problem)
}

/// Opens the camera and calls `on_frame` with each JPEG frame until stopped. `on_lost` runs
/// if the camera stops delivering (unplugged, taken by another program).
pub fn start(
    on_frame: impl Fn(&[u8]) + Send + 'static,
    on_lost: impl FnOnce(String) + Send + 'static,
) -> Result<Running, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let (ready, opened) = mpsc::sync_channel(1);

    let flag = stop.clone();
    let thread = std::thread::spawn(move || {
        // the stream borrows the device, so both live on this thread
        let (dev, name) = match open() {
            Ok(found) => found,
            Err(err) => {
                let _ = ready.send(Err(err));
                return;
            }
        };
        let mut stream = match MmapStream::with_buffers(&dev, Type::VideoCapture, 4) {
            Ok(stream) => stream,
            Err(err) => {
                let _ = ready.send(Err(format!("{name}: {err}")));
                return;
            }
        };
        let _ = ready.send(Ok(name));

        let mut last = Instant::now() - FRAME_GAP;
        while !flag.load(Ordering::SeqCst) {
            match stream.next() {
                Ok((buf, meta)) => {
                    if last.elapsed() >= FRAME_GAP {
                        last = Instant::now();
                        on_frame(&buf[..(meta.bytesused as usize).min(buf.len())]);
                    }
                }
                Err(err) => {
                    if !flag.load(Ordering::SeqCst) {
                        on_lost(err.to_string());
                    }
                    return;
                }
            }
        }
    });

    match opened.recv() {
        Ok(Ok(name)) => Ok(Running {
            name,
            stop,
            thread: Some(thread),
        }),
        Ok(Err(err)) => {
            let _ = thread.join();
            Err(err)
        }
        Err(_) => Err("the camera stopped before it started".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Needs a real webcam, so it only runs when asked: `cargo test -p magi-app camera -- --ignored`
    #[test]
    #[ignore]
    fn delivers_jpeg_frames() {
        let frames = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let sink = frames.clone();
        let running = start(
            move |jpeg| sink.lock().unwrap().push(jpeg.to_vec()),
            |err| panic!("{err}"),
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        println!("camera: {}", running.name);
        running.stop();

        let frames = frames.lock().unwrap();
        assert!(frames.len() >= 5, "only {} frames", frames.len());
        assert!(frames
            .iter()
            .all(|f| f.starts_with(&[0xFF, 0xD8]) && f.ends_with(&[0xFF, 0xD9])));
        if let Ok(path) = std::env::var("CAMERA_TEST_OUT") {
            std::fs::write(path, frames.last().unwrap()).unwrap();
        }
    }
}
