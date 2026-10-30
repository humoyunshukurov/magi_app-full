//! Exams: student read-only. Ports the student-facing half of `features/exams/` - no
//! creation, scheduling, question authoring or roster management (out of scope this pass).

pub mod handlers;
pub mod models;
pub mod routes;
pub mod service;
