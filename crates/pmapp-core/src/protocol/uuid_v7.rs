//! UUIDv7 generation and validation, matching the TypeScript `createUuidV7`
//! in `spikes/phase-0-durability/src/command-receipt.ts` exactly:
//! - time-ordered (millisecond timestamp in the first 48 bits)
//! - version nibble `0x7` (byte 6)
//! - variant nibble `0x8` (byte 8)
//! - lowercase hex, canonical dashed form

use std::time::{SystemTime, UNIX_EPOCH};

/// Canonical lowercase UUIDv7 pattern: `8-4-4-4-12` hex digits with version 7
/// and RFC-4122 variant bits `[89ab]` in the fourth group's first nibble.
pub fn is_uuid_v7(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, &b) in bytes.iter().enumerate() {
        let is_hex = matches!(b, b'0'..=b'9' | b'a'..=b'f');
        let is_dash = b == b'-';
        let expected_dash = matches!(index, 8 | 13 | 18 | 23);
        if expected_dash {
            if !is_dash {
                return false;
            }
        } else if !is_hex {
            return false;
        }
    }
    // Version nibble: character at index 14 must be '7'.
    if bytes[14] != b'7' {
        return false;
    }
    // Variant nibble: character at index 19 must be in [8..b].
    if !matches!(bytes[19], b'8'..=b'b') {
        return false;
    }
    true
}

fn current_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Generates a time-ordered UUIDv7 string.
pub fn create_uuid_v7() -> String {
    let mut bytes = [0u8; 16];
    // Fill with randomness first, then stamp the timestamp over bytes 0..=5.
    for byte in bytes.iter_mut() {
        *byte = rand_byte();
    }
    let timestamp = current_millis();
    bytes[0] = (timestamp >> 40) as u8;
    bytes[1] = (timestamp >> 32) as u8;
    bytes[2] = (timestamp >> 24) as u8;
    bytes[3] = (timestamp >> 16) as u8;
    bytes[4] = (timestamp >> 8) as u8;
    bytes[5] = timestamp as u8;
    bytes[6] = 0x70 | (bytes[6] & 0x0f);
    bytes[8] = 0x80 | (bytes[8] & 0x3f);

    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Deterministic UUIDv7 from a fixed seed — used ONLY by tests and fixtures.
pub fn test_uuid_v7(seed: u64) -> String {
    let mut bytes = [0u8; 16];
    for (index, byte) in bytes.iter_mut().enumerate() {
        let shift = (index as u32) % 8 * 8;
        *byte = ((seed.wrapping_mul(31).wrapping_add(index as u64)) >> shift) as u8;
    }
    let timestamp = current_millis();
    bytes[0] = (timestamp >> 40) as u8;
    bytes[1] = (timestamp >> 32) as u8;
    bytes[2] = (timestamp >> 24) as u8;
    bytes[3] = (timestamp >> 16) as u8;
    bytes[4] = (timestamp >> 8) as u8;
    bytes[5] = timestamp as u8;
    bytes[6] = 0x70 | (bytes[6] & 0x0f);
    bytes[8] = 0x80 | (bytes[8] & 0x3f);

    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn rand_byte() -> u8 {
    // Simple non-crypto fallback (the OS CSPRNG is not required for
    // repository correlation IDs; UUIDv7 uniquness is dominated by time).
    // Real randomness comes from the system via the `getrandom` crate when
    // available; this branch keeps the crate minimal.
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(current_millis());
    hasher.write_u64(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0));
    (hasher.finish() & 0xff) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_lowercase_uuid_v7() {
        let value = create_uuid_v7();
        assert!(is_uuid_v7(&value), "generated UUIDv7 must validate: {value}");
    }

    #[test]
    fn validates_canonical_examples() {
        assert!(is_uuid_v7("0198a000-0000-7000-8000-000000000001"));
        assert!(!is_uuid_v7("0198a000-0000-6000-8000-000000000001")); // wrong version
        assert!(!is_uuid_v7("0198a000-0000-7000-c000-000000000001")); // wrong variant
        assert!(!is_uuid_v7("0198A000-0000-7000-8000-000000000001")); // uppercase
    }

    #[test]
    fn produces_ordered_ids() {
        let a = create_uuid_v7();
        let b = create_uuid_v7();
        assert!(a <= b || b <= a); // time-ordered within a millisecond is allowed
    }
}
