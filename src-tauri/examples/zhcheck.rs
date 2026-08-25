//! 中文识别验证：用 Windows TTS 合成一段中文语音，走 base 模型 zh 通道
//! 验证：语言固定 zh + 简体引导 prompt + 幻觉过滤 后的输出
//! cargo run --release --example zhcheck
use std::time::Instant;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1) 列出语音 + 用 zh-CN 声音合成 WAV（16kHz 16bit 单声道）
    let script = r#"
Add-Type -AssemblyName System.Speech;
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
$voices = $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture };
Write-Output ($voices -join "`n");
"#;
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-c", script])
        .output()?;
    let voices = String::from_utf8_lossy(&out.stdout).to_string();
    println!("已安装语音:\n{voices}");
    if !voices.to_lowercase().contains("zh-cn") && !voices.contains("中文") && !voices.to_lowercase().contains("huihui") && !voices.to_lowercase().contains("yaoyao") {
        println!("（未安装中文 TTS 语音，跳过）");
        return Ok(());
    }

    let wav_path = std::env::temp_dir().join("speaknow_zh.wav");
    let synth = format!(
        r#"
Add-Type -AssemblyName System.Speech;
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
$s.SelectVoice((($s.GetInstalledVoices() | Where-Object {{ $_.VoiceInfo.Culture.Name -eq 'zh-CN' }})[0]).VoiceInfo.Name);
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);
$s.SetOutputToWaveFile('{}', $fmt);
$s.Speak('今天我们开会讨论一下项目的进度，然后把任务分配给各个同事。');
$s.Dispose();
"#,
        wav_path.display()
    );
    let st = std::process::Command::new("powershell")
        .args(["-NoProfile", "-c", &synth])
        .status()?;
    if !st.success() {
        anyhow::bail!("TTS 合成失败");
    }

    // 2) 解码 WAV（找 data 块，兼容 44 字节头）
    let wav = std::fs::read(&wav_path)?;
    let data_pos = wav
        .windows(4)
        .position(|w| w == b"data")
        .ok_or_else(|| anyhow::anyhow!("WAV 无 data 块"))?;
    let payload = &wav[data_pos + 8..];
    let samples: Vec<i16> = payload
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();
    println!(
        "\n合成音频: {} 采样点（16kHz ≈ {:.1}s）",
        samples.len(),
        samples.len() as f64 / 16000.0
    );
    let peak = samples.iter().map(|s| s.abs()).max().unwrap_or(0);
    let rms = (samples.iter().map(|s| (*s as f64) * (*s as f64)).sum::<f64>()
        / samples.len().max(1) as f64)
        .sqrt();
    let nonzero = samples.iter().filter(|s| **s != 0).count();
    println!(
        "幅度诊断: 峰值 {peak}/32767 ({:.1}%), RMS {rms:.1}, 非零 {nonzero}/{}",
        peak as f64 / 32767.0 * 100.0,
        samples.len()
    );
    if peak < 500 {
        println!("⚠ TTS 输出几乎静音 —— TTS 合成有问题，不是识别问题");
        return Ok(());
    }

    // 3) base 模型识别（zh 固定 → 走简体引导 prompt）
    let root = models_dir();
    let t = Instant::now();
    let text = speaknow_lib::local_whisper::transcribe_in(&root, "base", &samples, "zh")?;
    println!("zh 识别结果: {text:?}");
    println!("耗时: {:.2}s", t.elapsed().as_secs_f32());

    // 对照：auto 模式
    let t2 = Instant::now();
    let text_auto = speaknow_lib::local_whisper::transcribe_in(&root, "base", &samples, "auto")?;
    println!("auto 识别结果: {text_auto:?}（{:.2}s）", t2.elapsed().as_secs_f32());
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
