/// 把 16bit PCM 单声道采样编码为最简 WAV 文件字节流（44 字节头 + data）
pub fn encode(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let mut buf = Vec::with_capacity(44 + data_len);

    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&(36 + data_len as u32).to_le_bytes());
    buf.extend_from_slice(b"WAVE");

    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes()); // fmt 块长度
    buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
    buf.extend_from_slice(&1u16.to_le_bytes()); // 单声道
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // 字节率
    buf.extend_from_slice(&2u16.to_le_bytes()); // 块对齐
    buf.extend_from_slice(&16u16.to_le_bytes()); // 位深

    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&(data_len as u32).to_le_bytes());
    for s in samples {
        buf.extend_from_slice(&s.to_le_bytes());
    }
    buf
}
