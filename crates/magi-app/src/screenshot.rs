//! A picture of the student's screen, taken when they leave the exam window so the log shows
//! what they went to. Windows and macOS are captured directly; on Linux the desktop's own
//! screenshot portal is asked (Wayland doesn't allow anything else), which may ask the student
//! for permission the first time.

use std::io::Cursor;

use base64::Engine;
use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, ExtendedColorType, RgbaImage,
};

const MAX_WIDTH: u32 = 960;
const QUALITY: u8 = 60;

/// Scaled down to a size that is still readable, as a JPEG.
fn to_jpeg(picture: RgbaImage) -> Result<Vec<u8>, String> {
    let picture = DynamicImage::ImageRgba8(picture);
    let picture = if picture.width() > MAX_WIDTH {
        picture.resize(MAX_WIDTH, u32::MAX, FilterType::Triangle)
    } else {
        picture
    };
    let rgb = picture.to_rgb8();
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(Cursor::new(&mut jpeg), QUALITY)
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            ExtendedColorType::Rgb8,
        )
        .map_err(|e| e.to_string())?;
    Ok(jpeg)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn capture() -> Result<RgbaImage, String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let screen = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or(monitors.first())
        .ok_or("no screen found")?;
    screen.capture_image().map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn capture() -> Result<RgbaImage, String> {
    /// The first time, the desktop asks the student to allow it, so give them a while.
    const WAIT: std::time::Duration = std::time::Duration::from_secs(25);

    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(portal_screenshot());
    });
    let file = receiver
        .recv_timeout(WAIT)
        .map_err(|_| "the screenshot wasn't allowed in time".to_string())??;

    let bytes = std::fs::read(&file).map_err(|e| e.to_string());
    // the portal leaves its picture in the student's Pictures folder
    let _ = std::fs::remove_file(&file);
    image::load_from_memory(&bytes?)
        .map(|picture| picture.to_rgba8())
        .map_err(|e| e.to_string())
}

/// Asks the desktop's screenshot portal for a picture without a dialog of its own; returns
/// the file it wrote.
#[cfg(target_os = "linux")]
fn portal_screenshot() -> Result<std::path::PathBuf, String> {
    use std::collections::HashMap;
    use zbus::blocking::{Connection, MessageIterator, Proxy};
    use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

    let err = |e: zbus::Error| e.to_string();
    let connection = Connection::session().map_err(err)?;

    // The answer arrives as a signal on a request path we can work out beforehand, so listen first.
    let token = format!("magi_{}", uuid::Uuid::new_v4().simple());
    let sender = connection
        .unique_name()
        .ok_or("no D-Bus name")?
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let request = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface("org.freedesktop.portal.Request")
        .map_err(err)?
        .member("Response")
        .map_err(err)?
        .path(request.as_str())
        .map_err(err)?
        .build();
    let mut answers = MessageIterator::for_match_rule(rule, &connection, Some(4)).map_err(err)?;

    let portal = Proxy::new(
        &connection,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Screenshot",
    )
    .map_err(err)?;
    let mut options: HashMap<&str, Value> = HashMap::new();
    options.insert("handle_token", Value::from(token.as_str()));
    options.insert("interactive", Value::from(false));
    options.insert("modal", Value::from(false));
    let _: OwnedObjectPath = portal.call("Screenshot", &("", options)).map_err(err)?;

    let answer = answers
        .next()
        .ok_or("no answer from the screenshot portal")?
        .map_err(err)?;
    let (code, results): (u32, HashMap<String, OwnedValue>) =
        answer.body().deserialize().map_err(err)?;
    if code != 0 {
        return Err("the screenshot wasn't allowed".to_string());
    }
    let uri = results
        .get("uri")
        .ok_or("no picture came back")?
        .try_clone()
        .map_err(|e| e.to_string())?;
    let uri = String::try_from(uri).map_err(|e| e.to_string())?;
    url::Url::parse(&uri)
        .ok()
        .and_then(|u| u.to_file_path().ok())
        .ok_or_else(|| "the picture is somewhere unexpected".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn capture() -> Result<RgbaImage, String> {
    Err("screenshots aren't supported on this system".to_string())
}

/// A picture of the screen, as a base64 JPEG.
pub fn take() -> Result<String, String> {
    let jpeg = to_jpeg(capture()?)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(jpeg))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255])
        })
    }

    fn decoded(jpeg: &[u8]) -> DynamicImage {
        image::load_from_memory(jpeg).expect("a JPEG the image crate can read")
    }

    #[test]
    fn scales_a_big_screen_down_and_keeps_its_shape() {
        let jpeg = to_jpeg(gradient(3840, 2160)).unwrap();
        assert!(jpeg.starts_with(&[0xFF, 0xD8]) && jpeg.ends_with(&[0xFF, 0xD9]));
        let picture = decoded(&jpeg);
        assert_eq!((picture.width(), picture.height()), (960, 540));
    }

    #[test]
    fn leaves_a_small_screen_as_it_is() {
        let picture = decoded(&to_jpeg(gradient(800, 600)).unwrap());
        assert_eq!((picture.width(), picture.height()), (800, 600));
    }

    #[test]
    fn keeps_what_is_on_the_screen() {
        // a screen that is half white and half black must still be that after the trip
        let half = RgbaImage::from_fn(1920, 1080, |x, _| {
            if x < 960 {
                image::Rgba([255, 255, 255, 255])
            } else {
                image::Rgba([0, 0, 0, 255])
            }
        });
        let picture = decoded(&to_jpeg(half).unwrap()).to_rgb8();
        assert!(picture.get_pixel(100, 100)[0] > 240);
        assert!(picture.get_pixel(860, 100)[0] < 15);
    }
}
