//! The four backend generators. Each consumes the neutral IR **and** a target
//! descriptor and produces target-shaped output — kept separable so one node's
//! artifacts can regenerate without touching its siblings or the compiler core.

pub mod dag;
pub mod grammar;
pub mod prompt;
pub mod protocol;
