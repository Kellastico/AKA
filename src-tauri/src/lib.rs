mod commands;
mod error;
mod hardware;
mod path_env;
mod sandbox;
mod sidecar;

use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Repair PATH before anything spawns or probes binaries — a Finder/Dock
    // launch inherits a minimal PATH that omits Homebrew/pip-user/etc., which
    // makes agent detection (`which`) and agent spawning miss tools the user
    // has in their terminal.
    path_env::fix();

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(commands::agent_runner::RunnerState::default())
        .manage(commands::checkpoints::CheckpointState::default())
        .manage(commands::dev_server::DevServerState::default())
        .manage(commands::files::WatcherState::default())
        .manage(commands::llm::LlmStreamState::default())
        .manage(commands::shell_run::ShellRunnerState::default())
        .manage(commands::models::DownloadState::default())
        .manage(sandbox::SandboxState::default())
        .manage(sandbox::PermissionState::default())
        .manage(Mutex::new(sidecar::SidecarState::default()))
        .setup(|app| {
            sandbox::install_permission_listener(app.handle());
            // Bring the built-in runtime up in the background — never block
            // app startup on it. Status reaches the UI via runtime:* events.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sidecar::spawn_sidecar(&handle).await {
                    tracing::error!("failed to start built-in runtime: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::agent_runner::run_agent,
            commands::agent_runner::stop_agent,
            commands::agent_runner::pause_agent,
            commands::agent_runner::resume_agent,
            commands::agent_runner::answer_agent,
            commands::agent_runner::detect_agents,
            commands::agent_runner::recheck_agents,
            commands::checkpoints::checkpoints_available,
            commands::checkpoints::create_checkpoint,
            commands::checkpoints::list_checkpoints,
            commands::checkpoints::run_file_changes,
            commands::checkpoints::restore_checkpoint,
            commands::checkpoints::clear_checkpoints,
            commands::llm::detect_runtimes,
            commands::llm::list_models,
            commands::llm::check_runtime_health,
            commands::llm::call_llm,
            commands::llm::call_llm_stream,
            commands::llm::stop_llm_stream,
            commands::llm::summarize_session,
            commands::project_config::load_config,
            commands::project_config::save_config,
            commands::tokens::count_tokens,
            commands::tokens::get_context_limit,
            commands::tokens::get_memory_usage,
            commands::verify::run_verify,
            commands::shell::open_external_url,
            commands::shell_run::shell_run,
            commands::shell_run::shell_stop,
            commands::dev_server::start_dev_server,
            commands::dev_server::stop_dev_server,
            commands::dev_server::dev_server_status,
            commands::dev_server::kill_port,
            commands::dev_server::clear_webview_cache,
            commands::diff::git_diff,
            commands::files::read_text_file,
            commands::files::read_image_base64,
            commands::files::write_text_file,
            commands::files::watch_file,
            commands::files::unwatch_file,
            commands::files::watch_dir,
            commands::files::unwatch_dir,
            commands::files::list_dir,
            commands::files::count_lines,
            commands::models::list_local_models,
            commands::models::download_model,
            commands::models::cancel_download,
            commands::models::delete_model,
            commands::models::import_model,
            hardware::get_hardware_profile,
            hardware::check_ram_for_model,
            sidecar::get_sidecar_status,
            sidecar::get_sidecar_port,
            sidecar::restart_runtime,
            sidecar::abort_runtime,
            sidecar::load_builtin_model,
            sidecar::unload_builtin_model,
            sidecar::enable_cuda_mode,
            sandbox::set_sandbox,
            sandbox::clear_sandbox,
            sandbox::current_sandbox,
            sandbox::request_path_access,
            sandbox::apply_diff,
        ])
        .build(tauri::generate_context!())
        .expect("error while building AKA")
        .run(|app, event| match event {
            // Kill the managed sidecar on any shutdown path so we never leave
            // an orphaned inference process behind.
            tauri::RunEvent::ExitRequested { .. } => sidecar::shutdown(app),
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Destroyed,
                ..
            } => sidecar::shutdown(app),
            _ => {}
        });
}
