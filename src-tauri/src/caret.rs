//! 悬浮窗锚点定位：让预览卡贴近「正在输入的输入框」而不是屏幕中央。
//! 定位链（逐级回退）：
//!   1. UI Automation TextPattern2/TextPattern 光标矩形（最精确，Electron/Chromium 开启无障碍时可用）
//!   2. GetGUIThreadInfo 原生 caret（Win32 原生输入框）
//!   3. 前台窗口底部启发式（ZCode/Codex/聊天类应用的输入框都在窗口底部）
//!   4. 鼠标位置（调用方回退）
#![allow(dead_code)]

pub struct TargetInfo {
    pub title: String,
    /// 锚点矩形（物理像素）：x, y, w, h
    pub anchor: (f64, f64, f64, f64),
    /// true = 精确光标；false = 窗口启发式
    pub precise: bool,
}

/// 计算悬浮窗物理坐标：优先锚点上方，空间不足放下方，最后夹紧工作区。
/// 返回 ((x, y, 是否在输入框上方), 目标窗口标题)
pub fn overlay_position(overlay_w: f64, overlay_h: f64) -> Option<((f64, f64, bool), String)> {
    let t = focused_anchor()?;
    position_for_anchor(&t, overlay_w, overlay_h).map(|pos| (pos, t.title))
}

#[cfg(not(target_os = "windows"))]
fn focused_anchor() -> Option<TargetInfo> {
    None
}

#[cfg(not(target_os = "windows"))]
fn position_for_anchor(_t: &TargetInfo, _w: f64, _h: f64) -> Option<(f64, f64, bool)> {
    None
}

#[cfg(target_os = "windows")]
mod imp {
    use super::TargetInfo;
    use windows::core::{BOOL, Interface};
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::Graphics::Gdi::{
        ClientToScreen, GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, SAFEARRAY, CLSCTX_ALL,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Ole::{SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound};
    use windows::Win32::UI::Accessibility::{
        IUIAutomation, IUIAutomationTextPattern, IUIAutomationTextPattern2, CUIAutomation,
        UIA_TextPatternId, UIA_PATTERN_ID,
    };
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetGUIThreadInfo, GetWindowTextW, GetWindowThreadProcessId,
        GUITHREADINFO,
    };

    /// 官方值 10024（本版 windows crate 未导出）
    const UIA_TEXT_PATTERN2_ID: UIA_PATTERN_ID = UIA_PATTERN_ID(10024);

    struct ComGuard;
    impl ComGuard {
        fn new() -> windows::core::Result<Self> {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
            Ok(ComGuard)
        }
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    fn window_title(hwnd: HWND) -> String {
        unsafe {
            let mut buf = [0u16; 256];
            let n = GetWindowTextW(hwnd, &mut buf);
            String::from_utf16_lossy(&buf[..n.max(0) as usize])
        }
    }

    /// 前台窗口矩形（优先 DWM 扩展边界，排除阴影）
    fn window_rect(hwnd: HWND) -> RECT {
        unsafe {
            let mut rect = RECT::default();
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut rect as *mut RECT as *mut core::ffi::c_void,
                std::mem::size_of::<RECT>() as u32,
            )
            .is_err()
            {
                let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect);
            }
            rect
        }
    }

    /// SAFEARRAY<f64> → 首个非空矩形
    fn parse_rect(psa: *mut SAFEARRAY) -> Option<(f64, f64, f64, f64)> {
        unsafe {
            if psa.is_null() {
                return None;
            }
            let mut lb = 0i32;
            let mut ub = 0i32;
            if let Ok(l) = SafeArrayGetLBound(psa, 1) {
                lb = l;
            }
            if let Ok(u) = SafeArrayGetUBound(psa, 1) {
                ub = u;
            }
            let n = (ub - lb + 1) as usize;
            if n < 4 {
                return None;
            }
            let mut vals = Vec::with_capacity(n);
            for i in 0..n.min(16) {
                let idx = (lb + i as i32) as i32;
                let mut v = 0f64;
                if SafeArrayGetElement(psa, &idx, &mut v as *mut f64 as *mut core::ffi::c_void)
                    .is_err()
                {
                    break;
                }
                vals.push(v);
            }
            for q in vals.chunks_exact(4) {
                if q[2] > 0.0 && q[3] > 0.0 {
                    return Some((q[0], q[1], q[2], q[3]));
                }
            }
            None
        }
    }

    pub fn focused_anchor() -> Option<TargetInfo> {
        let _com = ComGuard::new().ok()?;
        unsafe {
            let fg = GetForegroundWindow();
            let title = window_title(fg);
            if title.is_empty() {
                return None;
            }

            // 1) UIA 光标（TextPattern2 → TextPattern GetSelection）
            if let Ok(uia) = CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_ALL) {
                if let Ok(el) = uia.GetFocusedElement() {
                    if let Ok(unk) = el.GetCurrentPattern(UIA_TEXT_PATTERN2_ID) {
                        if let Ok(tp2) = unk.cast::<IUIAutomationTextPattern2>() {
                            let mut active = BOOL::default();
                            if let Ok(range) = tp2.GetCaretRange(&mut active) {
                                if let Ok(sa) = range.GetBoundingRectangles() {
                                    if let Some(r) = parse_rect(sa) {
                                        return Some(TargetInfo { title, anchor: r, precise: true });
                                    }
                                }
                            }
                        }
                    }
                    if let Ok(unk) = el.GetCurrentPattern(UIA_TextPatternId) {
                        if let Ok(tp) = unk.cast::<IUIAutomationTextPattern>() {
                            if let Ok(ranges) = tp.GetSelection() {
                                if let Ok(n) = ranges.Length() {
                                    for i in 0..n {
                                        if let Ok(range) = ranges.GetElement(i) {
                                            if let Ok(sa) = range.GetBoundingRectangles() {
                                                if let Some(r) = parse_rect(sa) {
                                                    return Some(TargetInfo {
                                                        title,
                                                        anchor: r,
                                                        precise: true,
                                                    });
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // 2) 原生 caret（Win32 输入框）
            let tid = GetWindowThreadProcessId(fg, None);
            let mut info = GUITHREADINFO {
                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            if GetGUIThreadInfo(tid, &mut info).is_ok() && !info.hwndCaret.is_invalid() {
                let r = info.rcCaret;
                if r.bottom > r.top {
                    let mut pt = POINT { x: r.left, y: r.bottom };
                    if ClientToScreen(info.hwndCaret, &mut pt).as_bool() {
                        return Some(TargetInfo {
                            title,
                            anchor: (pt.x as f64, pt.y as f64 - (r.bottom - r.top) as f64,
                                     (r.right - r.left).max(2) as f64,
                                     (r.bottom - r.top) as f64),
                            precise: true,
                        });
                    }
                }
            }

            // 3) 前台窗口底部启发式（聊天/编辑器类输入框在窗口底部）
            let wr = window_rect(fg);
            if wr.right > wr.left {
                let zone = 190.0f64; // 输入区高度估算（物理像素）
                return Some(TargetInfo {
                    title,
                    anchor: (
                        wr.left as f64,
                        wr.bottom as f64 - zone,
                        (wr.right - wr.left) as f64,
                        zone,
                    ),
                    precise: false,
                });
            }
        }
        None
    }

    /// 由锚点 + 悬浮窗逻辑尺寸计算物理坐标（贴合显示器工作区）
    /// 返回 (x, y, 是否放置在输入框上方)
    pub fn position_for_anchor(t: &TargetInfo, w: f64, h: f64) -> Option<(f64, f64, bool)> {
        unsafe {
            let (ax, ay, aw, ah) = t.anchor;
            let center = POINT {
                x: (ax + aw / 2.0) as i32,
                y: (ay + ah / 2.0) as i32,
            };
            let hmon = MonitorFromPoint(center, MONITOR_DEFAULTTONEAREST);
            if hmon.is_invalid() {
                return None;
            }
            let mut mi = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if !GetMonitorInfoW(hmon, &mut mi).as_bool() {
                return None;
            }
            let work = mi.rcWork;
            let (mut ux, mut uy) = (96u32, 96u32);
            let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut ux, &mut uy);
            let scale = ux as f64 / 96.0;
            let w = w * scale;
            let h = h * scale;

            // x：光标锚点左对齐；窗口启发式则水平居中
            let x = if t.precise {
                ax - 16.0
            } else {
                ax + aw / 2.0 - w / 2.0
            };
            // y：优先输入框上方
            let y_above = ay - h - 14.0;
            let (y, above) = if y_above >= work.top as f64 {
                (y_above, true)
            } else {
                (ay + ah + 14.0, false)
            };
            let x = x.clamp(
                (work.left as f64) + 8.0,
                (work.right as f64) - w - 8.0,
            );
            let y = y.clamp(
                (work.top as f64) + 8.0,
                (work.bottom as f64) - h - 8.0,
            );
            Some((x, y, above))
        }
    }
}

#[cfg(target_os = "windows")]
use imp::{focused_anchor, position_for_anchor};
