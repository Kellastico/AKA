pub mod agent_runner;
pub mod checkpoints;
pub mod dev_server;
pub mod diff;
pub mod files;
pub mod llm;
pub mod models;
pub mod project_config;
pub mod shell;
pub mod shell_run;
pub mod tokens;
pub mod verify;

#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}
