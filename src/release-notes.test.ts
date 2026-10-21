import { describe, expect, it } from 'vitest';
import { fmtBytes, releaseNotesItems } from './release-notes';

describe('releaseNotesItems', () => {
  it('解析 CI 生成的标准 Release body', () => {
    const body = [
      '## Changes',
      '',
      '- 新增 GitHub 自动更新',
      '- 配置导入导出增强',
      '',
      '---',
      'Full changelog: https://github.com/YFsama/SpeakNow/blob/main/CHANGELOG.md',
    ].join('\n');
    expect(releaseNotesItems(body)).toEqual([
      '新增 GitHub 自动更新',
      '配置导入导出增强',
    ]);
  });

  it('空 body / 尾注缺失时不报错', () => {
    expect(releaseNotesItems('')).toEqual([]);
    expect(releaseNotesItems('- 单条')).toEqual(['单条']);
  });

  it('保留非列表的普通文本行', () => {
    expect(releaseNotesItems('说明段落\n- 条目')).toEqual(['说明段落', '条目']);
  });
});

describe('fmtBytes', () => {
  it('分档取整', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2 KB');
    expect(fmtBytes(15 * 1024 * 1024)).toBe('15.0 MB');
    expect(fmtBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB');
  });
});
