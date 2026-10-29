//! Ordered idempotent schema migration and startup integrity adjudication
//! (E9-FR11).

pub mod registry;
pub mod runner;

#[cfg(test)]
mod staffing_qualification;
