//! Hardware detection for the built-in (managed) runtime.
//!
//! Drives two decisions: how many GPU layers to offload when spawning the
//! sidecar, and which curated model tier to recommend to the user. RAM — not
//! VRAM — picks the tier, because Apple Silicon's unified memory makes total
//! RAM the binding constraint there, and it's the only figure we can read
//! reliably across every platform.

use serde::Serialize;
use sysinfo::System;

/// Apple Silicon offloads every layer to the Metal GPU. llama.cpp treats any
/// value larger than the model's layer count as "all layers", so a large
/// sentinel is the portable way to say "everything".
const ALL_GPU_LAYERS: u32 = 99_999;

/// Conservative default for CUDA when VRAM can't be probed — enough to get a
/// real speedup on a mid-range card without risking OOM on a small one.
const DEFAULT_CUDA_LAYERS: u32 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GpuType {
    /// Metal — aarch64-apple-darwin.
    AppleSilicon,
    /// CUDA — Windows/Linux with NVIDIA drivers present.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    NvidiaCuda,
    /// No usable GPU acceleration; inference runs on CPU.
    CpuOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelTier {
    /// < 8 GB RAM → 3B models only.
    Light,
    /// 8–15 GB RAM → up to 7B.
    Standard,
    /// 16 GB+ RAM → up to 13B.
    Pro,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareProfile {
    pub gpu_type: GpuType,
    pub total_ram_gb: f32,
    pub vram_gb: Option<f32>,
    pub recommended_tier: ModelTier,
    pub gpu_layers: u32,
    /// Logical core count minus headroom for the OS and ÄKÄ's UI, floored at
    /// 2. This is the `--threads` value the sidecar should be spawned with.
    pub recommended_threads: u32,
}

/// Total physical RAM in gigabytes.
fn total_ram_gb() -> f32 {
    let mut sys = System::new();
    sys.refresh_memory();
    // sysinfo reports bytes.
    sys.total_memory() as f32 / 1_073_741_824.0
}

/// Recommended model tier, gated on total RAM (see module docs for why RAM and
/// not VRAM).
fn tier_for_ram(total_ram_gb: f32) -> ModelTier {
    if total_ram_gb < 8.0 {
        ModelTier::Light
    } else if total_ram_gb < 16.0 {
        ModelTier::Standard
    } else {
        ModelTier::Pro
    }
}

/// `--threads` value: leave 2 cores of headroom, never go below 2.
pub fn recommended_threads() -> u32 {
    let logical = num_cpus::get() as u32;
    logical.saturating_sub(2).max(2)
}

/// Attempt to dynamically load the CUDA driver. A successful load means an
/// NVIDIA driver stack is installed and usable. We never link against CUDA at
/// build time — this keeps the binary runnable on machines without it.
// Unused on macOS (Apple Silicon never probes CUDA); used on Linux auto-detect
// and by the opt-in `enable_cuda_mode` path on Windows.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn cuda_available() -> bool {
    #[cfg(target_os = "windows")]
    let lib_name = "nvcuda.dll";
    #[cfg(not(target_os = "windows"))]
    let lib_name = "libcuda.so";

    unsafe { libloading::Library::new(lib_name).is_ok() }
}

/// Detect the GPU type for this machine.
///
/// Apple Silicon is decided at compile time. On Windows, CUDA is **never**
/// auto-detected — it is opt-in via "Performance Mode" (see
/// `enable_cuda_mode`), so a stock Windows machine always reports `CpuOnly`
/// here. On Linux, CUDA is probed and used automatically when present.
pub fn detect_gpu_type() -> GpuType {
    if cfg!(target_arch = "aarch64") && cfg!(target_os = "macos") {
        return GpuType::AppleSilicon;
    }

    #[cfg(target_os = "linux")]
    {
        if cuda_available() {
            return GpuType::NvidiaCuda;
        }
    }

    GpuType::CpuOnly
}

/// GPU layers to offload for a given GPU type.
pub fn gpu_layers_for(gpu_type: GpuType) -> u32 {
    match gpu_type {
        GpuType::AppleSilicon => ALL_GPU_LAYERS,
        GpuType::NvidiaCuda => DEFAULT_CUDA_LAYERS,
        GpuType::CpuOnly => 0,
    }
}

/// Build the full hardware profile for the current machine.
pub fn detect() -> HardwareProfile {
    let gpu_type = detect_gpu_type();
    let total_ram_gb = total_ram_gb();
    HardwareProfile {
        gpu_type,
        total_ram_gb,
        // VRAM is not probed yet; on Apple Silicon it's unified with RAM and
        // meaningless to report separately.
        vram_gb: None,
        recommended_tier: tier_for_ram(total_ram_gb),
        gpu_layers: gpu_layers_for(gpu_type),
        recommended_threads: recommended_threads(),
    }
}

/// Expose the detected hardware profile to the frontend (hardware banner,
/// RAM gate, tier filtering in the model browser).
#[tauri::command]
pub fn get_hardware_profile() -> HardwareProfile {
    detect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RamCheckResult {
    pub allowed: bool,
    pub available_ram_gb: f32,
    pub required_ram_gb: f32,
    pub warning: Option<String>,
}

/// Gate a model load against current RAM. Disallows only when the requirement
/// exceeds *total* RAM (a guaranteed crash); warns-but-allows when it merely
/// exceeds currently *available* RAM, since the OS can reclaim/compress.
/// Exposed to the frontend so it can warn before download/load (real
/// `required_ram_gb` arrives once GGUF metadata is parsed in Step 7).
#[tauri::command]
pub fn check_ram_for_model(required_ram_gb: f32) -> RamCheckResult {
    let mut sys = System::new_all();
    sys.refresh_memory();
    let available_gb = sys.available_memory() as f32 / 1_073_741_824.0;
    let total_gb = sys.total_memory() as f32 / 1_073_741_824.0;

    if required_ram_gb > total_gb {
        RamCheckResult {
            allowed: false,
            available_ram_gb: total_gb,
            required_ram_gb,
            warning: Some(format!(
                "This model requires {required_ram_gb:.1}GB RAM. Your system has \
                 {total_gb:.1}GB total. Loading it will cause a crash."
            )),
        }
    } else if required_ram_gb > available_gb {
        RamCheckResult {
            allowed: true, // warn but allow — available != total
            available_ram_gb: available_gb,
            required_ram_gb,
            warning: Some(format!(
                "This model requires {required_ram_gb:.1}GB RAM. Only \
                 {available_gb:.1}GB is currently free. Performance may be \
                 severely degraded."
            )),
        }
    } else {
        RamCheckResult {
            allowed: true,
            available_ram_gb: available_gb,
            required_ram_gb,
            warning: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_boundaries() {
        assert_eq!(tier_for_ram(4.0), ModelTier::Light);
        assert_eq!(tier_for_ram(7.9), ModelTier::Light);
        assert_eq!(tier_for_ram(8.0), ModelTier::Standard);
        assert_eq!(tier_for_ram(15.9), ModelTier::Standard);
        assert_eq!(tier_for_ram(16.0), ModelTier::Pro);
        assert_eq!(tier_for_ram(64.0), ModelTier::Pro);
    }

    #[test]
    fn threads_never_below_two() {
        assert!(recommended_threads() >= 2);
    }

    #[test]
    fn gpu_layers_match_type() {
        assert_eq!(gpu_layers_for(GpuType::CpuOnly), 0);
        assert_eq!(gpu_layers_for(GpuType::NvidiaCuda), DEFAULT_CUDA_LAYERS);
        assert_eq!(gpu_layers_for(GpuType::AppleSilicon), ALL_GPU_LAYERS);
    }

    #[test]
    fn detect_produces_consistent_layers() {
        let p = detect();
        assert_eq!(p.gpu_layers, gpu_layers_for(p.gpu_type));
        assert!(p.total_ram_gb > 0.0);
    }
}
