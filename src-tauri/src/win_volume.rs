//! Windows 采集端点音量（IAudioEndpointVolume）读取 / 设置
//! 以及驱动层硬件 dB 增益（DeviceTopology → IAudioVolumeLevel，如 Mic Boost / 麦克风加强）
#![cfg(target_os = "windows")]

use windows::core::{Interface, IUnknown};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, Endpoints::IAudioEndpointVolume, IAudioVolumeLevel, IConnector,
    IDeviceTopology, IMMDevice, IMMDeviceCollection, IMMDeviceEnumerator, IPart,
    IPartsList, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    STGM_READ,
};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;

pub struct EndpointInfo {
    pub name: String,
    pub volume: f32, // 0.0~1.0
    pub muted: bool,
}

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

fn enumerator() -> windows::core::Result<IMMDeviceEnumerator> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

fn friendly_name(dev: &IMMDevice) -> Option<String> {
    unsafe {
        let store: IPropertyStore = dev.OpenPropertyStore(STGM_READ).ok()?;
        let prop = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
        let ptr = prop.Anonymous.Anonymous.Anonymous.pwszVal;
        let s = if ptr.is_null() {
            String::new()
        } else {
            ptr.to_string().unwrap_or_default()
        };
        Some(s)
    }
}

fn read_endpoint(dev: &IMMDevice) -> Option<EndpointInfo> {
    unsafe {
        let ep: IAudioEndpointVolume = dev.Activate(CLSCTX_ALL, None).ok()?;
        let volume = ep.GetMasterVolumeLevelScalar().ok()?;
        let muted = ep.GetMute().ok().map(|b| b.as_bool()).unwrap_or(false);
        let name = friendly_name(dev).unwrap_or_default();
        Some(EndpointInfo { name, volume, muted })
    }
}

/// 所有可用采集端点（名称 + 音量 + 静音）
pub fn list_capture_volumes() -> Vec<EndpointInfo> {
    let _com = match ComGuard::new() {
        Ok(g) => g,
        Err(_) => return vec![],
    };
    let mut out = vec![];
    unsafe {
        let Ok(en) = enumerator() else {
            return out;
        };
        let Ok(col) = en.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) else {
            return out;
        };
        let col: IMMDeviceCollection = col;
        let Ok(count) = col.GetCount() else {
            return out;
        };
        for i in 0..count {
            if let Ok(dev) = col.Item(i) {
                if let Some(info) = read_endpoint(&dev) {
                    out.push(info);
                }
            }
        }
    }
    out
}

/// 匹配目标端点：优先名称包含指定设备名的；未命中则用默认端点
fn target_device(
    en: &IMMDeviceEnumerator,
    device: Option<&str>,
) -> Option<(IMMDevice, String)> {
    unsafe {
        match device {
            Some(n) if !n.is_empty() => {
                let col = en.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE).ok()?;
                let col: IMMDeviceCollection = col;
                let count = col.GetCount().ok()?;
                for i in 0..count {
                    let dev = col.Item(i).ok()?;
                    let fname = friendly_name(&dev).unwrap_or_default();
                    if fname.contains(n) {
                        return Some((dev, fname));
                    }
                }
                // 未匹配到指定名称：回退默认端点
                let d = en.GetDefaultAudioEndpoint(eCapture, eConsole).ok()?;
                let name = friendly_name(&d).unwrap_or_default();
                Some((d, name))
            }
            _ => {
                let d = en.GetDefaultAudioEndpoint(eCapture, eConsole).ok()?;
                let name = friendly_name(&d).unwrap_or_default();
                Some((d, name))
            }
        }
    }
}

/// 读取（端点名, 音量0~1, 是否静音）
pub fn get_volume(device: Option<&str>) -> Option<(String, f32, bool)> {
    let _com = ComGuard::new().ok()?;
    let en = enumerator().ok()?;
    let (dev, name) = target_device(&en, device)?;
    let info = read_endpoint(&dev)?;
    let name = if name.is_empty() { info.name } else { name };
    Some((name, info.volume, info.muted))
}

/// 设置端点音量（0~1），可选同时解除静音
pub fn set_volume(device: Option<&str>, volume: f32, unmute: bool) -> Option<()> {
    let _com = ComGuard::new().ok()?;
    let en = enumerator().ok()?;
    let (dev, _) = target_device(&en, device)?;
    unsafe {
        let ep: IAudioEndpointVolume = dev.Activate(CLSCTX_ALL, None).ok()?;
        ep.SetMasterVolumeLevelScalar(volume.clamp(0.0, 1.0), std::ptr::null()).ok()?;
        if unmute {
            ep.SetMute(false, std::ptr::null()).ok()?;
        }
    }
    Some(())
}

/* ---------- 驱动层硬件 dB 增益（DeviceTopology） ---------- */

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HwLevel {
    /// 子单元名（如 "Mic Boost" / "Microphone Volume"）
    pub name: String,
    pub channels: u32,
    pub min_db: f32,
    pub max_db: f32,
    pub step_db: f32,
    pub cur_db: f32,
}

fn part_name(p: &IPart) -> String {
    unsafe {
        p.GetName()
            .map(|w| {
                let s = w.to_string().unwrap_or_default();
                windows::Win32::System::Com::CoTaskMemFree(Some(w.as_ptr() as _));
                s
            })
            .unwrap_or_default()
    }
}

fn push_part(p: IPart, visited: &mut Vec<*mut core::ffi::c_void>, queue: &mut Vec<IPart>) {
    let key = unsafe { p.as_raw() };
    if !visited.contains(&key) {
        visited.push(key);
        queue.push(p);
    }
}

/// 枚举设备拓扑里的所有 IAudioVolumeLevel 子单元（硬件 dB 增益/麦克风加强）
fn hw_levels_in(dev: &IMMDevice) -> Vec<HwLevel> {
    let mut out: Vec<HwLevel> = Vec::new();
    unsafe {
        let Ok(topo) = dev.Activate::<IDeviceTopology>(CLSCTX_ALL, None) else {
            return out;
        };
        let Ok(count) = topo.GetConnectorCount() else {
            return out;
        };

        // BFS：从端点拓扑的连接器走到相邻（适配器）拓扑，再沿 EnumPartsIncoming 深入
        let mut visited: Vec<*mut core::ffi::c_void> = Vec::new();
        let mut queue: Vec<IPart> = Vec::new();
        for i in 0..count {
            let Ok(conn) = topo.GetConnector(i) else { continue };
            let Ok(peer) = conn.GetConnectedTo() else { continue };
            if let Ok(p) = peer.cast::<IPart>() {
                push_part(p, &mut visited, &mut queue);
            }
        }

        while let Some(p) = queue.pop() {
            // 该子单元若实现 IAudioVolumeLevel，记录其 dB 范围
            if let Ok(vol) = p.cast::<IAudioVolumeLevel>() {
                let (mut min, mut max, mut step) = (0f32, 0f32, 0f32);
                if vol.GetChannelCount().unwrap_or(0) > 0
                    && vol.GetLevelRange(0, &mut min, &mut max, &mut step).is_ok()
                {
                    if let Ok(cur) = vol.GetLevel(0) {
                        let name = part_name(&p);
                        if !name.is_empty() {
                            out.push(HwLevel {
                                name,
                                channels: vol.GetChannelCount().unwrap_or(1),
                                min_db: min,
                                max_db: max,
                                step_db: step,
                                cur_db: cur,
                            });
                        }
                    }
                }
            }
            // 继续向物理插孔方向遍历
            if let Ok(list) = p.EnumPartsIncoming() {
                if let Ok(n) = list.GetCount() {
                    for i in 0..n {
                        if let Ok(sub) = list.GetPart(i) {
                            push_part(sub, &mut visited, &mut queue);
                        }
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| {
        b.max_db
            .partial_cmp(&a.max_db)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

/// 指定端点（默认）的硬件 dB 增益控件列表
pub fn hw_levels(device: Option<&str>) -> Vec<HwLevel> {
    let Ok(_com) = ComGuard::new() else {
        return vec![];
    };
    let Ok(en) = enumerator() else {
        return vec![];
    };
    match target_device(&en, device) {
        Some((dev, _)) => hw_levels_in(&dev),
        None => vec![],
    }
}

/// 设置某个硬件 dB 控件（按名称匹配），对齐到步进网格后写入所有声道
pub fn set_hw_level(device: Option<&str>, name: &str, db: f32) -> Option<f32> {
    let _com = ComGuard::new().ok()?;
    let en = enumerator().ok()?;
    let (dev, _) = target_device(&en, device)?;
    unsafe {
        let topo: IDeviceTopology = dev.Activate(CLSCTX_ALL, None).ok()?;
        let count = topo.GetConnectorCount().ok()?;
        for i in 0..count {
            let Ok(conn) = topo.GetConnector(i) else { continue };
            let Ok(peer) = conn.GetConnectedTo() else { continue };
            let Ok(p) = peer.cast::<IPart>() else { continue };
            if part_name(&p) == name {
                let vol = p.cast::<IAudioVolumeLevel>().ok()?;
                let (mut min, mut max, mut step) = (0f32, 0f32, 0f32);
                vol.GetLevelRange(0, &mut min, &mut max, &mut step).ok()?;
                let mut v = db.clamp(min, max);
                if step > 0.0 {
                    v = ((v - min) / step).round() * step + min;
                    v = v.clamp(min, max);
                }
                let chs = vol.GetChannelCount().ok().unwrap_or(1);
                for ch in 0..chs.max(1) {
                    vol.SetLevel(ch, v, None).ok()?;
                }
                return Some(v);
            }
        }
    }
    None
}
