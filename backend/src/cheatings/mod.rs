//! Cheating incidents: a student reporting an automatic-detection incident on their own
//! in-progress attempt. Ports the student-report half of `features/cheatings/`. Staff
//! listing, dismissal, manual review and the per-exam summary are out of scope this pass.

pub mod handlers;
pub mod models;
pub mod routes;
pub mod service;
