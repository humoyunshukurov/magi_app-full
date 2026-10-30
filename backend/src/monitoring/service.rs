//! Ports the student-write half of `features/monitoring/monitoring.service.ts`.

use sqlx::PgPool;

use crate::access::{self, Timed};
use crate::config::Config;
use crate::error::AppError;
use crate::monitoring::models::MediaRecord;
use crate::storage;

const MAX_LABEL: usize = 200;

/// The four media kinds, each with its own table and the join table carrying the attempt.
#[derive(Debug, Clone, Copy)]
pub enum MediaKind {
    PanoramicViews,
    VideoRecordings,
    FaceSnapshots,
    Snapshots,
}

impl MediaKind {
    /// An unknown kind is a path segment that cannot exist, like an id that does not parse.
    pub fn parse(raw: &str) -> Result<Self, AppError> {
        match raw {
            "panoramic-views" => Ok(Self::PanoramicViews),
            "video-recordings" => Ok(Self::VideoRecordings),
            "face-snapshots" => Ok(Self::FaceSnapshots),
            "snapshots" => Ok(Self::Snapshots),
            _ => Err(AppError::NotFound("Media not found".to_string())),
        }
    }

    /// The path segment this kind was parsed from, reused as the storage folder name.
    fn slug(self) -> &'static str {
        match self {
            Self::PanoramicViews => "panoramic-views",
            Self::VideoRecordings => "video-recordings",
            Self::FaceSnapshots => "face-snapshots",
            Self::Snapshots => "snapshots",
        }
    }

    fn table(self) -> &'static str {
        match self {
            Self::PanoramicViews => "panoramic_view",
            Self::VideoRecordings => "video_recordings",
            Self::FaceSnapshots => "face_snapshots",
            Self::Snapshots => "snapshots",
        }
    }

    fn join_table(self) -> &'static str {
        match self {
            Self::PanoramicViews => "assignment_panoramic_view",
            Self::VideoRecordings => "assignment_video_recording",
            Self::FaceSnapshots => "assignment_face_snapshot",
            Self::Snapshots => "assignment_snapshot",
        }
    }

    fn join_column(self) -> &'static str {
        match self {
            Self::PanoramicViews => "panoramic_view_id",
            Self::VideoRecordings => "video_recording_id",
            Self::FaceSnapshots => "face_snapshot_id",
            Self::Snapshots => "snapshot_id",
        }
    }
}

fn parse_label(value: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(value) = value else { return Ok(None) };
    let label = value.trim();
    if label.is_empty() {
        return Ok(None);
    }
    if label.len() > MAX_LABEL {
        return Err(AppError::BadRequest(format!("label must be at most {MAX_LABEL} characters")));
    }
    Ok(Some(label.to_string()))
}

/// `POST /api/monitoring/attempts/:attempt_id/:kind`. Uploads the photo to Storage, then both
/// writes (the media row and its attempt link) happen in one transaction - a real fix for the
/// TS version's manual "delete the media row again if the link insert fails" compensation,
/// which PostgREST forced since it cannot span two calls in one transaction.
pub async fn add_media(
    pool: &PgPool,
    config: &Config,
    kind: MediaKind,
    attempt_id: i64,
    student_id: i64,
    image: &str,
    label: Option<&str>,
) -> Result<MediaRecord, AppError> {
    let label = parse_label(label)?;

    let attempt = access::load_running_attempt(pool, attempt_id).await?;
    if !access::owns_attempt(pool, attempt_id, student_id).await? {
        return Err(AppError::NotFound("Attempt not found".to_string()));
    }
    if !access::is_running(&attempt) {
        return Err(AppError::Conflict("Media can only be added while the attempt is in progress".to_string()));
    }
    if access::attempt_expired(pool, &Timed::from(&attempt)).await? {
        return Err(AppError::Conflict("Time is up: this attempt is over".to_string()));
    }

    let media_url = storage::upload_photo(config, attempt_id, kind.slug(), image).await?;

    let mut tx = pool.begin().await?;
    let table = kind.table();
    let insert_media = format!("insert into public.{table} (url, label) values ($1, $2) returning id, url, label, created_at");
    let (id, url, label, created_at) = sqlx::query_as::<_, (i64, String, Option<String>, chrono::DateTime<chrono::Utc>)>(&insert_media)
        .bind(&media_url)
        .bind(&label)
        .fetch_one(&mut *tx)
        .await?;

    let join_table = kind.join_table();
    let join_column = kind.join_column();
    let insert_link = format!("insert into public.{join_table} (assignment_id, {join_column}) values ($1, $2)");
    sqlx::query(&insert_link).bind(attempt.id).bind(id).execute(&mut *tx).await?;

    tx.commit().await?;
    Ok(MediaRecord { id, url, label, created_at })
}
