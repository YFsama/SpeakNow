//! 验证应用真实模型目录里的 base 模型能正常识别（release 运行）
//! cargo run --release --example asrcheck
use std::time::Instant;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let root = models_dir();
    let jfk = std::env::temp_dir().join("speaknow_jfk.wav");
    if !jfk.exists() {
        let bytes = reqwest::get(
            "https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav",
        )
        .await?
        .bytes()
        .await?;
        std::fs::write(&jfk, &bytes)?;
    }
    let wav = std::fs::read(&jfk)?;
    // 跳过 44 字节 WAV 头取 PCM
    let samples: Vec<i16> = wav[44..]
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();
    println!("样本: {} 个采样点（16kHz）", samples.len());

    for round in 1..=3 {
        let t = Instant::now();
        let text = speaknow_lib::local_whisper::transcribe_in(&root, "base", &samples, "en")?;
        println!(
            "第 {round} 次 → 耗时 {:.2}s | {text:?}",
            t.elapsed().as_secs_f32()
        );
    }
    Ok(())
}

/// 应用数据目录下的模型目录（%APPDATA%\com.speaknow.app\models）
fn models_dir() -> std::path::PathBuf {
    let base = std::env::var("APPDATA")
        .or_else(|_| std::env::var("HOME"))
        .expect("无法定位用户目录");
    std::path::PathBuf::from(base)
        .join("com.speaknow.app")
        .join("models")
}
