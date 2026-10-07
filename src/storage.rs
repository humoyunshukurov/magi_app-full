//! Uploads proctoring photos to the Supabase Storage bucket shared with the TS backend
//! (`proctoring`, public-read). The service-role key is the same style of credential the TS
//! backend already holds for direct DB access - this just uses it for the Storage REST API.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use crate::config::Config;
use crate::error::AppError;

const BUCKET: &str = "proctoring";
const MAX_BYTES: usize = 5 * 1024 * 1024;

/// Strips a `data:image/jpeg;base64,...` prefix if present, decodes the rest, and returns the
/// bytes with the mime type to upload as.
fn decode(data_url_or_base64: &str) -> Result<(Vec<u8>, &'static str), AppError> {
    let (mime, raw) = if let Some(rest) = data_url_or_base64.strip_prefix("data:image/png;base64,") {
        ("image/png", rest)
    } else if let Some(rest) = data_url_or_base64.strip_prefix("data:image/jpeg;base64,") {
        ("image/jpeg", rest)
    } else {
        ("image/jpeg", data_url_or_base64)
    };

    let bytes = STANDARD.decode(raw).map_err(|_| AppError::BadRequest("image must be valid base64".to_string()))?;
    if bytes.is_empty() {
        return Err(AppError::BadRequest("image is required".to_string()));
    }
    if bytes.len() > MAX_BYTES {
        return Err(AppError::BadRequest("image must be at most 5MB".to_string()));
    }
    Ok((bytes, mime))
}

/// Uploads one photo under `{attempt_id}/{kind}/{uuid}.{ext}` and returns its public URL.
pub async fn upload_photo(config: &Config, attempt_id: i64, kind: &str, image: &str) -> Result<String, AppError> {
    let (bytes, mime) = decode(image)?;
    let ext = if mime == "image/png" { "png" } else { "jpg" };
    let path = format!("{attempt_id}/{kind}/{}.{ext}", uuid_like());

    let client = reqwest::Client::new();
    let res = client
        .post(format!("{}/storage/v1/object/{BUCKET}/{path}", config.supabase_url))
        .bearer_auth(&config.supabase_service_key)
        .header("apikey", &config.supabase_service_key)
        .header("Content-Type", mime)
        .body(bytes)
        .send()
        .await
        .map_err(|err| AppError::Internal(anyhow::anyhow!("photo upload request failed: {err}")))?;

    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(AppError::Internal(anyhow::anyhow!("photo upload failed: {body}")));
    }

    Ok(format!("{}/storage/v1/object/public/{BUCKET}/{path}", config.supabase_url))
}

/// A good-enough unique filename component without pulling in the `uuid` crate for one call site.
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    let rand: u32 = rand::random();
    format!("{nanos:x}-{rand:x}")
}
