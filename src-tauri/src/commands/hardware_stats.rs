//! Live hardware readings for the Context Window modal.
//!
//! Readings exist for exactly one reason: to render in that modal. They are
//! sampled into a fixed in-memory window, read by the frontend, and discarded
//! when the process exits. Nothing here is written to disk and nothing leaves
//! the machine — the only subprocess is a local `ioreg` read.
//!
//! The sampler holds its `System` across reads on purpose. CPU usage is a
//! delta between two refreshes, so a freshly constructed `System` refreshed
//! once always reads 0%. Sampling happens on one background task at a fixed
//! cadence (`SAMPLE_INTERVAL`), which is what keeps consecutive refreshes far
//! enough apart for that delta to mean anything; the frontend command is a
//! pure read of the window and never triggers a sample.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Manager, State};

use crate::sidecar::SidecarState;

/// Roughly five minutes of history at `SAMPLE_INTERVAL`.
const RECENT_WINDOW_LEN: usize = 300;

/// How often the background task samples while a model is loaded.
///
/// Comfortably above sysinfo's `MINIMUM_CPU_UPDATE_INTERVAL` (200 ms on
/// macOS), below which the CPU delta is meaningless. The cost per tick is a
/// sub-millisecond `sysinfo` refresh plus one ~20 ms `ioreg` fork — about 2%
/// of a single core, or 0.2% of a 10-core machine, and only while a model is
/// actually loaded.
const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);

/// One point-in-time set of readings. Rendered and discarded.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareReading {
    /// Milliseconds since the sampler started. Lets the UI draw a gap as a gap
    /// when sampling was paused, rather than interpolating a straight line
    /// across it.
    pub at_ms: u64,
    /// Whole-machine CPU, 0–100.
    pub cpu_percent: f32,
    /// ÄKÄ's share of the machine, 0–100. `None` if the process can't be read.
    pub app_cpu_percent: Option<f32>,
    /// The runtime sidecar's share of the machine, 0–100.
    pub runtime_cpu_percent: Option<f32>,
    /// Resident set size of the runtime sidecar in MB. Unlike the model's file
    /// size this moves with the allocated context window, since the KV cache
    /// lives in it — the one honest, *measured* signal for what a larger
    /// context costs. On Apple Silicon weights are mmap'd into Metal buffers
    /// and read low here, so this is never subtracted from anything.
    pub runtime_memory_mb: Option<f64>,
    /// GPU utilization, 0–100. macOS only; `None` elsewhere.
    pub gpu_percent: Option<f32>,
    /// Unified memory currently held by the GPU, in MB. macOS only.
    pub gpu_memory_mb: Option<f64>,
}

/// The latest reading plus the recent window, for the Context Window modal.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareStats {
    pub current: HardwareReading,
    /// Oldest first, at most `RECENT_WINDOW_LEN` entries.
    pub recent: Vec<HardwareReading>,
}

/// Owns the `System` handle and the rolling window. Registered as Tauri
/// managed state; dies with the process.
pub struct HardwareSampler {
    sys: System,
    started: Instant,
    recent: VecDeque<HardwareReading>,
}

impl Default for HardwareSampler {
    fn default() -> Self {
        let mut sys = System::new();
        // Prime the counters. Usage is measured against the previous refresh,
        // so these establish the baseline the first real sample reads against.
        // Machine-wide reads correctly from the first sample; per-process
        // needs sysinfo to have seen the process twice, so priming here cuts
        // its warm-up from two samples to one rather than removing it. The
        // sidecar's PID isn't known until a model loads, so it warms up
        // separately from that point.
        sys.refresh_cpu_usage();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[Pid::from_u32(std::process::id())]),
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
        Self {
            sys,
            started: Instant::now(),
            recent: VecDeque::with_capacity(RECENT_WINDOW_LEN),
        }
    }
}

impl HardwareSampler {
    /// Take one reading and push it onto the window. Synchronous — the caller
    /// does the GPU read before taking this lock, so no lock is ever held
    /// across an await.
    fn sample(
        &mut self,
        app_pid: Pid,
        runtime_pid: Option<Pid>,
        gpu: Option<GpuReading>,
    ) -> HardwareReading {
        self.sys.refresh_cpu_usage();

        let mut pids = vec![app_pid];
        if let Some(p) = runtime_pid {
            pids.push(p);
        }
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );

        // `Process::cpu_usage()` is summed across cores and can read ~1000% on
        // a 10-core machine. Dividing by the core count puts the per-process
        // figures on the same 0–100 scale as `global_cpu_usage()`, so app,
        // runtime and machine all read as shares of one machine — the way the
        // existing AKA / Model memory rows already read as shares of one total.
        let cores = self.sys.cpus().len().max(1) as f32;
        let app_cpu_percent = self
            .sys
            .process(app_pid)
            .map(|p| p.cpu_usage() / cores);
        let runtime = runtime_pid.and_then(|pid| self.sys.process(pid));
        let runtime_cpu_percent = runtime.map(|p| p.cpu_usage() / cores);
        let runtime_memory_mb = runtime.map(|p| p.memory() as f64 / (1024.0 * 1024.0));

        let reading = HardwareReading {
            at_ms: self.started.elapsed().as_millis() as u64,
            cpu_percent: self.sys.global_cpu_usage(),
            app_cpu_percent,
            runtime_cpu_percent,
            runtime_memory_mb,
            gpu_percent: gpu.map(|g| g.percent),
            gpu_memory_mb: gpu.map(|g| g.memory_mb),
        };

        if self.recent.len() == RECENT_WINDOW_LEN {
            self.recent.pop_front();
        }
        self.recent.push_back(reading);
        reading
    }

    /// The window as the frontend sees it. `None` until the first sample.
    fn stats(&self) -> Option<HardwareStats> {
        let current = *self.recent.back()?;
        Some(HardwareStats {
            current,
            recent: self.recent.iter().copied().collect(),
        })
    }
}

/// Read the current window. A pure read — sampling is owned entirely by
/// `run_sampler`, so polling this at any rate can never disturb the CPU delta.
/// `None` before the first sample (no model loaded yet), which the UI renders
/// as dashes.
#[tauri::command]
pub fn get_hardware_stats(sampler: State<'_, Mutex<HardwareSampler>>) -> Option<HardwareStats> {
    let s = sampler.lock().unwrap_or_else(|e| e.into_inner());
    s.stats()
}

/// Background sampling loop, spawned once at startup.
///
/// Runs for the life of the app. It deliberately does *not* wait for a model
/// to be loaded: machine CPU and GPU are properties of the machine, and gating
/// them on a loaded model left every row blank exactly when someone opened the
/// panel to find out why their machine was busy. The per-process rows are
/// separately optional and simply stay absent while there is no sidecar.
///
/// Cost is one sub-millisecond `sysinfo` refresh plus one ~20 ms `ioreg` fork
/// per second — about 0.2% of a 10-core machine.
pub async fn run_sampler(app: AppHandle) {
    let app_pid = Pid::from_u32(std::process::id());
    let mut ticker = tokio::time::interval(SAMPLE_INTERVAL);

    loop {
        ticker.tick().await;

        // Copy the PID out and drop the guard before any await — a lock held
        // across one would deadlock against the sidecar's own spawn/restart
        // paths. `None` whenever the runtime is down or restarting, which the
        // reading records as absent rather than as zero.
        let runtime_pid = {
            let state = app.state::<Mutex<SidecarState>>();
            let s = state.lock().unwrap_or_else(|e| e.into_inner());
            s.child.as_ref().map(|c| Pid::from_u32(c.pid()))
        };

        let gpu = read_gpu().await;

        let state = app.state::<Mutex<HardwareSampler>>();
        let mut sampler = state.lock().unwrap_or_else(|e| e.into_inner());
        sampler.sample(app_pid, runtime_pid, gpu);
    }
}

// ── GPU (macOS) ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub struct GpuReading {
    pub percent: f32,
    pub memory_mb: f64,
}

/// Read GPU utilization and memory from IOAccelerator's performance
/// statistics.
///
/// Shelling out to `ioreg` keeps this a runtime-only dependency — the same
/// posture as the CUDA `libloading` probe and the `ps` RSS read — instead of
/// linking IOKit + CoreFoundation at build time and hand-rolling CFDictionary
/// FFI to save a measured 20 ms. Works without admin rights.
#[cfg(target_os = "macos")]
async fn read_gpu() -> Option<GpuReading> {
    let out = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::process::Command::new("ioreg")
            .args(["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"])
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    parse_ioreg(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(target_os = "macos"))]
async fn read_gpu() -> Option<GpuReading> {
    None
}

/// Pull utilization and in-use memory out of `ioreg`'s output.
///
/// Returns `None` for anything unexpected — a machine with no IOAccelerator
/// node, a driver that omits the keys, a future format change. Never an error.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_ioreg(output: &str) -> Option<GpuReading> {
    // Intel Macs expose two IOAccelerator nodes (integrated + discrete); take
    // the first that actually carries performance statistics.
    let block = output
        .lines()
        .find_map(|line| line.split_once("\"PerformanceStatistics\" = {"))
        .map(|(_, rest)| rest)?;
    let block = block.split_once('}').map_or(block, |(body, _)| body);

    let percent = read_stat(block, "Device Utilization %")? as f32;
    let memory_bytes = read_stat(block, "In use system memory")?;
    Some(GpuReading {
        percent,
        memory_mb: memory_bytes as f64 / (1024.0 * 1024.0),
    })
}

/// Read `"<key>"=<integer>` out of an ioreg dictionary body.
///
/// The closing quote in the needle is load-bearing: the same block contains
/// `"In use system memory (driver)"=0`, which appears *before* the key we
/// want. A plain substring search would match that one and silently read 0.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn read_stat(block: &str, key: &str) -> Option<u64> {
    let needle = format!("\"{key}\"=");
    let start = block.find(&needle)? + needle.len();
    let digits: String = block[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `ioreg` block, trimmed to the keys we read. Key order matters:
    /// the `(driver)` variant precedes the one we want, exactly as it does on
    /// a live machine.
    const SAMPLE: &str = r#"+-o AGXAcceleratorG16G  <class AGXAcceleratorG16G, id 0x100000417>
    {
      "IOMatchedAtBoot" = Yes
      "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=3191701504,"Tiler Utilization %"=24,"recoveryCount"=0,"Renderer Utilization %"=23,"Device Utilization %"=22,"In use system memory"=651132928}
      "model" = "Apple M4"
    }"#;

    #[test]
    fn reads_utilization_and_memory() {
        let g = parse_ioreg(SAMPLE).expect("parses");
        assert_eq!(g.percent, 22.0);
        // 651132928 bytes = 621 MB — NOT the 0 from the `(driver)` key that
        // appears earlier in the same block.
        assert!((g.memory_mb - 621.0).abs() < 1.0, "got {}", g.memory_mb);
    }

    #[test]
    fn does_not_match_the_driver_variant() {
        assert_eq!(read_stat(SAMPLE, "In use system memory"), Some(651132928));
        assert_eq!(read_stat(SAMPLE, "In use system memory (driver)"), Some(0));
    }

    #[test]
    fn degrades_to_none_rather_than_erroring() {
        assert!(parse_ioreg("").is_none());
        assert!(parse_ioreg("no accelerator here").is_none());
        // Block present but missing the keys we need.
        assert!(parse_ioreg(r#""PerformanceStatistics" = {"recoveryCount"=0}"#).is_none());
    }

    #[test]
    fn window_is_capped_and_drops_oldest() {
        let mut s = HardwareSampler::default();
        let pid = Pid::from_u32(std::process::id());
        for _ in 0..(RECENT_WINDOW_LEN + 25) {
            s.sample(pid, None, None);
        }
        assert_eq!(s.recent.len(), RECENT_WINDOW_LEN);
        let stats = s.stats().expect("has readings");
        assert_eq!(stats.recent.len(), RECENT_WINDOW_LEN);
        // The window is ordered oldest-first and `current` is its tail.
        assert_eq!(
            stats.current.at_ms,
            stats.recent.last().expect("non-empty").at_ms
        );
    }

    /// Demonstrates that the sampler reads real CPU under real load, and
    /// prints the readings. `#[ignore]`d because it burns cores for a few
    /// seconds and its numbers depend on what else the machine is doing — run
    /// it deliberately:
    ///
    /// ```text
    /// cargo test --lib hardware_stats -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "burns CPU for ~4s; run on demand"]
    fn reads_real_cpu_under_load() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let stop = Arc::new(AtomicBool::new(false));
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let stop = Arc::clone(&stop);
                std::thread::spawn(move || {
                    let mut x: u64 = 0;
                    while !stop.load(Ordering::Relaxed) {
                        x = x.wrapping_mul(6364136223846793005).wrapping_add(1);
                    }
                    x
                })
            })
            .collect();

        // `read_gpu` forks a subprocess via tokio, which needs a reactor.
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");

        let mut s = HardwareSampler::default();
        let pid = Pid::from_u32(std::process::id());
        let mut readings = Vec::new();
        for _ in 0..4 {
            std::thread::sleep(SAMPLE_INTERVAL);
            let r = s.sample(pid, None, rt.block_on(read_gpu()));
            println!(
                "t={:>5}ms  machine={:>5.1}%  aka={:>5.1}%  gpu={}  gpu_mem={}",
                r.at_ms,
                r.cpu_percent,
                r.app_cpu_percent.unwrap_or(-1.0),
                r.gpu_percent
                    .map_or("none".to_string(), |v| format!("{v:.0}%")),
                r.gpu_memory_mb
                    .map_or("none".to_string(), |v| format!("{v:.0}MB")),
            );
            readings.push(r);
        }

        stop.store(true, Ordering::Relaxed);
        for w in workers {
            let _ = w.join();
        }

        // The bug this guards: a System rebuilt per read always reads 0%,
        // because CPU usage is a delta between two refreshes.
        assert!(
            readings.iter().any(|r| r.cpu_percent > 0.0),
            "machine CPU never rose above zero under load: {readings:?}"
        );
        assert!(
            readings
                .iter()
                .any(|r| r.app_cpu_percent.unwrap_or(0.0) > 0.0),
            "this process's CPU never rose above zero while burning 4 cores"
        );
    }

    #[test]
    fn stats_are_none_before_the_first_sample() {
        assert!(HardwareSampler::default().stats().is_none());
    }

    #[test]
    fn per_process_cpu_is_normalised_to_the_machine() {
        let mut s = HardwareSampler::default();
        let pid = Pid::from_u32(std::process::id());
        let r = s.sample(pid, None, None);
        // Machine-wide is already 0-100; the per-process figure is divided by
        // the core count so it lands on the same scale rather than the
        // per-core one that can exceed 100.
        assert!((0.0..=100.0).contains(&r.cpu_percent), "{}", r.cpu_percent);
        if let Some(app) = r.app_cpu_percent {
            assert!((0.0..=100.0).contains(&app), "{app}");
        }
        assert!(r.runtime_cpu_percent.is_none());
        assert!(r.gpu_percent.is_none());
    }
}
