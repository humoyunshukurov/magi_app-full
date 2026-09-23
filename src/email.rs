//! Outbound transactional email (verification, password reset, welcome).
//!
//! The TS backend sends these through Mailtrap (`email/email.js`). Wiring up the same
//! Mailtrap account here would spend the owner's token without being asked, so this pass
//! stubs it behind [`EmailSender`]: swap [`NoopEmailSender`] for a real Mailtrap client later
//! without touching any of the auth handlers.
//!
//! TODO: implement a Mailtrap-backed `EmailSender` once the owner OKs spending the token,
//! matching `sendVerificationEmail` / `sendPasswordResetEmail` / `sendResetSuccessEmail` /
//! `sendWelcomeEmail` in the TS backend's `email/email.js`.

use async_trait::async_trait;

/// Sends the transactional emails the auth flows trigger. Never fails the request that
/// triggered it: a send failure is logged, not surfaced, matching how little the caller can
/// do about it (the TS backend, by contrast, fails the request when the send fails - that
/// isn't worth reproducing since this pass never really sends anything).
#[async_trait]
pub trait EmailSender: Send + Sync {
    async fn send_verification(&self, to: &str, token: &str);
    async fn send_password_reset(&self, to: &str, token: &str);
    async fn send_reset_success(&self, to: &str);
    async fn send_welcome(&self, to: &str);
}

/// Stub sender: logs what would have been sent instead of calling Mailtrap.
pub struct NoopEmailSender;

#[async_trait]
impl EmailSender for NoopEmailSender {
    async fn send_verification(&self, to: &str, token: &str) {
        tracing::info!(%to, %token, "stub: verification email not sent (email delivery is out of scope this pass)");
    }

    async fn send_password_reset(&self, to: &str, token: &str) {
        tracing::info!(%to, %token, "stub: password reset email not sent (email delivery is out of scope this pass)");
    }

    async fn send_reset_success(&self, to: &str) {
        tracing::info!(%to, "stub: password reset success email not sent");
    }

    async fn send_welcome(&self, to: &str) {
        tracing::info!(%to, "stub: welcome email not sent");
    }
}
