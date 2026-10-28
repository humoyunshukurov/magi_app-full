//! SQLite + SQLCipher storage (ADR-0003).
//!
//! Holds what has to survive a crash or a lost connection between keystrokes and the next
//! sync to the backend: today, the in-progress answer drafts. One connection guarded by a
//! mutex, so writes are serialized (single-writer).

use std::path::Path;
use std::sync::Mutex;

use magi_types::{ActivityAttempt, ActivityEvent, AnswerDraft};
use rusqlite::{params, Connection};

/// Errors originating in the storage layer.
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    /// A database operation failed.
    #[error("storage error: {0}")]
    Db(String),
}

impl From<rusqlite::Error> for StorageError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Db(err.to_string())
    }
}

impl From<serde_json::Error> for StorageError {
    fn from(err: serde_json::Error) -> Self {
        Self::Db(err.to_string())
    }
}

/// Encrypted local store.
pub struct Storage {
    conn: Mutex<Connection>,
}

impl Storage {
    /// Opens (creating if needed) the database at `path`, encrypted with `key`.
    ///
    /// # Errors
    /// Fails if the file can't be opened or was written with a different key.
    pub fn open(path: &Path, key: &str) -> Result<Self, StorageError> {
        Self::init(Connection::open(path)?, key)
    }

    /// In-memory database, for tests.
    ///
    /// # Errors
    /// Fails if the database can't be initialized.
    pub fn open_in_memory(key: &str) -> Result<Self, StorageError> {
        Self::init(Connection::open_in_memory()?, key)
    }

    fn init(conn: Connection, key: &str) -> Result<Self, StorageError> {
        // `key` must be the first statement on the connection.
        conn.pragma_update(None, "key", key)?;
        // Reading anything is what actually fails when the key is wrong.
        conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get::<_, String>(0))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS answer_drafts (
                attempt_id      INTEGER NOT NULL,
                question_id     INTEGER NOT NULL,
                answer          TEXT NOT NULL,
                option_ids      TEXT NOT NULL,
                typing_duration INTEGER NOT NULL,
                text_typed      INTEGER NOT NULL,
                text_edited     INTEGER NOT NULL,
                text_pasted     INTEGER NOT NULL,
                paste_events    INTEGER NOT NULL,
                text_deleted    INTEGER NOT NULL,
                freeze_count    INTEGER NOT NULL,
                longest_freeze  INTEGER NOT NULL,
                time_spent      INTEGER NOT NULL,
                started_at      TEXT,
                answered_at     TEXT,
                updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                PRIMARY KEY (attempt_id, question_id)
            );
            CREATE TABLE IF NOT EXISTS activity_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER NOT NULL,
                attempt_id  INTEGER NOT NULL,
                exam_name   TEXT NOT NULL,
                at          TEXT NOT NULL,
                kind        TEXT NOT NULL,
                question_id INTEGER,
                detail      TEXT NOT NULL,
                data        TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS activity_events_by_attempt ON activity_events (user_id, attempt_id, id)",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A poisoned lock only means another thread panicked mid-write; SQLite itself is
        // still consistent, so keep serving.
        self.conn.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Inserts the draft, or replaces the stored one for the same attempt + question.
    ///
    /// # Errors
    /// Fails if the write fails.
    pub fn save_draft(&self, draft: &AnswerDraft) -> Result<(), StorageError> {
        self.conn().execute(
            "INSERT INTO answer_drafts (attempt_id, question_id, answer, option_ids, typing_duration,
                text_typed, text_edited, text_pasted, paste_events, text_deleted, freeze_count, longest_freeze,
                time_spent, started_at, answered_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT (attempt_id, question_id) DO UPDATE SET
                answer = excluded.answer, option_ids = excluded.option_ids,
                typing_duration = excluded.typing_duration, text_typed = excluded.text_typed,
                text_edited = excluded.text_edited, text_pasted = excluded.text_pasted,
                paste_events = excluded.paste_events,
                text_deleted = excluded.text_deleted, freeze_count = excluded.freeze_count,
                longest_freeze = excluded.longest_freeze,
                time_spent = excluded.time_spent, started_at = excluded.started_at,
                answered_at = excluded.answered_at, updated_at = excluded.updated_at",
            params![
                draft.attempt_id,
                draft.question_id,
                draft.answer,
                serde_json::to_string(&draft.option_ids)?,
                draft.typing_duration,
                draft.text_typed,
                draft.text_edited,
                draft.text_pasted,
                draft.paste_events,
                draft.text_deleted,
                draft.freeze_count,
                draft.longest_freeze,
                draft.time_spent,
                draft.started_at,
                draft.answered_at,
            ],
        )?;
        Ok(())
    }

    /// All stored drafts of an attempt.
    ///
    /// # Errors
    /// Fails if the read fails or a stored row is malformed.
    pub fn load_drafts(&self, attempt_id: i64) -> Result<Vec<AnswerDraft>, StorageError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT question_id, answer, option_ids, typing_duration, text_typed, text_edited,
                    text_pasted, paste_events, text_deleted, freeze_count, longest_freeze, time_spent, started_at, answered_at
             FROM answer_drafts WHERE attempt_id = ?1 ORDER BY question_id",
        )?;
        let rows = stmt.query_map(params![attempt_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, u32>(3)?,
                row.get::<_, u32>(4)?,
                row.get::<_, u32>(5)?,
                row.get::<_, u32>(6)?,
                row.get::<_, u32>(7)?,
                row.get::<_, u32>(8)?,
                row.get::<_, u32>(9)?,
                row.get::<_, u32>(10)?,
                row.get::<_, u32>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, Option<String>>(13)?,
            ))
        })?;
        let mut drafts = Vec::new();
        for row in rows {
            let (
                question_id,
                answer,
                option_ids,
                typing_duration,
                text_typed,
                text_edited,
                text_pasted,
                paste_events,
                text_deleted,
                freeze_count,
                longest_freeze,
                time_spent,
                started_at,
                answered_at,
            ) = row?;
            drafts.push(AnswerDraft {
                attempt_id,
                question_id,
                answer,
                option_ids: serde_json::from_str(&option_ids)?,
                typing_duration,
                text_typed,
                text_edited,
                text_pasted,
                paste_events,
                text_deleted,
                freeze_count,
                longest_freeze,
                time_spent,
                started_at,
                answered_at,
            });
        }
        Ok(drafts)
    }

    /// Appends one entry to the activity log.
    ///
    /// # Errors
    /// Fails if the write fails.
    pub fn log_event(&self, event: &ActivityEvent) -> Result<(), StorageError> {
        self.conn().execute(
            "INSERT INTO activity_events (user_id, attempt_id, exam_name, at, kind, question_id, detail, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                event.user_id,
                event.attempt_id,
                event.exam_name,
                event.at,
                event.kind,
                event.question_id,
                event.detail,
                event.data
            ],
        )?;
        Ok(())
    }

    /// The attempts of `user_id` that have activity recorded, most recent first.
    ///
    /// # Errors
    /// Fails if the read fails.
    pub fn list_activity_attempts(&self, user_id: i64) -> Result<Vec<ActivityAttempt>, StorageError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT attempt_id, MAX(exam_name), MIN(at), MAX(at), COUNT(*)
             FROM activity_events WHERE user_id = ?1
             GROUP BY attempt_id ORDER BY MAX(at) DESC, attempt_id DESC",
        )?;
        let rows = stmt.query_map(params![user_id], |row| {
            Ok(ActivityAttempt {
                attempt_id: row.get(0)?,
                exam_name: row.get(1)?,
                first_at: row.get(2)?,
                last_at: row.get(3)?,
                events: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Everything recorded for one attempt of `user_id`, in the order it happened.
    ///
    /// # Errors
    /// Fails if the read fails.
    pub fn list_activity(&self, user_id: i64, attempt_id: i64) -> Result<Vec<ActivityEvent>, StorageError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT exam_name, at, kind, question_id, detail, data
             FROM activity_events WHERE user_id = ?1 AND attempt_id = ?2 ORDER BY id",
        )?;
        let rows = stmt.query_map(params![user_id, attempt_id], |row| {
            Ok(ActivityEvent {
                user_id,
                attempt_id,
                exam_name: row.get(0)?,
                at: row.get(1)?,
                kind: row.get(2)?,
                question_id: row.get(3)?,
                detail: row.get(4)?,
                data: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Drops every draft of an attempt (once it has been submitted).
    ///
    /// # Errors
    /// Fails if the write fails.
    pub fn clear_drafts(&self, attempt_id: i64) -> Result<(), StorageError> {
        self.conn().execute("DELETE FROM answer_drafts WHERE attempt_id = ?1", params![attempt_id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(attempt_id: i64, question_id: i64, answer: &str) -> AnswerDraft {
        AnswerDraft {
            attempt_id,
            question_id,
            answer: answer.to_string(),
            option_ids: vec![3, 4],
            typing_duration: 12,
            text_typed: 40,
            text_edited: 5,
            text_pasted: 0,
            paste_events: 0,
            text_deleted: 2,
            freeze_count: 1,
            longest_freeze: 20,
            time_spent: 90,
            started_at: Some("2026-09-28T10:00:00Z".to_string()),
            answered_at: None,
        }
    }

    #[test]
    fn saves_and_loads_a_draft() {
        let storage = Storage::open_in_memory("k").unwrap();
        storage.save_draft(&draft(1, 10, "hello")).unwrap();
        assert_eq!(storage.load_drafts(1).unwrap(), vec![draft(1, 10, "hello")]);
    }

    #[test]
    fn saving_again_replaces_the_draft_for_that_question() {
        let storage = Storage::open_in_memory("k").unwrap();
        storage.save_draft(&draft(1, 10, "first")).unwrap();
        storage.save_draft(&draft(1, 10, "second")).unwrap();
        storage.save_draft(&draft(1, 11, "other question")).unwrap();
        let loaded = storage.load_drafts(1).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].answer, "second");
    }

    #[test]
    fn clearing_only_touches_the_given_attempt() {
        let storage = Storage::open_in_memory("k").unwrap();
        storage.save_draft(&draft(1, 10, "a")).unwrap();
        storage.save_draft(&draft(2, 10, "b")).unwrap();
        storage.clear_drafts(1).unwrap();
        assert!(storage.load_drafts(1).unwrap().is_empty());
        assert_eq!(storage.load_drafts(2).unwrap().len(), 1);
    }

    #[test]
    fn the_file_is_encrypted_and_needs_the_same_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("magi.db");
        {
            let storage = Storage::open(&path, "right-key").unwrap();
            storage.save_draft(&draft(1, 10, "plainly-visible-answer-text")).unwrap();
        }
        // WAL content may still sit in the -wal file until checkpoint; check every file.
        for entry in std::fs::read_dir(dir.path()).unwrap() {
            let bytes = std::fs::read(entry.unwrap().path()).unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains("plainly-visible-answer-text"));
        }
        assert!(Storage::open(&path, "wrong-key").is_err());
        assert_eq!(Storage::open(&path, "right-key").unwrap().load_drafts(1).unwrap().len(), 1);
    }

    fn event(user_id: i64, attempt_id: i64, at: &str, kind: &str, detail: &str) -> ActivityEvent {
        ActivityEvent {
            user_id,
            attempt_id,
            exam_name: format!("Exam {attempt_id}"),
            at: at.to_string(),
            kind: kind.to_string(),
            question_id: None,
            detail: detail.to_string(),
            data: "{}".to_string(),
        }
    }

    #[test]
    fn activity_comes_back_in_the_order_it_was_logged() {
        let storage = Storage::open_in_memory("k").unwrap();
        storage.log_event(&event(7, 1, "2026-09-28T10:00:00.000Z", "attempt_started", "first")).unwrap();
        storage.log_event(&event(7, 1, "2026-09-28T10:00:05.000Z", "paste", "second")).unwrap();
        let mut with_question = event(7, 1, "2026-09-28T10:00:09.000Z", "question_summary", "third");
        with_question.question_id = Some(42);
        with_question.data = r#"{"typed":12}"#.to_string();
        storage.log_event(&with_question).unwrap();

        let listed = storage.list_activity(7, 1).unwrap();
        assert_eq!(listed.iter().map(|e| e.detail.as_str()).collect::<Vec<_>>(), ["first", "second", "third"]);
        assert_eq!(listed[2], with_question);
    }

    #[test]
    fn activity_is_scoped_to_the_user_who_did_it() {
        let storage = Storage::open_in_memory("k").unwrap();
        storage.log_event(&event(7, 1, "2026-09-28T10:00:00.000Z", "attempt_started", "mine")).unwrap();
        storage.log_event(&event(8, 1, "2026-09-28T10:00:01.000Z", "attempt_started", "someone else")).unwrap();

        assert_eq!(storage.list_activity(7, 1).unwrap().len(), 1);
        assert_eq!(storage.list_activity(7, 1).unwrap()[0].detail, "mine");
        assert_eq!(storage.list_activity_attempts(8).unwrap().len(), 1);
        assert!(storage.list_activity_attempts(9).unwrap().is_empty());
    }

    #[test]
    fn attempts_are_listed_newest_first_with_their_span_and_count() {
        let storage = Storage::open_in_memory("k").unwrap();
        storage.log_event(&event(7, 1, "2026-09-28T09:00:00.000Z", "attempt_started", "a")).unwrap();
        storage.log_event(&event(7, 1, "2026-09-28T09:10:00.000Z", "attempt_submitted", "b")).unwrap();
        storage.log_event(&event(7, 2, "2026-09-28T11:00:00.000Z", "attempt_started", "c")).unwrap();

        let attempts = storage.list_activity_attempts(7).unwrap();
        assert_eq!(attempts.iter().map(|a| a.attempt_id).collect::<Vec<_>>(), [2, 1]);
        assert_eq!(attempts[1].events, 2);
        assert_eq!(attempts[1].first_at, "2026-09-28T09:00:00.000Z");
        assert_eq!(attempts[1].last_at, "2026-09-28T09:10:00.000Z");
        assert_eq!(attempts[1].exam_name, "Exam 1");
    }
}
