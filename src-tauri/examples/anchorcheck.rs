//! 验证悬浮窗锚点定位：打印当前前台窗口的锚点与悬浮窗计算坐标
//! cargo run --release --example anchorcheck
fn main() {
    match speaknow_lib::caret::overlay_position(520.0, 320.0) {
        Some(((x, y, above), title)) => {
            let side = if above { "上方" } else { "下方" };
            println!("目标窗口: {title:?}");
            println!("悬浮窗坐标: ({x:.0}, {y:.0})，置于输入框{side}");
        }
        None => println!("未能获取锚点"),
    }
}
