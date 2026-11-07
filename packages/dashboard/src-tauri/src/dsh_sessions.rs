//! DSH (DeepSeek Harness) session-log reader.
//!
//! DSH persists each session as a zstd-compressed JSONL event log under
//! `$DSH_HOME/sessions/<cwd-slug>/<sessionId>/`, newest format first:
//!   - `session.v4.jsonl.zstd` (current)
//!   - `session.v3.jsonl.zstd` (previous format, same reader vocabulary)
//!   - `session.jsonl.zstd`    (legacy v2)
//! `DSH_HOME` overrides the default `~/.dsh`. A missing home or missing
//! session tree degrades to an empty list — the dashboard must never fail
//! because DSH is not installed.
//!
//! Unlike Pi (flat `sessions/<project>/<file>.jsonl`), the DSH layout adds a
//! session-directory level, and every log is a zstd frame. Event vocabulary
//! (verified against live v4 logs, spec 002 spike T012):
//!   - first line `{type:"session", id, cwd, createdAt, …}` (header, no `time`)
//!   - `{type:"session/title", time, data:{title}}`
//!   - `{type:"user/message"|"system/message"|"assistant/message"|"tool/result",
//!      seq, time, data:{content:[{type:"text",text}], id|message, usage?}}`
//!   - assistant `data.usage = {inputTokens, outputTokens, cacheReadTokens,
//!     cacheWriteTokens?, totalTokens}` — input excludes cached tokens, the
//!     same accounting convention as Pi.
//!   - `{type:"request/header", data:{header:{config:{provider, model}}}}`
//!     names the serving model for the steps that follow it.
//!   - `{type:"compaction/summary", time, data:{compactionId, summary:[…]}}`
//!
//! NOTE: this module is not compiler-verified yet (no cargo in the build
//! sandbox at authoring time); see spec 002 T077.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
pub struct DshSessionMeta {
    pub session_id: String,
    pub log_path: PathBuf,
    pub cwd: String,
    pub created: i64,
    pub modified: i64,
    pub message_count: u32,
    /// From the `session/title` event when the host recorded one.
    pub title: Option<String>,
    pub first_message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DshSessionDetail {
    pub meta: DshSessionMeta,
    pub messages: Vec<DshMessage>,
    pub compaction_entries: Vec<DshCompactionEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DshMessage {
    pub entry_id: String,
    pub timestamp_ms: i64,
    pub role: String,
    pub text_preview: String,
    pub usage: Option<DshUsage>,
    /// Serving provider/model from the last preceding `request/header`.
    pub provider: Option<String>,
    pub model: Option<String>,
    pub raw_json: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct DshUsage {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DshCompactionEntry {
    pub entry_id: String,
    pub timestamp_ms: i64,
    pub summary: String,
    pub raw_json: Value,
}

/// Log file names in read priority order (newest format first).
const LOG_FILE_NAMES: [&str; 3] = [
    "session.v4.jsonl.zstd",
    "session.v3.jsonl.zstd",
    "session.jsonl.zstd",
];

/// DSH maintenance runs (memory consolidation etc.) share the session-log
/// format but are never user-facing primary sessions. They are identified by
/// their session-id prefix and always surface as subagent rows.
pub fn is_maintenance_session_id(session_id: &str) -> bool {
    session_id.starts_with("session-mc-maint-")
}

/// `$DSH_HOME` when set (non-blank), else `~/.dsh`. `None` only when the home
/// directory cannot be determined at all.
pub fn resolve_dsh_home() -> Option<PathBuf> {
    let from_env = std::env::var_os("DSH_HOME")
        .map(|value| value.to_string_lossy().trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    from_env.or_else(|| dirs::home_dir().map(|home| home.join(".dsh")))
}

fn sessions_root() -> Option<PathBuf> {
    resolve_dsh_home().map(|home| home.join("sessions"))
}

/// Test hook: drops both caches so a test that repoints `DSH_HOME` never
/// sees entries left behind by an earlier scan of the real home.
pub fn clear_caches_for_tests() {
    if let Ok(mut cache) = meta_cache().write() {
        cache.clear();
    }
    if let Ok(mut cache) = detail_cache().write() {
        cache.entries.clear();
    }
}

/// Every session the DSH home holds, newest activity first. Sessions whose
/// log cannot be read are skipped rather than guessed at.
pub fn scan_dsh_session_dir() -> Vec<DshSessionMeta> {
    let Some(root) = sessions_root() else {
        return Vec::new();
    };
    scan_dsh_session_dir_at(&root)
}

pub fn scan_dsh_session_dir_at(root: &Path) -> Vec<DshSessionMeta> {
    let mut metas = Vec::new();
    let Ok(slugs) = fs::read_dir(root) else {
        return metas;
    };
    for slug in slugs.flatten() {
        if !slug.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Ok(session_dirs) = fs::read_dir(slug.path()) else {
            continue;
        };
        for dir in session_dirs.flatten() {
            if !dir.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let Some(log_path) = pick_log_file(&dir.path()) else {
                continue;
            };
            if let Some(meta) = read_dsh_session_meta(&log_path) {
                metas.push(meta);
            }
        }
    }
    metas.sort_by_key(|meta| std::cmp::Reverse(meta.modified));
    metas
}

/// Newest-format log inside one session directory, or `None` when absent.
fn pick_log_file(session_dir: &Path) -> Option<PathBuf> {
    LOG_FILE_NAMES
        .iter()
        .map(|name| session_dir.join(name))
        .find(|path| path.is_file())
}

/// Locate one session's log by id. The session directory carries the id, so
/// this is a directory walk, not a content search.
pub fn find_dsh_session_log(session_id: &str) -> Option<PathBuf> {
    scan_dsh_session_dir()
        .into_iter()
        .find(|meta| meta.session_id == session_id)
        .map(|meta| meta.log_path)
}

type MetaCache = HashMap<PathBuf, (SystemTime, Arc<DshSessionMeta>)>;

/// Parsed session details kept between the dashboard's polls, mirroring
/// `pi_sessions`' detail cache but without a parent chain: a DSH log holds its
/// whole history in one file.
#[derive(Default)]
struct DetailCache {
    entries: HashMap<PathBuf, CachedDetail>,
    inserted: u64,
}

struct CachedDetail {
    stamp: SystemTime,
    detail: Arc<DshSessionDetail>,
    inserted: u64,
}

/// Details of sessions recently viewed. Each can hold a full transcript with
/// raw JSON, so only a handful are kept.
const MAX_CACHED_DETAILS: usize = 16;

static META_CACHE: OnceLock<RwLock<MetaCache>> = OnceLock::new();
static DETAIL_CACHE: OnceLock<RwLock<DetailCache>> = OnceLock::new();

fn meta_cache() -> &'static RwLock<MetaCache> {
    META_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn detail_cache() -> &'static RwLock<DetailCache> {
    DETAIL_CACHE.get_or_init(|| RwLock::new(DetailCache::default()))
}

pub fn read_dsh_session_meta(path: &Path) -> Option<DshSessionMeta> {
    let mtime = file_mtime(path)?;
    if let Ok(cache) = meta_cache().read() {
        if let Some((cached_mtime, cached)) = cache.get(path) {
            if *cached_mtime == mtime {
                return Some((**cached).clone());
            }
        }
    }
    let meta = Arc::new(read_dsh_session_meta_uncached(path, mtime)?);
    if let Ok(mut cache) = meta_cache().write() {
        cache.insert(path.to_path_buf(), (mtime, Arc::clone(&meta)));
    }
    Some((*meta).clone())
}

/// The session's full transcript, shared rather than cloned: the dashboard
/// polls the Messages and Cache tabs every second while a session is open.
pub fn read_dsh_session_detail(path: &Path) -> Option<Arc<DshSessionDetail>> {
    let mtime = file_mtime(path)?;
    if let Ok(cache) = detail_cache().read() {
        if let Some(cached) = cache.entries.get(path) {
            if cached.stamp == mtime {
                return Some(Arc::clone(&cached.detail));
            }
        }
    }
    let detail = Arc::new(read_dsh_session_detail_uncached(path, mtime)?);
    if let Ok(mut cache) = detail_cache().write() {
        if !cache.entries.contains_key(path) && cache.entries.len() >= MAX_CACHED_DETAILS {
            if let Some(oldest) = cache
                .entries
                .iter()
                .min_by_key(|(_, cached)| cached.inserted)
                .map(|(path, _)| path.clone())
            {
                cache.entries.remove(&oldest);
            }
        }
        cache.inserted += 1;
        cache.entries.insert(
            path.to_path_buf(),
            CachedDetail {
                stamp: mtime,
                detail: Arc::clone(&detail),
                inserted: cache.inserted,
            },
        );
    }
    Some(detail)
}

fn read_dsh_session_meta_uncached(path: &Path, mtime: SystemTime) -> Option<DshSessionMeta> {
    let text = decode_log(path)?;
    let mut acc = MetaAccumulator::new(session_dir_name(path));
    for line in text.lines() {
        let Some(event) = parse_json_line(line) else {
            continue;
        };
        acc.consume(&event);
        // Header + title + first user text all seen: stop before the bulk.
        if acc.header_seen && acc.title_seen && !acc.first_message.is_empty() {
            break;
        }
    }
    let mut meta = acc.finish(mtime, path.to_path_buf())?;
    // The cheap pass cannot know the total; keep the count from a full parse
    // when one happened before, else count what this pass saw. Message count
    // is informational only (mirrors PiSessionMeta).
    meta.message_count = meta.message_count.max(acc.message_count);
    Some(meta)
}

fn read_dsh_session_detail_uncached(path: &Path, mtime: SystemTime) -> Option<DshSessionDetail> {
    let text = decode_log(path)?;
    let mut acc = MetaAccumulator::new(session_dir_name(path));
    let mut provider: Option<String> = None;
    let mut model: Option<String> = None;
    let mut messages: Vec<DshMessage> = Vec::new();
    let mut compaction_entries: Vec<DshCompactionEntry> = Vec::new();
    for line in text.lines() {
        let Some(event) = parse_json_line(line) else {
            continue;
        };
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "request/header" => {
                let config = event.pointer("/data/header/config");
                provider = config
                    .and_then(|c| c.get("provider"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned);
                model = config
                    .and_then(|c| c.get("model"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned);
            }
            "user/message" | "system/message" | "assistant/message" | "tool/result" => {
                let data = event.get("data").cloned().unwrap_or(Value::Null);
                let role = kind
                    .split('/')
                    .next()
                    .unwrap_or(kind)
                    .to_ascii_lowercase();
                let entry_id = message_entry_id(&event).unwrap_or_default();
                let usage = if role == "assistant" {
                    parse_usage(&data)
                } else {
                    None
                };
                messages.push(DshMessage {
                    entry_id,
                    timestamp_ms: event.get("time").and_then(Value::as_i64).unwrap_or(0),
                    role,
                    text_preview: content_text(&data),
                    usage,
                    provider: provider.clone(),
                    model: model.clone(),
                    raw_json: event.clone(),
                });
            }
            "compaction/summary" => {
                let data = event.get("data").cloned().unwrap_or(Value::Null);
                compaction_entries.push(DshCompactionEntry {
                    entry_id: data
                        .get("compactionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    timestamp_ms: event.get("time").and_then(Value::as_i64).unwrap_or(0),
                    summary: join_text_parts(data.get("summary")),
                    raw_json: event.clone(),
                });
            }
            _ => {}
        }
        acc.consume(&event);
    }
    let mut meta = acc.finish(mtime, path.to_path_buf())?;
    meta.message_count = messages.len() as u32;
    Some(DshSessionDetail {
        meta,
        messages,
        compaction_entries,
    })
}

/// Accumulates the fields both passes need from the event stream. The cheap
/// meta pass stops early; the detail pass consumes everything and only the
/// metadata fields survive.
struct MetaAccumulator {
    dir_name: String,
    session_id: Option<String>,
    cwd: String,
    created: i64,
    title: Option<String>,
    first_message: String,
    message_count: u32,
    header_seen: bool,
    title_seen: bool,
}

impl MetaAccumulator {
    fn new(dir_name: String) -> Self {
        Self {
            dir_name,
            session_id: None,
            cwd: String::new(),
            created: 0,
            title: None,
            first_message: String::new(),
            message_count: 0,
            header_seen: false,
            title_seen: false,
        }
    }

    fn consume(&mut self, event: &Value) {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "session" if !self.header_seen => {
                self.header_seen = true;
                self.session_id = event
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .or_else(|| Some(self.dir_name.clone()));
                self.cwd = event
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                self.created = event.get("createdAt").and_then(Value::as_i64).unwrap_or(0);
            }
            "session/title" if !self.title_seen => {
                // Record the event as seen even without a usable title: the
                // host emits it once, at most.
                self.title_seen = true;
                self.title = event
                    .pointer("/data/title")
                    .and_then(Value::as_str)
                    .map(clean_title)
                    .filter(|title| !title.is_empty());
            }
            "user/message" => {
                if self.first_message.is_empty() {
                    self.first_message = content_text(event.get("data").unwrap_or(&Value::Null));
                }
                self.message_count += 1;
            }
            "assistant/message" | "system/message" | "tool/result" => {
                self.message_count += 1;
            }
            _ => {}
        }
    }

    fn finish(&self, mtime: SystemTime, log_path: PathBuf) -> Option<DshSessionMeta> {
        // A log without the header line is not a session we can name.
        self.header_seen.then(|| DshSessionMeta {
            session_id: self
                .session_id
                .clone()
                .unwrap_or_else(|| self.dir_name.clone()),
            log_path,
            cwd: self.cwd.clone(),
            created: self.created,
            modified: to_ms(mtime),
            message_count: self.message_count,
            title: self.title.clone(),
            first_message: self.first_message.clone(),
        })
    }
}

/// Stable id for a message event: the host's own message id when present
/// (the same id the plugin records as a compartment boundary), the tool call
/// id for tool results, else the event ordinal so ordering stays stable.
fn message_entry_id(event: &Value) -> Option<String> {
    let data = event.get("data")?;
    data.get("message")
        .and_then(|message| message.get("id"))
        .and_then(Value::as_str)
        .or_else(|| data.get("id").and_then(Value::as_str))
        .or_else(|| data.get("toolCallId").and_then(Value::as_str))
        .map(str::to_owned)
        .or_else(|| {
            event
                .get("seq")
                .and_then(Value::as_i64)
                .map(|seq| format!("seq:{seq}"))
        })
}

fn parse_usage(data: &Value) -> Option<DshUsage> {
    let usage = data.get("usage")?;
    let field = |key: &str| usage.get(key).and_then(Value::as_i64).unwrap_or(0);
    Some(DshUsage {
        input: field("inputTokens"),
        output: field("outputTokens"),
        cache_read: field("cacheReadTokens"),
        cache_write: field("cacheWriteTokens"),
        total: field("totalTokens"),
    })
}

/// Flatten a message/tool event's text parts into one preview line.
fn content_text(data: &Value) -> String {
    join_text_parts(data.get("content"))
}

fn join_text_parts(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    let raw = match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| match part {
                Value::String(text) => Some(text.as_str()),
                _ => part
                    .get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.get("content").and_then(Value::as_str)),
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    };
    normalize_preview(&raw)
}

/// Collapse whitespace, drop control characters, cap at 500 chars — the same
/// final pass `pi_sessions`/`db::normalize_preview` apply to previews.
fn normalize_preview(text: &str) -> String {
    text.chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(500)
        .collect()
}

fn clean_title(title: &str) -> String {
    title.trim().to_string()
}

fn parse_json_line(line: &str) -> Option<Value> {
    if line.trim().is_empty() {
        return None;
    }
    serde_json::from_str(line).ok()
}

/// Decode a session log's zstd frame into UTF-8 text. A partial write, an
/// unsupported frame, or invalid UTF-8 all degrade to `None` (skip session).
fn decode_log(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let decoded = zstd::stream::decode_all(BufReader::new(file)).ok()?;
    String::from_utf8(decoded).ok()
}

fn session_dir_name(path: &Path) -> String {
    path.parent()
        .and_then(|parent| parent.file_name())
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok()?.modified().ok()
}

fn to_ms(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}
