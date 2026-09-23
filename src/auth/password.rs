//! Password hashing. Cost 10, matching the TS backend (`bcrypt.hash(password, 10)`) so the
//! existing `users.password` hashes keep validating and new ones validate on either backend.

use crate::error::AppError;

const COST: u32 = 10;

pub fn hash(password: &str) -> Result<String, AppError> {
    Ok(bcrypt::hash(password, COST)?)
}

pub fn verify(password: &str, hash: &str) -> Result<bool, AppError> {
    Ok(bcrypt::verify(password, hash)?)
}
