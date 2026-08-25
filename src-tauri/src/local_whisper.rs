// 内置离线 ASR：基于 candle 的纯 Rust Whisper（移植自 candle 官方示例）
// 模型文件下载到 {app_config_dir}/models/{id}/，首次使用需联网，之后完全离线
use std::collections::HashMap;
use std::path::{Path as Path2, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use byteorder::{LittleEndian, ReadBytesExt};
use candle_core::{Device, IndexOp, Tensor, D};
use candle_nn::ops::softmax;
use candle_transformers::models::whisper::{self as m, audio};
use candle_transformers::quantized_var_builder as qvb;
use rand::distr::weighted::WeightedIndex;
use rand::distr::Distribution;
use rand::rngs::StdRng;
use rand::SeedableRng;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokenizers::Tokenizer;

use crate::asr::truncate;

/// 80 维 Mel 滤波器（与上游 candle 示例同源，嵌入二进制，免运行时下载）
static MEL_FILTERS: LazyLock<Vec<f32>> = LazyLock::new(|| {
    let bytes = include_bytes!("melfilters.bytes");
    let mut buf = vec![0f32; bytes.len() / 4];
    let mut rdr = std::io::Cursor::new(bytes);
    if rdr.read_f32_into::<LittleEndian>(&mut buf).is_err() {
        panic!("melfilters.bytes 解析失败");
    }
    buf
});

/* ---------- 模型目录 ---------- */

pub struct LocalModelDef {
    pub id: &'static str,
    pub name: &'static str,
    pub desc: &'static str,
    pub size_mb: u64,
    pub quantized: bool,
    /// HF 仓库路径（含 revision），如 "openai/whisper-base/resolve/main"
    pub prefix: &'static str,
    pub weights: &'static str,
    pub config_file: &'static str,
    pub tokenizer_file: &'static str,
}

pub const LOCAL_MODELS: &[LocalModelDef] = &[
    LocalModelDef {
        id: "tiny-q80",
        name: "Whisper Tiny 量化版",
        desc: "体积最小、速度最快；中文准确率一般，适合短语与命令",
        size_mb: 42,
        quantized: true,
        prefix: "lmz/candle-whisper/resolve/main",
        weights: "model-tiny-q80.gguf",
        config_file: "config-tiny.json",
        tokenizer_file: "tokenizer-tiny.json",
    },
    LocalModelDef {
        id: "base",
        name: "Whisper Base",
        desc: "推荐：中文效果与速度均衡（CPU 实时率约 0.5~1x）",
        size_mb: 291,
        quantized: false,
        prefix: "openai/whisper-base/resolve/main",
        weights: "model.safetensors",
        config_file: "config.json",
        tokenizer_file: "tokenizer.json",
    },
    LocalModelDef {
        id: "small",
        name: "Whisper Small",
        desc: "更准确；模型较大、CPU 较慢（适合追求准确率的场景）",
        size_mb: 967,
        quantized: false,
        prefix: "openai/whisper-small/resolve/main",
        weights: "model.safetensors",
        config_file: "config.json",
        tokenizer_file: "tokenizer.json",
    },
];

fn def(id: &str) -> Result<&'static LocalModelDef> {
    LOCAL_MODELS
        .iter()
        .find(|d| d.id == id)
        .ok_or_else(|| anyhow!("未知本地模型: {id}"))
}

pub fn models_root(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .context("无法定位配置目录")?
        .join("models"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelStatus {
    pub id: String,
    pub name: String,
    pub desc: String,
    pub size_mb: u64,
    pub downloaded: bool,
    /// 引擎类型：whisper（内置 candle）| qwen（llama.cpp 子进程）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// qwen 专用：llama.cpp 运行时是否已就绪
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_ready: Option<bool>,
    /// qwen 专用：运行时后端（vulkan / cpu）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
}

pub fn status(app: &AppHandle) -> Vec<LocalModelStatus> {
    status_in(models_root(app).ok().as_deref())
}

fn status_in(root: Option<&Path2>) -> Vec<LocalModelStatus> {
    LOCAL_MODELS
        .iter()
        .map(|d| {
            let downloaded = root
                .map(|r| {
                    let dir = r.join(d.id);
                    dir.join(d.weights).exists()
                        && dir.join(d.config_file).exists()
                        && dir.join(d.tokenizer_file).exists()
                })
                .unwrap_or(false);
            LocalModelStatus {
                id: d.id.into(),
                name: d.name.into(),
                desc: d.desc.into(),
                size_mb: d.size_mb,
                downloaded,
                kind: Some("whisper".into()),
                runtime_ready: None,
                backend: None,
            }
        })
        .collect()
}

/* ---------- 模型下载（带进度事件） ---------- */

static DOWNLOADING: AtomicBool = AtomicBool::new(false);

pub async fn download(app: &AppHandle, id: &str, mirror: &str) -> Result<()> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        bail!("已有模型下载任务进行中");
    }
    let root = models_root(app)?;
    let emit_app = app.clone();
    let result = download_to(&root, id, mirror, &move |file: &str, dl: u64, total: u64| {
        let _ = emit_app.emit(
            "sn-model-progress",
            serde_json::json!({
                "model": id,
                "file": file,
                "downloaded": dl,
                "total": total,
            }),
        );
    })
    .await;
    DOWNLOADING.store(false, Ordering::SeqCst);
    let _ = app.emit("sn-models-changed", ());
    result
}

/// 核心下载逻辑：root 为 models 根目录；on_progress(文件名, 已下载, 总量)
pub async fn download_to<F>(root: &Path2, id: &str, mirror: &str, on_progress: &F) -> Result<()>
where
    F: Fn(&str, u64, u64) + Send + Sync,
{
    let d = def(id)?;
    let dir = root.join(d.id);
    std::fs::create_dir_all(&dir)?;
    let base = mirror.trim().trim_end_matches('/');
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()?;

    // 小文件（配置/分词器）先下，随后是大权重文件
    for file in [d.config_file, d.tokenizer_file, d.weights] {
        let target = dir.join(file);
        if target.exists() {
            continue;
        }
        let url = format!("{base}/{}/{}", d.prefix, file);
        let resp = client
            .get(&url)
            .send()
            .await
            .with_context(|| format!("请求失败: {file}"))?;
        if !resp.status().is_success() {
            bail!(
                "下载 {} 失败: HTTP {}（可尝试更换下载镜像）",
                file,
                resp.status()
            );
        }
        let total = resp.content_length().unwrap_or(0);
        let part = dir.join(format!("{file}.part"));
        let mut writer = tokio::fs::File::create(&part)
            .await
            .context("创建临时文件失败")?;
        use tokio::io::AsyncWriteExt;
        let mut resp = resp;
        let mut downloaded: u64 = 0;
        let mut last_emit = std::time::Instant::now();
        while let Some(chunk) = resp.chunk().await? {
            writer.write_all(&chunk).await?;
            downloaded += chunk.len() as u64;
            if last_emit.elapsed() >= Duration::from_millis(150) {
                last_emit = std::time::Instant::now();
                on_progress(file, downloaded, total);
            }
        }
        writer.flush().await?;
        drop(writer);
        tokio::fs::rename(&part, &target).await?;
        on_progress(file, downloaded, total);
    }
    Ok(())
}

/* ---------- 模型加载与缓存 ---------- */

enum Model {
    Normal(m::model::Whisper),
    Quantized(m::quantized_model::Whisper),
}

impl Model {
    fn config(&self) -> &m::Config {
        match self {
            Model::Normal(mdl) => &mdl.config,
            Model::Quantized(mdl) => &mdl.config,
        }
    }
    fn is_multilingual(&self) -> bool {
        self.config().vocab_size == 51865
    }
    fn encoder_forward(&mut self, x: &Tensor, flush: bool) -> candle_core::Result<Tensor> {
        match self {
            Model::Normal(mdl) => mdl.encoder.forward(x, flush),
            Model::Quantized(mdl) => mdl.encoder.forward(x, flush),
        }
    }
    fn decoder_forward(
        &mut self,
        x: &Tensor,
        xa: &Tensor,
        flush: bool,
    ) -> candle_core::Result<Tensor> {
        match self {
            Model::Normal(mdl) => mdl.decoder.forward(x, xa, flush),
            Model::Quantized(mdl) => mdl.decoder.forward(x, xa, flush),
        }
    }
    fn decoder_final_linear(&self, x: &Tensor) -> candle_core::Result<Tensor> {
        match self {
            Model::Normal(mdl) => mdl.decoder.final_linear(x),
            Model::Quantized(mdl) => mdl.decoder.final_linear(x),
        }
    }
}

struct Cached {
    model: Model,
    tokenizer: Tokenizer,
}

static CACHE: LazyLock<Mutex<HashMap<String, Arc<Mutex<Cached>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn load_cached(root: &Path2, id: &str) -> Result<Arc<Mutex<Cached>>> {
    let d = def(id)?;
    let dir = root.join(id);
    for f in [d.config_file, d.tokenizer_file, d.weights] {
        let p = dir.join(f);
        if !p.exists() {
            bail!("本地模型 {id} 尚未下载（缺少 {f}）");
        }
    }
    if let Some(hit) = CACHE.lock().unwrap().get(id) {
        return Ok(hit.clone());
    }

    let cfg_text = std::fs::read_to_string(dir.join(d.config_file))?;
    let config: m::Config =
        serde_json::from_str(&cfg_text).context("解析模型 config.json 失败")?;
    let tokenizer = Tokenizer::from_file(dir.join(d.tokenizer_file))
        .map_err(|e| anyhow!("加载 tokenizer 失败: {e}"))?;

    let device = Device::Cpu;
    let model = if d.quantized {
        let vb = qvb::VarBuilder::from_gguf(&dir.join(d.weights), &device)?;
        Model::Quantized(m::quantized_model::Whisper::load(&vb, config)?)
    } else {
        let vb = unsafe {
            candle_nn::VarBuilder::from_mmaped_safetensors(
                &[dir.join(d.weights)],
                m::DTYPE,
                &device,
            )?
        };
        Model::Normal(m::model::Whisper::load(&vb, config)?)
    };

    let cached = Arc::new(Mutex::new(Cached { model, tokenizer }));
    CACHE
        .lock()
        .unwrap()
        .insert(id.to_string(), cached.clone());
    Ok(cached)
}

/* ---------- 解码器（移植自 candle 示例，简化：不带时间戳模式） ---------- */

const LANGUAGES: [(&str, &str); 99] = [
    ("en", "english"), ("zh", "chinese"), ("de", "german"), ("es", "spanish"),
    ("ru", "russian"), ("ko", "korean"), ("fr", "french"), ("ja", "japanese"),
    ("pt", "portuguese"), ("tr", "turkish"), ("pl", "polish"), ("ca", "catalan"),
    ("nl", "dutch"), ("ar", "arabic"), ("sv", "swedish"), ("it", "italian"),
    ("id", "indonesian"), ("hi", "hindi"), ("fi", "finnish"), ("vi", "vietnamese"),
    ("he", "hebrew"), ("uk", "ukrainian"), ("el", "greek"), ("ms", "malay"),
    ("cs", "czech"), ("ro", "romanian"), ("da", "danish"), ("hu", "hungarian"),
    ("ta", "tamil"), ("no", "norwegian"), ("th", "thai"), ("ur", "urdu"),
    ("hr", "croatian"), ("bg", "bulgarian"), ("lt", "lithuanian"), ("la", "latin"),
    ("mi", "maori"), ("ml", "malayalam"), ("cy", "welsh"), ("sk", "slovak"),
    ("te", "telugu"), ("fa", "persian"), ("lv", "latvian"), ("bn", "bengali"),
    ("sr", "serbian"), ("az", "azerbaijani"), ("sl", "slovenian"), ("kn", "kannada"),
    ("et", "estonian"), ("mk", "macedonian"), ("br", "breton"), ("eu", "basque"),
    ("is", "icelandic"), ("hy", "armenian"), ("ne", "nepali"), ("mn", "mongolian"),
    ("bs", "bosnian"), ("kk", "kazakh"), ("sq", "albanian"), ("sw", "swahili"),
    ("gl", "galician"), ("mr", "marathi"), ("pa", "punjabi"), ("si", "sinhala"),
    ("km", "khmer"), ("sn", "shona"), ("yo", "yoruba"), ("so", "somali"),
    ("af", "afrikaans"), ("oc", "occitan"), ("ka", "georgian"), ("be", "belarusian"),
    ("tg", "tajik"), ("sd", "sindhi"), ("gu", "gujarati"), ("am", "amharic"),
    ("yi", "yiddish"), ("lo", "lao"), ("uz", "uzbek"), ("fo", "faroese"),
    ("ht", "haitian creole"), ("ps", "pashto"), ("tk", "turkmen"), ("nn", "nynorsk"),
    ("mt", "maltese"), ("sa", "sanskrit"), ("lb", "luxembourgish"), ("my", "myanmar"),
    ("bo", "tibetan"), ("tl", "tagalog"), ("mg", "malagasy"), ("as", "assamese"),
    ("tt", "tatar"), ("haw", "hawaiian"), ("ln", "lingala"), ("ha", "hausa"),
    ("ba", "bashkir"), ("jw", "javanese"), ("su", "sundanese"),
];

fn token_id(tokenizer: &Tokenizer, token: &str) -> Result<u32> {
    tokenizer
        .token_to_id(token)
        .ok_or_else(|| anyhow!("tokenizer 缺少 token {token}"))
}

struct Decoder {
    cached: Arc<Mutex<Cached>>,
    tokenizer: Tokenizer,
    rng: StdRng,
}

struct Decoded {
    tokens: Vec<u32>,
    avg_logprob: f64,
    no_speech_prob: f64,
}

impl Decoder {
    /// 单段贪心/温度采样解码；返回内容 token、平均对数概率与静音概率
    fn decode(
        &mut self,
        mel: &Tensor,
        t: f64,
        language_token: Option<u32>,
        task_token: Option<u32>,
    ) -> Result<Decoded> {
        let sot = token_id(&self.tokenizer, m::SOT_TOKEN)?;
        let eot = token_id(&self.tokenizer, m::EOT_TOKEN)?;
        let no_speech_id =
            token_id(&self.tokenizer, m::NO_SPEECH_TOKENS[0])? as usize;
        let mut tokens: Vec<u32> = vec![sot];
        if let Some(t) = language_token {
            tokens.push(t);
        }
        if let Some(t) = task_token {
            tokens.push(t);
        }
        let n_prompt = tokens.len();
        let mut sum_logprob = 0f64;
        let mut no_speech_prob = 1f64;

        // 每段只做一次编码器前向；解码器交叉注意力使用其输出
        let audio_features = {
            let mut cached = self.cached.lock().unwrap();
            cached.model.encoder_forward(mel, true)?
        };

        // 注：candle 的 Whisper 解码器为位置编码重算设计，每步需喂完整序列（release 下速度足够）
        for step in 0..((self.config()?.max_target_positions - 1) / 2) {
            let (logits_raw, seq) = {
                let mut cached = self.cached.lock().unwrap();
                let cds =
                    Tensor::from_vec(tokens.clone(), (1, tokens.len()), mel.device())?;
                let ys = cached
                    .model
                    .decoder_forward(&cds, &audio_features, true)?;
                let seq = tokens.len();
                let logits = cached
                    .model
                    .decoder_final_linear(&ys.i((..1, seq - 1..))?)?
                    .flatten_all()?;
                (logits, seq)
            };
            let _ = seq;
            // candle 的 softmax 即 log-softmax
            let logprobs = softmax(&logits_raw, D::Minus1)?.to_vec1::<f32>()?;

            if step == 0 {
                no_speech_prob = logprobs
                    .get(no_speech_id)
                    .map(|v| v.exp() as f64)
                    .unwrap_or(1.0);
            }

            // 温度采样（t=0 时近似贪心）
            let pr = t.exp2() as f32;
            let mut cands: Vec<(usize, f64)> = logprobs
                .iter()
                .enumerate()
                .filter(|(_, v)| **v > -10.0)
                .map(|(i, v)| (i, ((*v as f64) * pr as f64).exp()))
                .collect();
            cands.sort_by(|a, b| b.1.total_cmp(&a.1));
            if cands.len() > 512 {
                cands.truncate(512);
            }
            let token = if t == 0.0 {
                cands[0].0 as u32
            } else {
                let dist = WeightedIndex::new(cands.iter().map(|(_, w)| *w))
                    .map_err(|e| anyhow!("{e}"))?;
                cands[dist.sample(&mut self.rng)].0 as u32
            };
            sum_logprob += logprobs[token as usize] as f64;
            tokens.push(token);
            if token == eot {
                break;
            }
        }

        let content: Vec<u32> = tokens[n_prompt..]
            .iter()
            .copied()
            .filter(|t| *t != eot)
            .collect();
        let n = content.len().max(1);
        Ok(Decoded {
            tokens: content,
            avg_logprob: sum_logprob / n as f64,
            no_speech_prob,
        })
    }

    fn decode_with_fallback(
        &mut self,
        mel: &Tensor,
        language_token: Option<u32>,
        task_token: Option<u32>,
    ) -> Result<Decoded> {
        let mut best: Option<Decoded> = None;
        for t in m::TEMPERATURES {
            let d = self.decode(mel, t, language_token, task_token)?;
            let ok = d.avg_logprob > m::LOGPROB_THRESHOLD
                && unique_ratio(&d.tokens) > 0.5;
            if ok {
                return Ok(d);
            }
            if d.avg_logprob > m::LOGPROB_THRESHOLD {
                best = Some(d); // 无重复但置信度略低，仍可接受
                break;
            }
            best = Some(d);
        }
        Ok(best.unwrap())
    }

    /// 自动检测语言（利用首段编码器输出对语言 token 做 argmax）
    fn detect_language(&mut self, mel: &Tensor) -> Result<u32> {
        let mut cached = self.cached.lock().unwrap();
        let seq_len = mel.dims3()?.2;
        let mel = mel.narrow(
            2,
            0,
            seq_len.min(cached.model.config().max_source_positions),
        )?;
        let lang_ids: Vec<u32> = LANGUAGES
            .iter()
            .map(|(code, _)| token_id(&self.tokenizer, &format!("<|{code}|>")))
            .collect::<Result<_>>()?;
        let device = mel.device();
        let sot = token_id(&self.tokenizer, m::SOT_TOKEN)?;
        let audio_features = cached.model.encoder_forward(&mel, true)?;
        let tokens = Tensor::new(&[[sot]], device)?;
        let lang_tensor = Tensor::new(lang_ids.as_slice(), device)?;
        let ys = cached.model.decoder_forward(&tokens, &audio_features, true)?;
        let logits = cached
            .model
            .decoder_final_linear(&ys.i(..1)?)?
            .i(0)?
            .i(0)?;
        let logits = logits.index_select(&lang_tensor, 0)?;
        let probs = softmax(&logits, D::Minus1)?.to_vec1::<f32>()?;
        let mut pairs: Vec<(usize, f32)> = probs.iter().copied().enumerate().collect();
        pairs.sort_by(|a, b| b.1.total_cmp(&a.1));
        Ok(lang_ids[pairs[0].0])
    }

    fn config(&self) -> Result<m::Config> {
        Ok(self.cached.lock().unwrap().model.config().clone())
    }
}

fn unique_ratio(tokens: &[u32]) -> f64 {
    if tokens.is_empty() {
        return 1.0;
    }
    let uniq = tokens.iter().collect::<std::collections::HashSet<_>>().len();
    uniq as f64 / tokens.len() as f64
}

/* ---------- 对外入口 ---------- */

pub fn transcribe(
    app: &AppHandle,
    id: &str,
    samples: &[i16],
    language: &str,
) -> Result<String> {
    transcribe_in(&models_root(app)?, id, samples, language)
}

pub fn transcribe_in(
    root: &Path2,
    id: &str,
    samples: &[i16],
    language: &str,
) -> Result<String> {
    let cached = load_cached(root, id)?;
    let tokenizer = cached.lock().unwrap().tokenizer.clone();
    let is_multilingual = cached.lock().unwrap().model.is_multilingual();

    let mut dec = Decoder {
        cached,
        tokenizer: tokenizer.clone(),
        rng: StdRng::seed_from_u64(42),
    };
    let pcm: Vec<f32> = samples.iter().map(|v| *v as f32 / 32768.0).collect();
    if pcm.is_empty() {
        bail!("音频内容为空");
    }

    // 30 秒分块
    let chunk_len = m::N_SAMPLES;
    let mut chunks: Vec<Vec<f32>> = pcm.chunks(chunk_len).map(|c| c.to_vec()).collect();
    if chunks.is_empty() {
        chunks.push(vec![0f32; 16_000]);
    }

    let device = Device::Cpu;
    let mut texts: Vec<String> = Vec::new();
    let mut detected: Option<u32> = None;
    let zh_lang_token = token_id(&tokenizer, "<|zh|>").ok();
    let zh_lang_token = LANGUAGES
        .iter()
        .find(|(c, _)| *c == "zh")
        .and_then(|_| token_id(&tokenizer, "<|zh|>").ok());

    for part in chunks {
        if part.len() < 800 {
            continue; // 过短的尾巴
        }
        let (mel_v, n_mel) = {
            let cfg = dec.config()?;
            if cfg.num_mel_bins != 80 {
                bail!("暂不支持 {} 维 Mel 的模型", cfg.num_mel_bins);
            }
            (audio::pcm_to_mel(&cfg, &part, &MEL_FILTERS), cfg.num_mel_bins)
        };
        let frames = mel_v.len() / n_mel;
        let mel = Tensor::from_vec(mel_v, (1, n_mel, frames), &device)?;

        let lang_token = if !is_multilingual {
            None
        } else {
            match language {
                "" | "auto" => {
                    if detected.is_none() {
                        detected = Some(dec.detect_language(&mel)?);
                    }
                    detected
                }
                code => Some(token_id(
                    &tokenizer,
                    &format!("<|{}|>", code.to_ascii_lowercase()),
                )?),
            }
        };
        let task_token = if is_multilingual {
            Some(token_id(&tokenizer, m::TRANSCRIBE_TOKEN)?)
        } else {
            None
        };

        let d = dec.decode_with_fallback(&mel, lang_token, task_token)?;
        let dbg_text = tokenizer.decode(&d.tokens, true).unwrap_or_default();
        eprintln!(
            "[speaknow] 段落: tokens={} logprob={:.2} nospeech={:.2} unique={:.2} text={:?}",
            d.tokens.len(),
            d.avg_logprob,
            d.no_speech_prob,
            unique_ratio(&d.tokens),
            dbg_text
        );
        if d.tokens.is_empty() {
            continue;
        }
        // 静音段跳过（防止幻听循环）
        if d.no_speech_prob > m::NO_SPEECH_THRESHOLD && d.avg_logprob < m::LOGPROB_THRESHOLD
        {
            continue;
        }
        // 强重复段视为幻觉丢弃（如静音下输出的 "Way, way, way."）
        if d.tokens.len() > 8 && unique_ratio(&d.tokens) < 0.5 {
            continue;
        }
        let text = tokenizer
            .decode(&d.tokens, true)
            .map_err(|e| anyhow!("解码文本失败: {e}"))?;
        if !text.trim().is_empty() {
            texts.push(text.trim().to_string());
        }
    }

    // Whisper 常输出繁体中文：指定或检测为中文时统一转为大陆简体（含常用词转换）
    let target_zh =
        language == "zh" || zh_lang_token.map(|z| detected == Some(z)).unwrap_or(false);
    let joined = texts.join("");
    if joined.is_empty() {
        return Ok(String::new());
    }
    let final_text = if target_zh {
        zhconv::zhconv(&joined, zhconv::Variant::ZhCN)
    } else {
        joined
    };
    Ok(truncate(&final_text, 4000))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// 端到端：下载 tiny 量化模型 + JFK 样本，真实推理
    /// 运行：cargo test --lib local_whisper -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "需要联网下载约 42MB 模型"]
    async fn e2e_tiny_q80_english() {
        let root = std::env::temp_dir().join("speaknow-test-models");
        let progress = |file: &str, dl: u64, total: u64| {
            println!("  ↓ {file}: {} KB / {} KB", dl / 1024, total / 1024);
        };
        download_to(&root, "tiny-q80", "https://hf-mirror.com", &progress)
            .await
            .expect("下载模型失败");

        let jfk_path = root.join("jfk.wav");
        if jfk_path.exists() && std::fs::metadata(&jfk_path).map(|m| m.len()).unwrap_or(0) < 1024 {
            let _ = std::fs::remove_file(&jfk_path);
        }
        if !jfk_path.exists() {
            let resp = reqwest::get(
                "https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav",
            )
            .await
            .expect("请求样本失败");
            assert!(resp.status().is_success(), "样本下载失败: {}", resp.status());
            let bytes = resp.bytes().await.expect("下载样本失败");
            std::fs::write(&jfk_path, &bytes).unwrap();
        }
        let wav = std::fs::read(&jfk_path).unwrap();
        println!("样本: {} KB", wav.len() / 1024);
        // 跳过 44 字节 WAV 头取 PCM
        let samples: Vec<i16> = wav[44..]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect();

        let t0 = Instant::now();
        let text = transcribe_in(&root, "tiny-q80", &samples, "en").expect("推理失败");
        println!("推理耗时 {}ms", t0.elapsed().as_millis());
        println!("识别结果: {text:?}");
        let low = text.to_lowercase();
        assert!(
            low.contains("fellow") || low.contains("americans") || low.contains("ask"),
            "识别结果异常: {text}"
        );
    }
}
