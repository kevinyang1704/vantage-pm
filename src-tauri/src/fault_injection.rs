//! Fault-injection boundaries and qualification-only controls.
//!
//! Compiled ONLY under the `qualification` Cargo feature. The `PMAPP_QUALIFICATION_BUILD_SENTINEL`
//! constant is embedded into the binary so the production-vs-qualification artifact audit can
//! verify that a production binary never contains qualification-only code paths.

pub const QUALIFICATION_SENTINEL: &str = "PMAPP_QUALIFICATION_BUILD_SENTINEL";

#[cfg(feature = "qualification")]
pub mod fault_boundaries {
    /// Logical crash boundaries F1-F6 defined in the evidence contract.
    /// Injection hooks are attached by the Gate A harness (Story 9.7); this module
    /// exists now so the qualification composition carries the boundary surface.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    #[repr(u8)]
    pub enum FaultBoundary {
        PreTransaction = 1,
        MidTransaction = 2,
        PostCommitPreReceipt = 3,
        PostReceiptPreRevision = 4,
        PostRevisionPreIpcResponse = 5,
        PostIpcResponse = 6,
    }

    pub const LOGICAL_CASE_IDS: [FaultBoundary; 6] = [
        FaultBoundary::PreTransaction,
        FaultBoundary::MidTransaction,
        FaultBoundary::PostCommitPreReceipt,
        FaultBoundary::PostReceiptPreRevision,
        FaultBoundary::PostRevisionPreIpcResponse,
        FaultBoundary::PostIpcResponse,
    ];

    /// Arming control — no-op in production (never compiled).
    pub fn arm(_boundary: FaultBoundary) {}
}

#[cfg(not(feature = "qualification"))]
pub mod fault_boundaries {
    /// Production composition: no fault boundaries exist. Referencing this module
    /// from production code is a compile-time error by design (empty enum).
    pub enum FaultBoundary {}
}
