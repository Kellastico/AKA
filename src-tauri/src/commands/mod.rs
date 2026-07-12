pub mod agent_runner;
pub mod builtin_tools;
pub mod checkpoints;
pub mod compiler;
pub mod dev_server;
pub mod diff;
pub mod files;
pub mod llm;
pub mod mcp;
pub mod message_validator;
pub mod models;
pub mod probe;
pub mod project_config;
pub mod providers;
pub mod shell;
pub mod shell_run;
pub mod tokens;
pub mod verify;

#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}
