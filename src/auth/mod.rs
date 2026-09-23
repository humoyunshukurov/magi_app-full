//! Auth (ADR-0004: REST + bearer auth). Signup, email verification, login, logout,
//! password reset, and "who am I" - ported from `features/auth/` in the TS backend.

pub mod handlers;
pub mod jwt;
pub mod middleware;
pub mod models;
pub mod password;
pub mod routes;
pub mod token_store;

pub use middleware::CurrentUser;
