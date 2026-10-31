//! 记忆库离线导入诊断工具：不启动应用，把文档喂进（真实的）mem.json。
//!
//! 典型用途——「把当前项目的知识放进记忆库，让听写/召回带着项目上下文」：
//!   cargo run --example memimport -- README.md AGENTS.md docs
//! 与设置页导入走完全相同的分块/近重复合并/滚动清理（复用 import_paths_standalone），
//! 应用运行中下次读盘即见；未运行则下次启动可见。
//!
//! 参数：
//!   --dir <路径>   指定配置目录（默认 %APPDATA%\com.speaknow.app；其他平台必填）
//!   --dry          只统计不落盘
//!   其余参数       待导入的 .md/.txt 文件或目录（目录递归收集，上限与 UI 一致）
//! 返回：新增/合并/跳过摘要 + 新条目标题预览
use speaknow_lib::mem_import::import_paths_standalone;

fn main() {
    let mut dir = std::env::var_os("APPDATA")
        .map(|v| {
            let mut p = std::path::PathBuf::from(v);
            p.push("com.speaknow.app");
            p
        })
        .unwrap_or_default();
    let mut dry = false;
    let mut inputs: Vec<String> = Vec::new();
    let mut expect_dir = false;
    for a in std::env::args().skip(1) {
        if expect_dir {
            dir = a.into();
            expect_dir = false;
        } else if a == "--dir" {
            expect_dir = true;
        } else if a == "--dry" {
            dry = true;
        } else {
            inputs.push(a);
        }
    }
    if inputs.is_empty() || dir.as_os_str().is_empty() {
        eprintln!(
            "用法：cargo run --example memimport -- [--dir <配置目录>] [--dry] <文件或目录...>\n\
             默认目录仅 Windows 有效（%APPDATA%\\com.speaknow.app），其他平台请用 --dir 指定"
        );
        std::process::exit(2);
    }
    match import_paths_standalone(&dir, &inputs, "SpeakNow", dry) {
        Ok((s, titles)) => {
            println!(
                "目标：{}{}\n新增 {} · 合并 {} · 跳过 {}",
                dir.display(),
                if dry { "（dry，未落盘）" } else { "" },
                s.added,
                s.merged,
                s.skipped
            );
            for t in titles.iter().take(12) {
                println!("  + {t}");
            }
            if titles.len() > 12 {
                println!("  … 共 {} 条", titles.len());
            }
        }
        Err(e) => {
            eprintln!("导入失败：{e}");
            std::process::exit(1);
        }
    }
}
