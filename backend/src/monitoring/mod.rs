//! Monitoring media uploads. Ports the student-write half of `features/monitoring/` - a
//! student adding panoramic views, video recordings, face snapshots and snapshots to their
//! own in-progress attempt. Staff listing/deletion is out of scope this pass.

pub mod handlers;
pub mod models;
pub mod routes;
pub mod service;
