//! 隔离诊断（二阶段）：
//! 阶段1：默认扬声器放音，并发采集所有输入设备
//! 阶段2：逐个输出设备放音，观察哪些输入设备能听到（ROG 耳机自发声→自带麦克风应能采到）
//! 运行：cargo run --example devtest
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, Stream, StreamConfig, SupportedStreamConfig};

#[derive(Clone)]
struct Stat {
    samples: Arc<AtomicU32>,
    nonzero: Arc<AtomicU32>,
    peak: Arc<Mutex<Vec<f32>>>,
    level: Arc<AtomicU32>,
}

fn new_stat(ch: usize) -> Stat {
    Stat {
        samples: Arc::new(AtomicU32::new(0)),
        nonzero: Arc::new(AtomicU32::new(0)),
        peak: Arc::new(Mutex::new(vec![0.0; ch])),
        level: Arc::new(AtomicU32::new(0)),
    }
}

fn process(data: &[f32], ch: usize, st: &Stat) {
    if data.is_empty() {
        return;
    }
    let ch = ch.max(1);
    st.samples.fetch_add(data.len() as u32, Ordering::Relaxed);
    let mut nz = 0u32;
    {
        let mut peak = st.peak.lock().unwrap();
        for (i, s) in data.iter().enumerate() {
            if *s != 0.0 {
                nz += 1;
            }
            let c = i % ch;
            let m = s.abs();
            if m > peak[c] {
                peak[c] = m;
            }
        }
    }
    st.nonzero.fetch_add(nz, Ordering::Relaxed);
    let rms = (data.iter().map(|s| s * s).sum::<f32>() / data.len() as f32).sqrt();
    st.level
        .store(((rms * 1000.0) as u32).min(1000), Ordering::Relaxed);
}

fn err_fn(e: cpal::StreamError) {
    eprintln!("[devtest] 流错误: {e}");
}

/// 用 cpal 打开一个输入设备的采集流；返回 (流, 统计)
fn open_input(dev: &Device, name: &str) -> Option<(Stream, Stat, String)> {
    let cfg = dev.default_input_config().ok()?;
    let desc = format!(
        "{:?} {}Hz {}ch",
        cfg.sample_format(),
        cfg.sample_rate().0,
        cfg.channels()
    );
    let ch = cfg.channels().max(1) as usize;
    let st = new_stat(ch);
    let config: StreamConfig = cfg.clone().into();
    let sf = cfg.sample_format();
    let stream = (|| -> Option<Stream> {
        let s = match sf {
            cpal::SampleFormat::F32 => dev
                .build_input_stream(
                    &config,
                    {
                        let st = st.clone();
                        move |d: &[f32], _| process(d, ch, &st)
                    },
                    err_fn,
                    None,
                )
                .ok()?,
            cpal::SampleFormat::I16 => dev
                .build_input_stream(
                    &config,
                    {
                        let st = st.clone();
                        move |d: &[i16], _| {
                            let conv: Vec<f32> =
                                d.iter().map(|v| *v as f32 / 32768.0).collect();
                            process(&conv, ch, &st)
                        }
                    },
                    err_fn,
                    None,
                )
                .ok()?,
            cpal::SampleFormat::U16 => dev
                .build_input_stream(
                    &config,
                    {
                        let st = st.clone();
                        move |d: &[u16], _| {
                            let conv: Vec<f32> = d
                                .iter()
                                .map(|v| (*v as f32 - 32768.0) / 32768.0)
                                .collect();
                            process(&conv, ch, &st)
                        }
                    },
                    err_fn,
                    None,
                )
                .ok()?,
            other => {
                println!("跳过输入 [{name}]: 暂不支持 {other:?}");
                return None;
            }
        };
        s.play().ok()?;
        Some(s)
    })();
    stream.map(|s| (s, st, desc))
}

/// 打开一个输出设备播放 440Hz 全幅音
fn open_output_tone(dev: &Device, name: &str, secs: f64) -> Option<Stream> {
    let cfg: SupportedStreamConfig = dev.default_output_config().ok()?;
    let rate = cfg.sample_rate().0 as f32;
    let ch = cfg.channels().max(1) as usize;
    let config: StreamConfig = cfg.clone().into();
    let sf = cfg.sample_format();
    let idx = Arc::new(AtomicU64::new(0));
    let stream = (|| -> Option<Stream> {
        let s = match sf {
            cpal::SampleFormat::F32 => dev
                .build_output_stream(
                    &config,
                    {
                        let idx = idx.clone();
                        move |d: &mut [f32], _| {
                            let mut i = idx.load(Ordering::Relaxed);
                            for f in d.chunks_mut(ch) {
                                let v =
                                    ((i as f32 * 440.0 * 2.0 * std::f32::consts::PI
                                        / rate)
                                        .sin()
                                        * 0.9)
                                        .clamp(-1.0, 1.0);
                                for s in f.iter_mut() {
                                    *s = v;
                                }
                                i += 1;
                            }
                            idx.store(i, Ordering::Relaxed);
                        }
                    },
                    err_fn,
                    None,
                )
                .ok()?,
            cpal::SampleFormat::I16 => dev
                .build_output_stream(
                    &config,
                    {
                        let idx = idx.clone();
                        move |d: &mut [i16], _| {
                            let mut i = idx.load(Ordering::Relaxed);
                            for f in d.chunks_mut(ch) {
                                let v = ((i as f32 * 440.0 * 2.0
                                    * std::f32::consts::PI
                                    / rate)
                                    .sin()
                                    * 28000.0) as i16;
                                for s in f.iter_mut() {
                                    *s = v;
                                }
                                i += 1;
                            }
                            idx.store(i, Ordering::Relaxed);
                        }
                    },
                    err_fn,
                    None,
                )
                .ok()?,
            other => {
                println!("跳过输出 [{name}]: 暂不支持 {other:?}");
                return None;
            }
        };
        s.play().ok()?;
        Some(s)
    })();
    let _ = secs;
    stream
}

fn run_round(host: &cpal::Host, label: &str, out_dev: Option<&Device>, secs: u64) {
    println!("\n======== {label} ========");
    let mut streams: Vec<Stream> = Vec::new();
    let mut infos: Vec<(String, String, Stat)> = Vec::new();
    for dev in host.input_devices().unwrap() {
        let name = dev.name().unwrap_or_default();
        if let Some((s, st, desc)) = open_input(&dev, &name) {
            streams.push(s);
            infos.push((name, desc, st));
        }
    }
    let mut out_stream = None;
    if let Some(dev) = out_dev {
        let name = dev.name().unwrap_or_default();
        match open_output_tone(dev, &name, secs as f64) {
            Some(s) => {
                println!("→ 正在通过输出设备 [{name}] 放音 {secs} 秒…");
                out_stream = Some(s);
            }
            None => println!("→ 输出设备 [{name}] 无法打开"),
        }
    }

    let begin = Instant::now();
    while begin.elapsed() < Duration::from_secs(secs) {
        std::thread::sleep(Duration::from_millis(500));
        let line: Vec<String> = infos
            .iter()
            .map(|(n, _, s)| {
                format!("{n}: {:.1}%", s.level.load(Ordering::Relaxed) as f32 / 10.0)
            })
            .collect();
        println!("  [{:>4.1}s] {}", begin.elapsed().as_secs_f32(), line.join(" | "));
    }
    drop(out_stream);
    drop(streams);

    for (name, desc, st) in &infos {
        let samples = st.samples.load(Ordering::Relaxed);
        let nz = st.nonzero.load(Ordering::Relaxed);
        let nzpct = if samples > 0 {
            nz as f64 / samples as f64 * 100.0
        } else {
            0.0
        };
        let peaks: Vec<String> = st
            .peak
            .lock()
            .unwrap()
            .iter()
            .map(|p| format!("{:.2}%", (p * 100.0).min(100.0)))
            .collect();
        let verdict = if samples == 0 {
            "无数据回调!"
        } else if st.peak.lock().unwrap().iter().all(|p| *p < 0.01) {
            "静音级(<1%)"
        } else {
            "★ 有信号"
        };
        println!("  [{name}] {desc} — 采样 {samples} · 非零 {nzpct:.1}% · 峰值 {} · {verdict}", peaks.join(" "));
    }
}

fn main() {
    let host = cpal::default_host();
    if let Some(d) = host.default_input_device() {
        println!("cpal 默认输入设备: {}", d.name().unwrap_or_default());
    }
    if let Some(d) = host.default_output_device() {
        println!("cpal 默认输出设备: {}", d.name().unwrap_or_default());
    }
    let outputs: Vec<Device> = host.output_devices().unwrap().collect();
    println!("共 {} 个输出设备", outputs.len());

    // 阶段1：默认输出放音
    let default_out = host.default_output_device();
    run_round(&host, "阶段1：默认输出设备放音", default_out.as_ref(), 5);

    // 阶段2：逐个输出设备放音（含 ROG 耳机自身 —— boom 麦克风紧贴耳罩，必能采到）
    for dev in &outputs {
        let name = dev.name().unwrap_or_default();
        let is_default = default_out
            .as_ref()
            .and_then(|d| d.name().ok())
            .map(|n| n == name)
            .unwrap_or(false);
        if is_default {
            continue; // 阶段1已测
        }
        run_round(&host, &format!("阶段2：输出设备 [{name}] 放音"), Some(dev), 4);
    }
    println!("\n完成");
}
