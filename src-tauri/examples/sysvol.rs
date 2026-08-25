//! 打印所有采集端点的系统音量与静音状态（诊断用）
//! 运行：cargo run --example sysvol
fn main() {
    #[cfg(target_os = "windows")]
    {
        let list = speaknow_lib::win_volume::list_capture_volumes();
        if list.is_empty() {
            println!("未枚举到任何采集端点");
            return;
        }
        for ep in &list {
            println!(
                "{}{} 音量 {:.0}%{}  {}",
                if ep.muted { "[静音]" } else { "[激活]" },
                "",
                ep.volume * 100.0,
                if ep.volume < 0.2 { "  ← 过低!" } else { "" },
                ep.name
            );
            println!("  ── 驱动硬件 dB 控件：");
            let levels = speaknow_lib::win_volume::hw_levels(Some(&ep.name));
            if levels.is_empty() {
                println!("     （未暴露任何 IAudioVolumeLevel 控件）");
            }
            for l in &levels {
                println!(
                    "     {}  {:.1}dB（范围 {:.1} ~ {:.1}，步进 {:.1}，{}ch）",
                    l.name, l.cur_db, l.min_db, l.max_db, l.step_db, l.channels
                );
            }
        }
        if let Some((name, vol, muted)) = speaknow_lib::win_volume::get_volume(None) {
            println!("\n默认采集端点：{}（音量 {:.0}%，静音={}）", name, vol * 100.0, muted);
        }
    }
    #[cfg(not(target_os = "windows"))]
    println!("仅 Windows 支持");
}
