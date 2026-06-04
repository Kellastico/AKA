//! Build script for the ÄKÄ runtime.
//!
//! `llama-cpp-sys-2` compiles llama.cpp (a large C++ library) from source via
//! CMake on first build — expect 3–10 minutes initially, fast incrementally.
//!
//! Backend selection (Metal on Apple Silicon) is done through a target-specific
//! cargo feature in `Cargo.toml`, NOT here: a build script's `rustc-cfg` output
//! only affects *this* crate's conditional compilation and cannot enable a
//! dependency's cargo feature. All this script does is make sure the final
//! binary links against the C++ standard library that llama.cpp needs.

fn main() {
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-lib=c++");

    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-lib=stdc++");
}
