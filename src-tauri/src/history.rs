use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const MAX_ITEMS: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub ts: i64,
    pub raw: String,
    #[serde(rename = "final")]
    pub final_text: String,
    #[serde(default)]
    pub asr_ms: Option<u64>,
    #[serde(default)]
    pub llm_ms: Option<u64>,
}

fn path(app: &AppHandle) -> anyhow::Result<std::path::PathBuf> {
    Ok(app.path().app_config_dir()?.join("history.json"))
}

fn write(app: &AppHandle, items: &[HistoryItem]) {
    if let Ok(p) = path(app) {
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(items) {
            let _ = crate::config::atomic_write(&p, json.as_bytes());
        }
    }
    let _ = app.emit("sn-history-changed", ());
}

pub fn load(app: &AppHandle) -> Vec<HistoryItem> {
    path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn push(app: &AppHandle, raw: &str, final_text: &str, asr_ms: u64, llm_ms: u64) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut items = load(app);
    items.insert(
        0,
        HistoryItem {
            ts,
            raw: raw.into(),
            final_text: final_text.into(),
            asr_ms: if asr_ms > 0 { Some(asr_ms) } else { None },
            llm_ms: if llm_ms > 0 { Some(llm_ms) } else { None },
        },
    );
    items.truncate(MAX_ITEMS);
    write(app, &items);
}

pub fn find_raw(app: &AppHandle, ts: i64) -> Option<String> {
    load(app)
        .into_iter()
        .find(|i| i.ts == ts)
        .map(|i| i.raw)
}

/// 重新优化后更新某条记录的结果
pub fn update_final(app: &AppHandle, ts: i64, text: &str) -> Option<()> {
    let mut items = load(app);
    let item = items.iter_mut().find(|i| i.ts == ts)?;
    item.final_text = text.to_string();
    write(app, &items);
    Some(())
}

pub fn delete(app: &AppHandle, ts: i64) {
    let mut items = load(app);
    items.retain(|i| i.ts != ts);
    write(app, &items);
}

pub fn clear(app: &AppHandle) {
    if let Ok(p) = path(app) {
        let _ = fs::remove_file(p);
    }
    let _ = app.emit("sn-history-changed", ());
}
