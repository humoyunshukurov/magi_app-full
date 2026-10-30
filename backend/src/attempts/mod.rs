//! Attempts (table `assignments`): a student sitting an exam. Ports the student-facing half
//! of `features/attempts/` - start, get own, sync answers, submit. Grading, staff listing
//! and staff attempt views are out of scope this pass.

pub mod handlers;
pub mod models;
pub mod routes;
pub mod service;
