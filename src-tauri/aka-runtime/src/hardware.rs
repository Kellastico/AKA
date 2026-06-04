//! Lightweight hardware report for the sidecar's `GET /hardware` endpoint.
//!
//! The main ÄKÄ app does its own (authoritative) detection in
//! `src-tauri/src/hardware.rs` and passes the resulting `--gpu-layers` /
//! `--threads` into this process. Here we re-detect RAM/GPU for an
//! independent report and echo back the runtime values we were actually
//! launched with.

use serde::Serialize;
use sysinfo::System;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GpuType {
    AppleSilicon,
    NvidiaCuda,
    CpuOnly,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelTier {
    Light,
    Standard,
    Pro,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareReport {
    pub gpu_type: GpuType,
    pub total_ram_gb: f32,
    pub vram_gb: Option<f32>,
    pub recommended_tier: ModelTier,
    /// GPU layers this sidecar is actually offloading (from `--gpu-layers`).
    pub gpu_layers: u32,
    /// Threads this sidecar is actually using (from `--threads`).
    pub threads: u32,
}

/// Called only when GPU offload is active (`gpu_layers > 0`). The launching
/// app already decided GPU policy and passed the layer count, so we just
/// classify by platform: Apple Silicon → Metal, anything else → CUDA.
fn active_gpu_type() -> GpuType {
    if cfg!(target_arch = "aarch64") && cfg!(target_os = "macos") {
        GpuType::AppleSilicon
    } else {
        GpuType::NvidiaCuda
    }
}

fn total_ram_gb() -> f32 {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.total_memory() as f32 / 1_073_741_824.0
}

fn tier_for_ram(gb: f32) -> ModelTier {
    if gb < 8.0 {
        ModelTier::Light
    } else if gb < 16.0 {
        ModelTier::Standard
    } else {
        ModelTier::Pro
    }
}

pub fn report(gpu_layers: u32, threads: u32) -> HardwareReport {
    let total_ram_gb = total_ram_gb();
    let gpu_type = if gpu_layers > 0 {
        active_gpu_type()
    } else {
        GpuType::CpuOnly
    };
    HardwareReport {
        gpu_type,
        total_ram_gb,
        vram_gb: None,
        recommended_tier: tier_for_ram(total_ram_gb),
        gpu_layers,
        threads,
    }
}
