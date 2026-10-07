//! Remembers bearer tokens that were just confirmed valid, so a burst of requests doesn't pay a
//! database round trip each to re-check the same token. Signature and expiry are still verified
//! on every request; only the "has it been revoked" lookup is skipped, and only for a short time.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(30);
const PRUNE_AT: usize = 1024;

#[derive(Clone, Default)]
pub struct TokenCache(Arc<Mutex<HashMap<String, Instant>>>);

impl TokenCache {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Instant>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Was this token confirmed valid within the last few seconds?
    pub fn is_fresh(&self, token: &str) -> bool {
        self.map().get(token).is_some_and(|checked| checked.elapsed() < TTL)
    }

    pub fn remember(&self, token: &str) {
        let mut map = self.map();
        if map.len() >= PRUNE_AT {
            map.retain(|_, checked| checked.elapsed() < TTL);
        }
        map.insert(token.to_string(), Instant::now());
    }

    /// Called when a token is revoked, so logging out takes effect at once.
    pub fn forget(&self, token: &str) {
        self.map().remove(token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembers_a_token_until_it_is_forgotten() {
        let cache = TokenCache::default();
        assert!(!cache.is_fresh("t"));
        cache.remember("t");
        assert!(cache.is_fresh("t"));
        assert!(!cache.is_fresh("other"));
        cache.forget("t");
        assert!(!cache.is_fresh("t"));
    }

    #[test]
    fn clones_share_the_same_entries() {
        let cache = TokenCache::default();
        let clone = cache.clone();
        cache.remember("t");
        assert!(clone.is_fresh("t"));
    }
}
