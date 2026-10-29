//! Native wire protocol: closed tagged types mirroring the TypeScript
//! contracts, UUIDv7, and the sanitized error union (E9-FR3, E9-FR5).

pub mod commands;
pub mod errors;
pub mod uuid_v7;

pub use commands::{
    AffectedReasonInput, ChangeSet, CreateProjectCommand, NodeChange, NodeSnapshot,
    ProductCommand, ProductCommandApplied, ProductCommandRejected, ProductCommandResult,
    RepositoryOpenResult, RevisionInvalidated,
};
pub use errors::RepositoryError;
pub use uuid_v7::{create_uuid_v7, is_uuid_v7};

pub const PROTOCOL_VERSION: &str = commands::PROTOCOL_VERSION;

pub mod deletion_bundle;

pub mod recovery;

mod recovery_forecast;
