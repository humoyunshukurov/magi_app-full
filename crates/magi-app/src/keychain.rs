//! The local database key lives in the OS keychain (ADR-0003), never next to the file it
//! protects. Created on first use.

use uuid::Uuid;

const SERVICE: &str = "org.trymagi.desktop";
const ACCOUNT: &str = "local-db-key";

/// The database key, generating and storing one if the keychain has none yet.
pub fn db_key() -> Result<String, keyring::Error> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)?;
    match entry.get_password() {
        Err(keyring::Error::NoEntry) => {
            let key = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            entry.set_password(&key)?;
            Ok(key)
        }
        other => other,
    }
}
