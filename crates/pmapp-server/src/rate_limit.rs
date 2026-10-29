//! Rate limiting (Story 27.4, R6, C/27.4).
//!
//! Registration, invite creation, invite redemption and recovery redemption are
//! rate-limited per principal/address so abuse cannot brute-force links or flood
//! the service. The limiter is a pure sliding-window counter with injectable
//! time, so it is deterministic and testable.

use std::collections::HashMap;
use std::sync::Mutex;

/// A fixed-window rate limit: at most `max` events per `window_ms`.
#[derive(Debug, Clone, Copy)]
pub struct RateLimit {
    pub max: u32,
    pub window_ms: i64,
}

impl RateLimit {
    pub const fn new(max: u32, window_ms: i64) -> Self {
        Self { max, window_ms }
    }
}

/// Default limits for the abuse-sensitive operations.
pub const REGISTRATION_LIMIT: RateLimit = RateLimit::new(10, 60_000);
/// Instance-wide backstop for unauthenticated first-owner registration.
pub const REGISTRATION_GLOBAL_LIMIT: RateLimit = RateLimit::new(300, 60_000);
pub const INVITE_CREATE_LIMIT: RateLimit = RateLimit::new(30, 60_000);
pub const INVITE_REDEEM_LIMIT: RateLimit = RateLimit::new(10, 60_000);
pub const RECOVERY_LIMIT: RateLimit = RateLimit::new(5, 60_000);
/// A coarse instance-wide backstop for invite redemption, so many distinct
/// callers cannot collectively flood the endpoint even with per-address limits.
pub const INVITE_REDEEM_GLOBAL_LIMIT: RateLimit = RateLimit::new(600, 60_000);

#[derive(Debug, Clone, Copy)]
struct Window {
    window_start_ms: i64,
    count: u32,
}

/// A sliding-window rate limiter keyed by an opaque subject (buckets).
#[derive(Default)]
pub struct RateLimiter {
    buckets: Mutex<HashMap<(String, String), Window>>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self { buckets: Mutex::new(HashMap::new()) }
    }

    /// Register one event for `(bucket, subject)` at `now_ms`. Returns true when
    /// allowed, false when the limit is exceeded. A new window resets the count.
    pub fn check(&self, bucket: &str, subject: &str, limit: RateLimit, now_ms: i64) -> bool {
        let mut buckets = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        // Opportunistic prune so attacker-chosen subjects cannot grow the map
        // without bound (R6/C/27.4).
        if buckets.len() > 4096 {
            buckets.retain(|_, w| now_ms - w.window_start_ms < limit.window_ms);
        }
        let key = (bucket.to_string(), subject.to_string());
        let entry = buckets.entry(key).or_insert(Window { window_start_ms: now_ms, count: 0 });
        if now_ms - entry.window_start_ms >= limit.window_ms {
            entry.window_start_ms = now_ms;
            entry.count = 0;
        }
        if entry.count >= limit.max {
            return false;
        }
        entry.count += 1;
        true
    }

    /// Drop windows that have fully elapsed (bounded memory).
    pub fn prune(&self, now_ms: i64, max_window_ms: i64) {
        let mut buckets = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        buckets.retain(|_, w| now_ms - w.window_start_ms < max_window_ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_the_limit_then_refuses() {
        let limiter = RateLimiter::new();
        let limit = RateLimit::new(3, 1000);
        assert!(limiter.check("invite", "ip1", limit, 0));
        assert!(limiter.check("invite", "ip1", limit, 0));
        assert!(limiter.check("invite", "ip1", limit, 0));
        assert!(!limiter.check("invite", "ip1", limit, 0));
    }

    #[test]
    fn a_new_window_resets_the_count() {
        let limiter = RateLimiter::new();
        let limit = RateLimit::new(1, 1000);
        assert!(limiter.check("invite", "ip1", limit, 0));
        assert!(!limiter.check("invite", "ip1", limit, 500));
        // After the window elapses, allowed again.
        assert!(limiter.check("invite", "ip1", limit, 1000));
    }

    #[test]
    fn subjects_and_buckets_are_independent() {
        let limiter = RateLimiter::new();
        let limit = RateLimit::new(1, 1000);
        assert!(limiter.check("invite", "ip1", limit, 0));
        assert!(limiter.check("invite", "ip2", limit, 0));
        assert!(limiter.check("recovery", "ip1", limit, 0));
    }
}
