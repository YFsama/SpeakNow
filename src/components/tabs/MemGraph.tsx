import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '../Controls';
import { copyText, memUsed } from '../../api';
import type { MemEntry } from '../../types';

/* ============ 记忆知识图谱（MemGraph，v5） ============
   Canvas 2D 力导向图，零新依赖：物理（斥力+弹簧+向心+模拟退火）与渲染都在本文件。
   - 关联模式：关键词-记忆二部图（关键词大小∝关联条数，记忆点按类型着色）
   - 主题模式：关键词共现图（同现于一条记忆的两个词连边，边宽∝共现次数）
   性能口径：收敛即冻结（平均位移<0.5px 连续 10 帧）——冻结后 rAF 空转，只有
   交互（拖/缩放/悬停）才置脏重绘；拖拽只重启被拖节点邻域。斥力用空间网格 +
   距离截断把每帧成本限制在近邻对上，500-2000 节点可稳在 60fps。 */

/* 类型色与 MemTab 的 KIND_CLS 同源（听写=sky / 取词=violet / 翻译=emerald /
   快记=amber / 网页=teal / 文件=rose）。Tailwind 类进不了 canvas，这里放同色系
   RGB；改色时两处同步 */
const KIND_RGB: Record<MemEntry['kind'], [number, number, number]> = {
  dictation: [56, 189, 248],
  ocr: [167, 139, 250],
  translate: [52, 211, 153],
  note: [251, 191, 36],
  web: [45, 212, 191],
  file: [251, 113, 133],
};
/* 弹层里的类型徽章用回 Tailwind 类（与 MemTab 卡片同款观感），同源注释见上 */
const KIND_CLS: Record<MemEntry['kind'], string> = {
  dictation: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
  ocr: 'border-violet-400/25 bg-violet-400/10 text-violet-300',
  translate: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  note: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  web: 'border-teal-400/25 bg-teal-400/10 text-teal-300',
  file: 'border-rose-400/25 bg-rose-400/10 text-rose-300',
};
const KIND_LABEL: Record<MemEntry['kind'], string> = {
  dictation: '听写',
  ocr: '取词',
  translate: '翻译',
  note: '快记',
  web: '网页',
  file: '文件',
};

const DAY = 86_400_000;

/* ---- 聚合上限（防大库把图画爆） ---- */
const TOP_KW = 40; // 关键词节点取度数 Top 40，长尾折叠进「其他 N 项」
const MAX_MEM_NODES = 800; // 关联模式记忆点上限：超出取最近的（度数真值仍按全量算）
const MAX_FOCUS_NODES = 300; // 钻取子图上限：一次性展开几千节点物理会卡死

/* ---- 物理参数（调研起点值，按 mock 与大库实测微调） ----
   L0 = sqrt(W*H/N) 每节点平均占地边长（理想间距，clamp 到 [14,220]）
   斥力 |F| = (0.6·L0)²/d × 0.16 × hub，hub = 1+log2(1+max(双节点度数))
   （斥力缩放偏大是实测结论：向心力 0.012 配 0.05 缩放时 14 节点会坍缩成
   150px 紧团，标签互相叠字；提到 0.16 后同图能铺开到 ~70% 画布）
   弹簧 F = 0.06×(d−L0)；向心 0.008×偏移；阻尼 0.85
   退火温度初值 clamp(L0,10,40)，每帧 ×0.97，单帧位移 clamp 在 ±temp */
const REP_SCALE = 0.16;
const K_REP = 0.6;
const REP_CUTOFF = 2.2; // × k_rep：斥力截断距离（超出后 <k/4.8，被弹簧/向心淹没）
const K_SPRING = 0.06;
const K_CENTER = 0.008;
const DAMPING = 0.85;
const TEMP_DECAY = 0.97;
const FREEZE_DISP = 0.5; // 平均位移阈值（px）
const FREEZE_FRAMES = 10; // 连续帧数

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/* ---- 动效无障碍（与 styles.css 的 S1 兜底同粒度）：系统「减少动态」时
   canvas 内的补间/呼吸直接取终值。媒体查询只在加载时读一次，会话内改
   设置需重载——零每帧开销的取舍 ---- */
const REDUCED =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---- 预渲染 sprite（G3 halo / G4 拖拽投影）：32×32 径向渐变各一张，
   中心 0.30 → 边缘 0；每帧 drawImage 比实时 createRadialGradient 便宜得多 ---- */
function makeRadialSprite(rgb: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, `rgba(${rgb},0.30)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
  }
  return c;
}
let haloSprite: HTMLCanvasElement | null = null; // amber 选中/悬停光晕
let shadowSprite: HTMLCanvasElement | null = null; // 黑色拖拽投影

/* ---- 背景点阵 tile（G7）：24×24 单个 1px 圆点，深浅主题各一张 ---- */
function makeDotTile(fill: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 24;
  c.height = 24;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = fill;
    g.beginPath();
    g.arc(12, 12, 1, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}
let dotTileDark: HTMLCanvasElement | null = null;
let dotTileLight: HTMLCanvasElement | null = null;

/** 确定性伪随机（mulberry32）：同一份数据每次重建得到同一初始布局，
 *  React 重挂载/切过滤器回来时图不会整体跳变 */
function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ================= 数据模型（纯函数，便于渲染空态文案复用） ================= */

interface Model {
  /** 时间档位过滤后的在世条目（软作废已在 MemTab 传入前滤掉） */
  items: MemEntry[];
  /** 关键词 → 关联条数（真值口径：半径按它而不是按可见边数，裁剪记忆点不失真） */
  kwCount: Map<string, number>;
  /** 度数 Top 40 关键词（并列按字典序保证稳定） */
  topKws: string[];
  topSet: Set<string>;
}

function buildModel(items: MemEntry[], rangeDays: number): Model {
  const now = Date.now();
  const filtered =
    rangeDays > 0 ? items.filter((it) => now - it.ts < rangeDays * DAY) : items;
  const kwCount = new Map<string, number>();
  for (const it of filtered)
    for (const kw of it.keywords) kwCount.set(kw, (kwCount.get(kw) ?? 0) + 1);
  const topKws = [...kwCount.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, TOP_KW)
    .map(([k]) => k);
  return { items: filtered, kwCount, topKws, topSet: new Set(topKws) };
}

/* ================= 图结构 ================= */

type NodeType = 'kw' | 'mem' | 'agg';

interface GNode {
  id: string; // 'kw:词' | 'mem:时间戳' | 'agg:other' | 'agg:undistilled'
  label: string;
  type: NodeType;
  kind?: MemEntry['kind']; // mem 节点着色
  deg: number; // 度数：斥力 hub 系数与标签分级用
  r: number; // 屏幕像素半径（不随缩放变：缩放只影响间距，缩小时不至于糊成一片）
  x: number;
  y: number;
  vx: number;
  vy: number;
  entry?: MemEntry; // mem 节点原始条目（弹层用）
  kw?: string; // kw 节点原始关键词（点击回填检索用）
  count?: number; // agg 节点折叠的条数
  /** 渲染期补间透明度（G1）：同 GEdge.curA */
  curA?: number;
}

interface GEdge {
  a: number;
  b: number;
  w: number; // 主题模式=共现次数（边宽），关联模式=1
  /** 渲染期补间透明度（G1）：构建时不填，挂载 effect 归一为 0 后向目标收敛 */
  curA?: number;
}

interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  adj: number[][];
  /** 标签分级：低 zoom 时仍显示文字的节点（度数 Top 24 + 聚合节点） */
  topLabel: Set<string>;
}

interface Sim extends Graph {
  W: number;
  H: number;
  L0: number;
  krep2: number;
  cutoff: number;
  temp: number;
  active: boolean; // 物理在跑（false = 冻结，只有交互才重绘）
  freezeCnt: number;
  /** 拖拽重启时的可动节点白名单（null = 全图可动） */
  hood: Set<number> | null;
  mode: 'rel' | 'topic';
  focusId: string | null;
  /** 松手回弹（G4）：刚放下的节点 id + 起始时刻，150ms 内 1.15×→1× */
  recoil: { id: string; t0: number } | null;
}

function linkAdj(nodes: GNode[], edges: GEdge[]): number[][] {
  const adj: number[][] = nodes.map(() => []);
  for (const e of edges) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }
  return adj;
}

/** 关键词半径：4~16px，∝关联条数（最少 1 条 → 4px，最多 → 16px） */
const kwRadius = (count: number, maxCount: number): number =>
  maxCount <= 1 ? 16 : clamp(4 + (12 * (count - 1)) / (maxCount - 1), 4, 16);

/** 初始布局：圆周均匀撒点。关键词/聚合占外圈（按序分扇区，高度数词互不抢位），
 *  记忆点放内圈并锚定其首条边对端的角度——弹簧从第 0 帧起就在把它拉向关联词 */
function initLayout(g: Graph, W: number, H: number, rand: () => number): void {
  const cx = W / 2;
  const cy = H / 2;
  const outer = g.nodes.filter((n) => n.type !== 'mem');
  const R = Math.min(W, H) * 0.36;
  const angOf = new Map<string, number>();
  outer.forEach((n, i) => {
    const a = (i / Math.max(1, outer.length)) * Math.PI * 2;
    angOf.set(n.id, a);
    n.x = cx + Math.cos(a) * R;
    n.y = cy + Math.sin(a) * R;
  });
  const Ri = Math.min(W, H) * 0.2;
  for (let i = 0; i < g.nodes.length; i++) {
    const n = g.nodes[i];
    if (n.type !== 'mem') continue;
    // 首条边对端（关键词）的角度 ± 抖动，避免同锚点的记忆叠死在同一点
    const first = g.adj[i];
    const anchor = first.length > 0 ? angOf.get(g.nodes[first[0]].id) : undefined;
    const a = (anchor ?? rand() * Math.PI * 2) + (rand() - 0.5) * 0.9;
    const rr = Ri * (0.45 + rand() * 0.75);
    n.x = cx + Math.cos(a) * rr;
    n.y = cy + Math.sin(a) * rr;
  }
}

/* ---- 全图构建 ---- */

function buildFull(m: Model, mode: 'rel' | 'topic', W: number, H: number): Graph {
  if (mode === 'topic') {
    /* 主题模式：关键词共现。只保留度数>0（参与过共现）的词，孤立词没有边可画 */
    const co = new Map<string, number>();
    for (const it of m.items) {
      const ks = it.keywords.filter((k) => m.topSet.has(k));
      for (let i = 0; i < ks.length; i++)
        for (let j = i + 1; j < ks.length; j++) {
          const key = ks[i] < ks[j] ? `${ks[i]}\u0000${ks[j]}` : `${ks[j]}\u0000${ks[i]}`;
          co.set(key, (co.get(key) ?? 0) + 1);
        }
    }
    const pairs = [...co.entries()].map(([k, w]) => {
      const [a, b] = k.split('\u0000');
      return { a, b, w };
    });
    const deg = new Map<string, number>();
    for (const p of pairs) {
      deg.set(p.a, (deg.get(p.a) ?? 0) + 1);
      deg.set(p.b, (deg.get(p.b) ?? 0) + 1);
    }
    const nodes: GNode[] = [];
    const idx = new Map<string, number>();
    const maxDeg = Math.max(1, ...deg.values());
    for (const kw of m.topKws) {
      const d = deg.get(kw);
      if (!d) continue;
      idx.set(kw, nodes.length);
      nodes.push({
        id: `kw:${kw}`,
        label: kw,
        type: 'kw',
        kw,
        deg: d,
        r: kwRadius(d, maxDeg),
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
      });
    }
    const edges: GEdge[] = [];
    for (const p of pairs) {
      const a = idx.get(p.a);
      const b = idx.get(p.b);
      if (a === undefined || b === undefined) continue;
      edges.push({ a, b, w: p.w });
    }
    const g: Graph = { nodes, edges, adj: [], topLabel: new Set() };
    g.adj = linkAdj(nodes, edges);
    markTopLabels(g);
    initLayout(g, W, H, rng32(nodes.length * 7 + edges.length));
    return g;
  }

  /* 关联模式：关键词-记忆二部图 */
  const maxCount = Math.max(1, ...m.topKws.map((k) => m.kwCount.get(k) ?? 0));
  const nodes: GNode[] = [];
  const kwIdx = new Map<string, number>();
  for (const kw of m.topKws) {
    kwIdx.set(kw, nodes.length);
    nodes.push({
      id: `kw:${kw}`,
      label: kw,
      type: 'kw',
      kw,
      deg: m.kwCount.get(kw) ?? 1,
      r: kwRadius(m.kwCount.get(kw) ?? 1, maxCount),
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
    });
  }
  /* 记忆点：至少挂一个 Top 关键词的条目才单独成节点；超上限取最近的
     （近的记忆更可能是当前关心的事，旧记忆通过关键词半径仍被感知） */
  const cand = m.items
    .filter((it) => it.keywords.some((k) => m.topSet.has(k)))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_MEM_NODES);
  const memIdx = new Map<number, number>();
  for (const it of cand) {
    memIdx.set(it.ts, nodes.length);
    nodes.push({
      id: `mem:${it.ts}`,
      label: it.title,
      type: 'mem',
      kind: it.kind,
      deg: 1,
      r: 5,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      entry: it,
    });
  }
  const edges: GEdge[] = [];
  for (const it of cand) {
    const mi = memIdx.get(it.ts);
    if (mi === undefined) continue;
    nodes[mi].deg = it.keywords.filter((k) => m.topSet.has(k)).length;
    for (const kw of it.keywords) {
      const ki = kwIdx.get(kw);
      if (ki !== undefined) edges.push({ a: ki, b: mi, w: 1 });
    }
  }
  /* 长尾折叠：关键词全在 Top 之外的条目不进图（进了也没有锚点），折叠为
     「其他 N 项」节点，点击钻取展开（按 kind 着色聚合） */
  const longTailOnly = m.items.filter(
    (it) => it.keywords.length > 0 && !it.keywords.some((k) => m.topSet.has(k)),
  );
  if (longTailOnly.length > 0) {
    let n = 0;
    for (const [k] of m.kwCount) if (!m.topSet.has(k)) n++;
    const id = 'agg:other';
    nodes.push({
      id,
      label: `其他 ${n} 项`,
      type: 'agg',
      deg: longTailOnly.length,
      r: 11,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      count: longTailOnly.length,
    });
  }
  /* 未蒸馏折叠：无关键词的记忆没有二部图语义，汇总成一个节点点击展开 */
  const undistilled = m.items.filter((it) => it.keywords.length === 0);
  if (undistilled.length > 0) {
    nodes.push({
      id: 'agg:undistilled',
      label: `未蒸馏 ×${undistilled.length}`,
      type: 'agg',
      deg: Math.min(undistilled.length, 30), // 斥力 hub 系数封顶：几千条未蒸馏不该把它弹飞
      r: 11,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      count: undistilled.length,
    });
  }
  const g: Graph = { nodes, edges, adj: [], topLabel: new Set() };
  g.adj = linkAdj(nodes, edges);
  markTopLabels(g);
  initLayout(g, W, H, rng32(nodes.length * 13 + m.items.length));
  return g;
}

/* ---- 钻取子图构建：以节点为中心 2 跳（关键词→其记忆→它们的 top 关键词） ---- */

function buildFocus(m: Model, focusId: string, W: number, H: number): Graph {
  /* 钻取要按全量索引找邻居（全图里被折叠/裁剪的条目也要能展开） */
  const byKw = new Map<string, MemEntry[]>();
  const byTs = new Map<number, MemEntry>();
  for (const it of m.items) {
    byTs.set(it.ts, it);
    for (const kw of it.keywords) {
      const arr = byKw.get(kw);
      if (arr) arr.push(it);
      else byKw.set(kw, [it]);
    }
  }
  const capRecent = (list: MemEntry[], cap: number): MemEntry[] =>
    list.length <= cap ? list : [...list].sort((a, b) => b.ts - a.ts).slice(0, cap);

  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const idOf = new Map<string, number>(); // id → 节点下标
  const addKw = (kw: string, deg: number): number => {
    const ex = idOf.get(`kw:${kw}`);
    if (ex !== undefined) return ex;
    const i = nodes.length;
    idOf.set(`kw:${kw}`, i);
    nodes.push({
      id: `kw:${kw}`,
      label: kw,
      type: 'kw',
      kw,
      deg: Math.max(1, deg),
      r: kwRadius(deg, Math.max(2, deg)),
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
    });
    return i;
  };
  const addMem = (it: MemEntry): number => {
    const ex = idOf.get(`mem:${it.ts}`);
    if (ex !== undefined) return ex;
    const i = nodes.length;
    idOf.set(`mem:${it.ts}`, i);
    nodes.push({
      id: `mem:${it.ts}`,
      label: it.title,
      type: 'mem',
      kind: it.kind,
      deg: it.keywords.length,
      r: 5,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      entry: it,
    });
    return i;
  };
  /** 中心-记忆 + 记忆-次级关键词 两跳布线；次级词按子集内频次取 Top。
      半径最后按子集内最大频次统一重标（子集频次与全库度数量纲不同） */
  const relabelKw = (maxBase: number): void => {
    for (const n of nodes) if (n.type === 'kw') n.r = kwRadius(n.deg, maxBase);
  };
  const wire = (
    center: number,
    mems: MemEntry[],
    centerKw: string | null,
    secondCap: number,
  ): void => {
    const freq = new Map<string, number>();
    for (const it of mems)
      for (const kw of it.keywords)
        if (kw !== centerKw) freq.set(kw, (freq.get(kw) ?? 0) + 1);
    const second = [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, secondCap);
    const maxF = Math.max(1, ...second.map((s) => s[1]));
    const secondIdx = new Map<string, number>();
    for (const [kw, c] of second) secondIdx.set(kw, addKw(kw, c));
    for (const it of mems) {
      const mi = addMem(it);
      edges.push({ a: center, b: mi, w: 1 });
      for (const [kw, ki] of secondIdx)
        if (it.keywords.includes(kw)) edges.push({ a: ki, b: mi, w: 1 });
    }
    relabelKw(Math.max(2, maxF));
  };

  let centerLabel = '';
  if (focusId.startsWith('kw:')) {
    const kw = focusId.slice(3);
    centerLabel = kw;
    const mems = capRecent(byKw.get(kw) ?? [], MAX_FOCUS_NODES);
    const ci = addKw(kw, Math.max(1, m.kwCount.get(kw) ?? mems.length));
    wire(ci, mems, kw, 20);
  } else if (focusId.startsWith('mem:')) {
    const entry = byTs.get(Number(focusId.slice(4)));
    if (entry) {
      /* mem 中心的 2 跳 = 它的关键词 + 共享任一关键词的兄弟记忆 */
      centerLabel = entry.title;
      const seen = new Set<number>([entry.ts]);
      const sibs: MemEntry[] = [];
      for (const kw of entry.keywords)
        for (const s of byKw.get(kw) ?? [])
          if (!seen.has(s.ts)) {
            seen.add(s.ts);
            sibs.push(s);
          }
      const ci = addMem(entry);
      const kwNodes = entry.keywords.map((kw) => {
        const ki = addKw(kw, m.kwCount.get(kw) ?? 1);
        edges.push({ a: ci, b: ki, w: 1 });
        return { kw, ki };
      });
      for (const s of capRecent(sibs, 40)) {
        const mi = addMem(s);
        for (const { kw, ki } of kwNodes)
          if (s.keywords.includes(kw)) edges.push({ a: ki, b: mi, w: 1 });
      }
      const maxC = Math.max(1, ...kwNodes.map((x) => m.kwCount.get(x.kw) ?? 1));
      relabelKw(maxC);
    }
  } else if (focusId === 'agg:other') {
    const mems = capRecent(
      m.items.filter(
        (it) => it.keywords.length > 0 && !it.keywords.some((k) => m.topSet.has(k)),
      ),
      200,
    );
    let n = 0;
    for (const [k] of m.kwCount) if (!m.topSet.has(k)) n++;
    centerLabel = `其他 ${n} 项`;
    const ci = nodes.length;
    nodes.push({
      id: 'agg:other',
      label: centerLabel,
      type: 'agg',
      deg: Math.min(mems.length, 30),
      r: 11,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      count: mems.length,
    });
    idOf.set('agg:other', ci);
    wire(ci, mems, null, 24);
  } else if (focusId === 'agg:undistilled') {
    const mems = capRecent(m.items.filter((it) => it.keywords.length === 0), 200);
    centerLabel = `未蒸馏 ×${m.items.filter((it) => it.keywords.length === 0).length}`;
    const ci = nodes.length;
    nodes.push({
      id: 'agg:undistilled',
      label: centerLabel,
      type: 'agg',
      deg: Math.min(mems.length, 30),
      r: 11,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      count: mems.length,
    });
    idOf.set('agg:undistilled', ci);
    for (const it of mems) edges.push({ a: ci, b: addMem(it), w: 1 });
  }

  const g: Graph = { nodes, edges, adj: [], topLabel: new Set() };
  g.adj = linkAdj(nodes, edges);
  markTopLabels(g);
  initLayout(g, W, H, rng32(nodes.length * 31 + edges.length));
  return g;
}

/** 标签分级：预计算度数 Top 24 + 全部聚合节点——低 zoom 时只画这些的标签，
 *  砍掉 ~80% 的 fillText（文字绘制是 canvas 最贵的部分之一） */
function markTopLabels(g: Graph): void {
  const ranked = [...g.nodes].sort((a, b) => b.deg - a.deg).slice(0, 24);
  g.topLabel = new Set(ranked.map((n) => n.id));
  for (const n of g.nodes) if (n.type === 'agg') g.topLabel.add(n.id);
}

/* ================= 物理 ================= */

function stepPhysics(s: Sim): void {
  const ns = s.nodes;
  const canMove = (i: number): boolean => s.hood === null || s.hood.has(i);
  const cx = s.W / 2;
  const cy = s.H / 2;

  /* 斥力：空间网格 + 截断。库仑 1/d 衰减慢，但 2.2×k_rep 之外已弱于弹簧/向心，
     忽略后布局无肉眼差异，而每帧从 O(N²) 对降到近邻对 */
  const cell = Math.max(8, s.cutoff);
  const grid = new Map<string, number[]>();
  for (let i = 0; i < ns.length; i++) {
    const n = ns[i];
    const k = `${Math.floor(n.x / cell)},${Math.floor(n.y / cell)}`;
    const arr = grid.get(k);
    if (arr) arr.push(i);
    else grid.set(k, [i]);
  }
  for (let i = 0; i < ns.length; i++) {
    const a = ns[i];
    const gx = Math.floor(a.x / cell);
    const gy = Math.floor(a.y / cell);
    for (let ox = -1; ox <= 1; ox++)
      for (let oy = -1; oy <= 1; oy++) {
        const arr = grid.get(`${gx + ox},${gy + oy}`);
        if (!arr) continue;
        for (const j of arr) {
          if (j <= i) continue;
          const b = ns[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = 0.13; // 完全重叠的两个点给一个固定方向的微位移脱困
            dy = 0.11;
            d2 = 0.03;
          }
          const hub = 1 + Math.log2(1 + Math.max(a.deg, b.deg));
          const f = (s.krep2 / d2) * REP_SCALE * hub;
          const d = Math.sqrt(d2);
          const fx = (f * dx) / d;
          const fy = (f * dy) / d;
          if (canMove(i)) {
            a.vx -= fx;
            a.vy -= fy;
          }
          if (canMove(j)) {
            b.vx += fx;
            b.vy += fy;
          }
        }
      }
  }

  /* 弹簧：d > L0 时吸回、d < L0 时推开（把二部图拉成可读的辐条结构） */
  for (const e of s.edges) {
    const a = ns[e.a];
    const b = ns[e.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(0.1, Math.hypot(dx, dy));
    const f = K_SPRING * (d - s.L0);
    const fx = (f * dx) / d;
    const fy = (f * dy) / d;
    if (canMove(e.a)) {
      a.vx += fx;
      a.vy += fy;
    }
    if (canMove(e.b)) {
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  /* 向心 + 积分 + 退火 + 冻结判定 */
  let sumDisp = 0;
  for (let i = 0; i < ns.length; i++) {
    if (!canMove(i)) continue;
    const n = ns[i];
    n.vx = (n.vx + K_CENTER * (cx - n.x)) * DAMPING;
    n.vy = (n.vy + K_CENTER * (cy - n.y)) * DAMPING;
    const dx = clamp(n.vx, -s.temp, s.temp);
    const dy = clamp(n.vy, -s.temp, s.temp);
    n.x += dx;
    n.y += dy;
    sumDisp += Math.abs(dx) + Math.abs(dy);
  }
  s.temp *= TEMP_DECAY;
  if (s.temp < 0.35) {
    s.active = false; // 退火硬停：极端震荡图永远不会自然冻结的保底
    return;
  }
  const avg = sumDisp / Math.max(1, ns.length);
  if (avg < FREEZE_DISP) {
    if (++s.freezeCnt >= FREEZE_FRAMES) s.active = false;
  } else s.freezeCnt = 0;
}

/* ================= 渲染 ================= */

interface Hover {
  id: string | null;
  /** 1 跳邻域（含自身 id），其余节点淡出 */
  nbr: Set<string> | null;
  /** HUD 跟随光标（G9）的最新指针位置 */
  mx: number;
  my: number;
}

/** drawGraph 的交互外参（组件 ref 的只读快照） */
interface Fx {
  /** 正被拖拽的节点下标（无则 null）：G4 投影 + 放大 */
  dragIdx: number | null;
  /** 图例悬停联动的选择（G12）：'kw' | kind | 'agg' | null */
  legend: string | null;
  /** HUD 淡入透明度（G1），跨帧可变状态由调用方持有 */
  hud: { a: number };
  now: number;
}

/** 节点主色（G5 热边渐变用）：kw=主题 sky、mem=类型色、agg=slate */
const nodeRGB = (n: GNode, light: boolean): string => {
  if (n.type === 'kw') return light ? '2,132,199' : '56,189,248';
  if (n.type === 'mem' && n.kind) return KIND_RGB[n.kind].join(',');
  return light ? '71,85,105' : '148,163,184';
};

/** 两端色取中并向白提亮 25%（G5 中段停色） */
const mixLift = (ca: string, cb: string): string => {
  const p = ca.split(',').map(Number);
  const q = cb.split(',').map(Number);
  return p
    .map((v, i) => {
      const mid = (v + q[i]) / 2;
      return Math.round(mid + (255 - mid) * 0.25);
    })
    .join(',');
};

/** 返回「是否仍在动效中」——true 时渲染循环继续保持脏标记逐帧收敛 */
function drawGraph(
  ctx: CanvasRenderingContext2D,
  s: Sim,
  cam: { x: number; y: number; z: number },
  size: { w: number; h: number; dpr: number },
  hover: Hover,
  popId: string | null,
  fx: Fx,
): boolean {
  /* 主题切换没有可靠事件可订阅，classList.contains 又是 O(1) 无重排——
     每帧直读是最简单可靠的做法，成本可忽略 */
  const light = document.documentElement.classList.contains('light');
  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  ctx.fillStyle = light ? '#eef1f6' : '#0b0b12';
  ctx.fillRect(0, 0, size.w, size.h);

  /* 背景点阵（G7）：图案锚点 = 世界原点的屏幕投影取模 24，随相机平移；
     点距恒定屏幕像素（不随 zoom 缩放），避免深缩放时点阵糊成面 */
  const tile = light
    ? (dotTileLight ??= makeDotTile('rgba(71,85,105,0.12)'))
    : (dotTileDark ??= makeDotTile('rgba(148,163,184,0.10)'));
  const pat = ctx.createPattern(tile, 'repeat');
  if (pat) {
    const ox = (((size.w / 2 - cam.x * cam.z) % 24) + 24) % 24;
    const oy = (((size.h / 2 - cam.y * cam.z) % 24) + 24) % 24;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.fillStyle = pat;
    ctx.fillRect(-24, -24, size.w + 48, size.h + 48);
    ctx.restore();
  }

  const z = cam.z;
  const sx = (x: number): number => (x - cam.x) * z + size.w / 2;
  const sy = (y: number): number => (y - cam.y) * z + size.h / 2;
  const dimming = hover.id !== null;
  const labelFull = z >= 0.75; // 标签分级阈值：低于它只画 Top 度数/选中/悬停标签
  const lodLow = z < 0.5; // LOD 低档（G6）：mem 点更小、边更淡更细
  const lodHigh = z >= 1.5; // LOD 高档（G6）：置顶条目补标题

  /* 补间（G1）：每帧把剩余差值乘 0.78 收敛（≈300ms 走完 90%）；
     未收敛则置 live 请求下一帧，收敛即停——冻结态零空转的口径不变 */
  let live = false;
  const ease = (cur: number, tgt: number): number => {
    if (REDUCED) return tgt;
    if (Math.abs(tgt - cur) < 0.004) return tgt;
    live = true;
    return cur + (tgt - cur) * 0.22;
  };

  /* 图例联动（G12）的节点归类 */
  const kindOf = (n: GNode): string =>
    n.type === 'kw' ? 'kw' : n.type === 'agg' ? 'agg' : (n.kind ?? '');

  /* 节点透明度目标：悬停邻域 × 图例联动相乘（两个聚焦器同时开时取交集） */
  for (const n of s.nodes) {
    let t = 1;
    if (dimming) t *= hover.nbr !== null && hover.nbr.has(n.id) ? 1 : 0.15;
    if (fx.legend !== null) t *= kindOf(n) === fx.legend ? 1 : 0.15;
    n.curA = ease(n.curA ?? 0, t);
  }

  /* 边 */
  ctx.lineCap = 'round';
  for (const e of s.edges) {
    const a = s.nodes[e.a];
    const b = s.nodes[e.b];
    const ax = sx(a.x);
    const ay = sy(a.y);
    const bx = sx(b.x);
    const by = sy(b.y);
    /* 视口外粗裁：两端都在同一侧界外就跳过（缩放很深时省大量 draw call） */
    const m = 60;
    const culled =
      (ax < -m && bx < -m) ||
      (ax > size.w + m && bx > size.w + m) ||
      (ay < -m && by < -m) ||
      (ay > size.h + m && by > size.h + m);
    const hot =
      dimming && hover.nbr !== null && (hover.nbr.has(a.id) || hover.nbr.has(b.id));
    /* 基础透明度：主题模式冷边按屏距渐隐（G5），LOD 低档整体 ×0.8（G6） */
    let base = 1;
    if (s.mode === 'topic' && !hot) {
      const len = Math.hypot(bx - ax, by - ay);
      base = clamp(1.15 - len / 600, 0.35, 1);
    }
    if (lodLow) base *= 0.8;
    let t = base;
    if (dimming) t *= hot ? 0.9 : 0.15;
    if (fx.legend !== null)
      t *= kindOf(a) === fx.legend || kindOf(b) === fx.legend ? 0.9 : 0.15;
    e.curA = ease(e.curA ?? 0, t);
    if (culled) continue;
    let lw = s.mode === 'topic' ? Math.min(3.5, 0.8 + e.w * 0.5) : 1;
    if (lodLow) lw *= 0.75;
    ctx.globalAlpha = e.curA;
    if (hot) {
      /* 热边 glow（G2）：先铺加粗 2.5px 的半透明天蓝外描再画亮线。
         双描边而非 shadowBlur——后者在低端核显上代价高且会溢出裁剪 */
      ctx.strokeStyle = 'rgba(56,189,248,0.18)';
      ctx.lineWidth = lw + 2.5;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    if (s.mode === 'topic' && hot) {
      /* 主题模式热边（G5）：两端节点色线性渐变 + 中段提亮 25% */
      const ca = nodeRGB(a, light);
      const cb = nodeRGB(b, light);
      const grad = ctx.createLinearGradient(ax, ay, bx, by);
      grad.addColorStop(0, `rgba(${ca},0.95)`);
      grad.addColorStop(0.5, `rgba(${mixLift(ca, cb)},0.95)`);
      grad.addColorStop(1, `rgba(${cb},0.95)`);
      ctx.strokeStyle = grad;
    } else {
      ctx.strokeStyle = hot
        ? light
          ? '#0284c7'
          : '#7dd3fc'
        : light
          ? 'rgba(71,85,105,0.30)'
          : 'rgba(148,163,184,0.16)';
    }
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  /* halo 呼吸（G3）：scale 1↔1.15、1.6s 一循环（余弦 ≈ ease-in-out）；
     只要有高亮目标就持续置 live（呼吸是常驻动画，物理冻结也不影响它） */
  haloSprite ??= makeRadialSprite('251,191,36');
  shadowSprite ??= makeRadialSprite('0,0,0');
  const hasHot =
    hover.id !== null || popId !== null || (s.focusId !== null && s.focusId !== '');
  const breath = REDUCED
    ? 1
    : 1 + 0.15 * (0.5 - 0.5 * Math.cos(((fx.now % 1600) / 1600) * Math.PI * 2));
  if (hasHot && !REDUCED) live = true;

  /* 松手回弹（G4）：150ms 内 1.15×→1×，二次缓出 */
  let recoilAmt = 0;
  if (s.recoil) {
    const k = clamp((fx.now - s.recoil.t0) / 150, 0, 1);
    recoilAmt = 0.15 * (1 - k) * (1 - k);
    if (k >= 1) s.recoil = null;
    else live = true;
  }

  /* 节点 */
  const labels: { x: number; y: number; text: string; a: number }[] = [];
  for (let i = 0; i < s.nodes.length; i++) {
    const n = s.nodes[i];
    const px = sx(n.x);
    const py = sy(n.y);
    if (px < -40 || px > size.w + 40 || py < -40 || py > size.h + 40) continue;
    const na = n.curA ?? 0; // 前一轮 alpha 循环已归一，?? 0 只是类型收窄
    ctx.globalAlpha = na;
    const isDrag = fx.dragIdx === i;
    const isRecoil = s.recoil !== null && s.recoil.id === n.id;
    /* LOD 低档 mem 半径 5→4（G6）；拖拽 1.15×、回弹期按进度回落（G4） */
    const rr =
      n.r *
      (n.type === 'mem' && lodLow ? 0.8 : 1) *
      (isDrag ? 1.15 : isRecoil ? 1 + recoilAmt : 1);
    /* 拖拽投影（G4）：黑色光晕 sprite 垫底（向下偏 3px 制造抬升感） */
    if ((isDrag || isRecoil) && shadowSprite) {
      const ssz = (rr + 5) * 2;
      ctx.drawImage(shadowSprite, px - ssz / 2, py - ssz / 2 + 3, ssz, ssz);
    }
    if (n.type === 'kw') {
      const c = light ? '2,132,199' : '56,189,248';
      ctx.beginPath();
      ctx.arc(px, py, rr, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${c},${light ? 0.16 : 0.2})`;
      ctx.fill();
      ctx.lineWidth = n.deg > 4 ? 2 : 1.25;
      ctx.strokeStyle = `rgba(${c},0.95)`;
      ctx.stroke();
    } else if (n.type === 'mem' && n.kind) {
      const [r, g, b] = KIND_RGB[n.kind];
      ctx.beginPath();
      ctx.arc(px, py, rr, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},0.9)`;
      ctx.fill();
      /* 置顶记忆加一圈 amber 细环：图谱里也能认出常用内容 */
      if (n.entry?.pinned) {
        ctx.beginPath();
        ctx.arc(px, py, rr + 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(251,191,36,0.75)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    } else {
      /* 聚合节点：虚线圆 + 弱色，视觉上表达「这是一捆不是一条」 */
      ctx.beginPath();
      ctx.setLineDash([4, 3]);
      ctx.arc(px, py, rr, 0, Math.PI * 2);
      ctx.fillStyle = light ? 'rgba(100,116,139,0.12)' : 'rgba(148,163,184,0.12)';
      ctx.fill();
      ctx.strokeStyle = light ? 'rgba(71,85,105,0.7)' : 'rgba(148,163,184,0.6)';
      ctx.lineWidth = 1.25;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    /* 悬停/弹层/聚焦中心节点：halo sprite 光晕 + 细描边环（G3） */
    const isHot =
      n.id === hover.id || n.id === popId || (s.focusId !== null && n.id === s.focusId);
    if (isHot) {
      if (haloSprite) {
        const hsz = (rr + 6) * 2 * breath;
        ctx.drawImage(haloSprite, px - hsz / 2, py - hsz / 2, hsz, hsz);
      }
      ctx.beginPath();
      ctx.arc(px, py, rr + 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(251,191,36,0.9)';
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
    /* 标签收集（延后统一画，避免被后画的节点盖住）：kw 按分级、mem 只在
       悬停/弹层或 LOD 高档置顶补位（G6）时画标题（记忆标题太长，全画必糊） */
    const showKwLabel = labelFull || s.topLabel.has(n.id) || isHot;
    if (n.type === 'kw' || n.type === 'agg') {
      if (showKwLabel)
        labels.push({ x: px, y: py + n.r + 14, text: n.label, a: na });
    } else if (isHot) {
      const t = n.label.length > 14 ? `${n.label.slice(0, 13)}…` : n.label;
      labels.push({ x: px, y: py - n.r - 8, text: t, a: na });
    } else if (lodHigh && n.entry?.pinned) {
      labels.push({ x: px, y: py + n.r + 12, text: n.label.slice(0, 8), a: na * 0.9 });
    }
  }

  /* 标签：中文 12px（css 像素，dpr≥1 时物理像素 ≥12），画在节点层之上 */
  ctx.globalAlpha = 1;
  ctx.font =
    '12px system-ui, "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const l of labels) {
    ctx.globalAlpha = l.a;
    ctx.fillStyle = light ? '#334155' : '#cbd5e1';
    ctx.fillText(l.text, l.x, l.y);
  }

  /* 悬停 HUD（G1 淡入 + G9 跟随光标）：一行摘要让「点哪里会发生什么」可预期；
     位置 (mx+14, my-28) 起步并 clamp 进视口，避免贴边截断 */
  fx.hud.a = ease(fx.hud.a, hover.id !== null ? 1 : 0);
  if (hover.id !== null && fx.hud.a > 0.01) {
    const n = s.nodes.find((x) => x.id === hover.id);
    if (n) {
      const tip =
        n.type === 'kw'
          ? `「${n.label}」关联 ${n.deg} 条 · 单击检索 · 双击聚焦`
          : n.type === 'agg'
            ? `${n.label} · 单击展开`
            : `${KIND_LABEL[n.entry?.kind ?? 'dictation']} · ${n.label} · 单击详情`;
      ctx.globalAlpha = fx.hud.a;
      ctx.font =
        '11px system-ui, "Microsoft YaHei", "PingFang SC", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = light ? '#475569' : '#64748b';
      const t = tip.length > 44 ? `${tip.slice(0, 43)}…` : tip;
      const tw = ctx.measureText(t).width;
      const hx = clamp(hover.mx + 14, 8, Math.max(8, size.w - tw - 8));
      const hy = clamp(hover.my - 28, 18, Math.max(18, size.h - 10));
      ctx.fillText(t, hx, hy);
    }
  }

  return live;
}

/* ================= 组件 ================= */

/** 相对时间（弹层用）：与时间轴的「今天/昨天/M月D日」同一心智但更口语 */
function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  const dt = new Date(ts);
  const now2 = new Date();
  return `${dt.getFullYear() === now2.getFullYear() ? '' : `${dt.getFullYear()}年`}${dt.getMonth() + 1}月${dt.getDate()}日`;
}

interface DragState {
  kind: 'pan' | 'node';
  idx: number; // node 模式的节点下标
  sx: number;
  sy: number;
  moved: boolean;
}

export function MemGraph({
  items,
  onPickKeyword,
  onGoDictate,
}: {
  items: MemEntry[];
  onPickKeyword: (kw: string) => void;
  /** 空态主 CTA（G13）：由 MemTab 注入 navigate('dash')，图谱自身不感知路由 */
  onGoDictate?: () => void;
}) {
  const [mode, setMode] = useState<'rel' | 'topic'>('rel');
  const [range, setRange] = useState<0 | 7 | 30 | 90>(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [pop, setPop] = useState<{
    id: string;
    entry: MemEntry;
    x: number;
    y: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const model = useMemo(() => buildModel(items, range), [items, range]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const simRef = useRef<Sim | null>(null);
  const camRef = useRef({ x: 0, y: 0, z: 1 });
  const rafRef = useRef(0);
  const dirtyRef = useRef(true);
  const hoverRef = useRef<Hover>({ id: null, nbr: null, mx: 0, my: 0 });
  const popRef = useRef<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  /* HUD 淡入透明度（G1）：跨帧可变，由 drawGraph 就地推进 */
  const hudRef = useRef({ a: 0 });
  /* 图例悬停联动（G12）：'kw' | kind | 'agg' | null */
  const legendRef = useRef<string | null>(null);

  /* 弹层开着时 pan/zoom 都会让弹层锚点脱离节点——直接关闭比每帧同步 DOM 位置简单可靠 */
  useEffect(() => {
    popRef.current = pop?.id ?? null;
    dirtyRef.current = true;
  }, [pop]);

  /* 主 effect：数据/模式/聚焦变化 → 重建图与物理、重置相机（全新布局） */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const w = wrap.clientWidth || 600;
    const h = wrap.clientHeight || 400;
    const rand = rng32(model.items.length * 101 + model.kwCount.size * 7);
    const g =
      focusId && mode === 'rel'
        ? buildFocus(model, focusId, w, h)
        : buildFull(model, mode, w, h);
    const n = Math.max(1, g.nodes.length);
    const L0 = clamp(Math.sqrt((w * h) / n), 14, 220);
    /* 补间透明度归一（G1）：从 0 起步，重建的图整体淡入（也遮一帧布局跳变） */
    for (const nd of g.nodes) nd.curA = nd.curA ?? 0;
    for (const ed of g.edges) ed.curA = ed.curA ?? 0;
    simRef.current = {
      ...g,
      W: w,
      H: h,
      L0,
      krep2: (K_REP * L0) ** 2,
      cutoff: REP_CUTOFF * K_REP * L0,
      temp: clamp(L0, 10, 40),
      active: g.nodes.length > 1,
      freezeCnt: 0,
      hood: null,
      mode,
      focusId: focusId ?? null,
      recoil: null,
    };
    camRef.current = { x: w / 2, y: h / 2, z: 1 };
    dirtyRef.current = true;
  }, [model, mode, focusId]);

  /* 渲染循环 effect（挂一次）：ResizeObserver 管 DPR/尺寸，wheel 需 passive:false
     才能 preventDefault（页面本身可滚动），卸载时三者全部回收防泄漏 */
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    const applySize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth || 1;
      const h = wrap.clientHeight || 1;
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      dirtyRef.current = true;
    };
    /* 挂载即同步量一次尺寸：ResizeObserver 首次回调要等下一帧的渲染步才
       送达，空一帧的 300×150 默认画布会被 CSS 拉伸成一帧糊图 */
    applySize();
    const ro = new ResizeObserver(applySize);
    ro.observe(wrap);
    const zoomAt = (px: number, py: number, factor: number): void => {
      const cam = camRef.current;
      const { w, h } = sizeRef.current;
      const z2 = clamp(cam.z * factor, 0.3, 4);
      if (z2 === cam.z) return;
      const wx = (px - w / 2) / cam.z + cam.x;
      const wy = (py - h / 2) / cam.z + cam.y;
      cam.z = z2;
      cam.x = wx - (px - w / 2) / z2; // 以指针为不动点缩放：光标下的内容不漂移
      cam.y = wy - (py - h / 2) / z2;
    };
    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault();
      zoomAt(ev.offsetX, ev.offsetY, Math.exp(-ev.deltaY * 0.0012));
      setPop(null);
      dirtyRef.current = true;
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    const loop = (): void => {
      rafRef.current = requestAnimationFrame(loop);
      const s = simRef.current;
      if (!s) return;
      if (s.active) {
        stepPhysics(s);
        dirtyRef.current = true;
      }
      if (dirtyRef.current && ctx) {
        /* drawGraph 返回「动效未收敛」（补间/呼吸/回弹），保持脏标记继续逐帧 */
        dirtyRef.current = drawGraph(
          ctx,
          s,
          camRef.current,
          sizeRef.current,
          hoverRef.current,
          popRef.current,
          {
            dragIdx: dragRef.current?.kind === 'node' ? dragRef.current.idx : null,
            legend: legendRef.current,
            hud: hudRef.current,
            now: performance.now(),
          },
        );
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    canvas.style.cursor = 'grab';
    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  /** 屏幕坐标 → 命中节点下标（半径恒定屏幕像素 r+6，所以除以 zoom 换回世界系） */
  const nodeAt = (px: number, py: number): number => {
    const s = simRef.current;
    const cam = camRef.current;
    const { w, h } = sizeRef.current;
    if (!s) return -1;
    const wx = (px - w / 2) / cam.z + cam.x;
    const wy = (py - h / 2) / cam.z + cam.y;
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < s.nodes.length; i++) {
      const n = s.nodes[i];
      const dx = n.x - wx;
      const dy = n.y - wy;
      const d2 = dx * dx + dy * dy;
      const rr = (n.r + 6) / cam.z;
      if (d2 <= rr * rr && d2 < bd) {
        bd = d2;
        best = i;
      }
    }
    return best;
  };

  const toWorld = (px: number, py: number): { x: number; y: number } => {
    const cam = camRef.current;
    const { w, h } = sizeRef.current;
    return { x: (px - w / 2) / cam.z + cam.x, y: (py - h / 2) / cam.z + cam.y };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const s = simRef.current;
    if (!s) return;
    const hit = nodeAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    if (hit >= 0) {
      /* 拖节点：只重启其邻域（含自身），温度小幅回升——全图重启会浪费
         已收敛的布局成果，也让拖拽中的其它区域无谓晃动 */
      s.active = true;
      s.temp = Math.max(s.temp, 8);
      s.freezeCnt = 0;
      s.hood = new Set([hit, ...s.adj[hit]]);
      dragRef.current = {
        kind: 'node',
        idx: hit,
        sx: e.nativeEvent.offsetX,
        sy: e.nativeEvent.offsetY,
        moved: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    } else {
      dragRef.current = {
        kind: 'pan',
        idx: -1,
        sx: e.nativeEvent.offsetX,
        sy: e.nativeEvent.offsetY,
        moved: false,
      };
      setPop(null);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const s = simRef.current;
    const cam = camRef.current;
    if (!s) return;
    const d = dragRef.current;
    if (d) {
      const dx = e.nativeEvent.offsetX - d.sx;
      const dy = e.nativeEvent.offsetY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      if (d.kind === 'pan') {
        cam.x -= dx / cam.z;
        cam.y -= dy / cam.z;
      } else {
        const n = s.nodes[d.idx];
        const wp = toWorld(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
        n.x = wp.x;
        n.y = wp.y;
        n.vx = 0;
        n.vy = 0;
      }
      d.sx = e.nativeEvent.offsetX;
      d.sy = e.nativeEvent.offsetY;
      e.currentTarget.style.cursor = d.kind === 'pan' ? 'grabbing' : 'grabbing';
      dirtyRef.current = true;
      return;
    }
    /* 悬停检测：目标变了才重建邻域；指针坐标每次都记（HUD 跟随光标），
       悬停中持续置脏让 HUD 每帧贴住光标——无悬停时不置脏（省空转） */
    const hit = nodeAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    const id = hit >= 0 ? s.nodes[hit].id : null;
    hoverRef.current.mx = e.nativeEvent.offsetX;
    hoverRef.current.my = e.nativeEvent.offsetY;
    if (id !== hoverRef.current.id) {
      if (id === null) hoverRef.current = { id: null, nbr: null, mx: hoverRef.current.mx, my: hoverRef.current.my };
      else {
        const nbr = new Set<string>([id]);
        for (const j of s.adj[hit]) nbr.add(s.nodes[j].id);
        hoverRef.current = { id, nbr, mx: hoverRef.current.mx, my: hoverRef.current.my };
      }
      e.currentTarget.style.cursor = id ? 'pointer' : 'grab';
    }
    if (hoverRef.current.id !== null) dirtyRef.current = true;
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = dragRef.current;
    dragRef.current = null;
    const s = simRef.current;
    if (!e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    e.currentTarget.style.cursor = 'grab';
    if (!d || !s) return;
    if (d.kind === 'node') {
      s.hood = null; // 松手放开全图做轻微回弹至再冻结（温度已低，代价极小）
      /* G4 松手回弹：被拖节点 1.15× 在 150ms 内缓回 1× */
      s.recoil = { id: s.nodes[d.idx].id, t0: performance.now() };
      dirtyRef.current = true;
      if (!d.moved) {
        const n = s.nodes[d.idx];
        if (n.type === 'kw' && n.kw) onPickKeyword(n.kw);
        else if (n.type === 'mem' && n.entry)
          setPop({
            id: n.id,
            entry: n.entry,
            x: e.nativeEvent.offsetX,
            y: e.nativeEvent.offsetY,
          });
        else if (n.type === 'agg') {
          setFocusId(n.id);
          setPop(null);
        }
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const s = simRef.current;
    if (!s || mode !== 'rel') return; // 主题模式钻取语义模糊（要换回二部构图），暂不启用
    const hit = nodeAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    if (hit < 0) return;
    const id = s.nodes[hit].id;
    setFocusId(id === focusId ? null : id);
    setPop(null);
  };

  const zoomStep = (factor: number): void => {
    const { w, h } = sizeRef.current;
    const cam = camRef.current;
    const z2 = clamp(cam.z * factor, 0.3, 4);
    if (z2 === cam.z) return;
    cam.z = z2;
    dirtyRef.current = true;
  };
  const resetCam = (): void => {
    const { w, h } = sizeRef.current;
    camRef.current = { x: w / 2, y: h / 2, z: 1 };
    dirtyRef.current = true;
  };

  const onCopy = (entry: MemEntry): void => {
    void copyText(entry.text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
        /* 与时间轴「复制全文」同款闭环：复制即一次实际使用（uses+1 浮顶）；
           记数失败静默——统计是增益，不能打断复制体验 */
        void memUsed(entry.ts).catch(() => {});
      })
      .catch(() => setCopied(false));
  };

  /* ---- 空态与提示（用 model 而不是重算） ---- */
  if (items.length === 0)
    return (
      /* G13 三段式：主文 13px / 副文 11px / 主 CTA。导航回调由 MemTab 注入
         （onGoDictate），图谱保持无路由依赖；未传时 CTA 退化为文案引导 */
      <div className="rounded-lg border border-dashed border-white/10 px-4 py-10 text-center">
        <div className="text-[28px] leading-none opacity-60">🕸️</div>
        <div className="mt-3 text-[13px] leading-6 text-slate-400">
          记忆库还是空的，图谱无内容可画
        </div>
        <div className="mt-1 text-[11px] leading-5 text-slate-600">
          使用听写、截图取词、划词翻译后，产出会自动沉淀，开启 AI 蒸馏后图谱更丰富
        </div>
        {onGoDictate && (
          <div className="mt-3">
            <Button kind="primary" onClick={onGoDictate}>
              去听写 →
            </Button>
          </div>
        )}
      </div>
    );

  const kwTotal = model.kwCount.size;
  const rangeEmpty = model.items.length === 0;
  const noKw = mode === 'rel' && kwTotal === 0;
  const focusLabel = (() => {
    if (!focusId) return '';
    if (focusId.startsWith('kw:')) return focusId.slice(3);
    if (focusId === 'agg:other') return '长尾关键词';
    if (focusId === 'agg:undistilled') return '未蒸馏记忆';
    const it = model.items.find((x) => `mem:${x.ts}` === focusId);
    return it ? it.title : '';
  })();

  /* 工具行 chips（G10/S3）：active 段补 font-medium 强化「当前档」；
     过渡只声明颜色属性，时长统一 150ms */
  const chipCls = (on: boolean): string =>
    `rounded-full border px-2.5 py-1 text-[11px] transition-colors duration-150 ${
      on
        ? 'border-sky-500/60 bg-sky-500/10 font-medium text-sky-300'
        : 'border-white/10 bg-black/20 text-slate-400 hover:border-white/25 hover:text-slate-200'
    }`;

  return (
    <div>
      {/* 工具行：模式切换（聚焦时换成「返回全图」）/ 时间档位 / 缩放（G10/G11） */}
      <div className="flex flex-wrap items-center gap-2">
        {mode === 'rel' && focusId ? (
          <>
            <button
              type="button"
              onClick={() => setFocusId(null)}
              className="rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-[11px] text-amber-300 transition-colors duration-150 hover:bg-amber-400/20"
            >
              ⟲ 返回全图
            </button>
            <span className="min-w-0 truncate text-[11px] text-slate-500" title={focusLabel}>
              聚焦：{focusLabel.length > 24 ? `${focusLabel.slice(0, 23)}…` : focusLabel}
            </span>
          </>
        ) : (
          <div className="flex rounded-full border border-white/10 bg-black/20 p-0.5">
            {(
              [
                { m: 'rel' as const, label: '关联' },
                { m: 'topic' as const, label: '主题' },
              ]
            ).map((o) => (
              <button
                key={o.m}
                type="button"
                onClick={() => {
                  setMode(o.m);
                  setFocusId(null);
                }}
                title={o.m === 'rel' ? '关键词-记忆二部图' : '关键词共现图（边宽∝共现次数）'}
                className={`rounded-full px-3 py-1 text-[11px] transition-colors duration-150 ${
                  mode === o.m
                    ? 'bg-sky-500/15 font-medium text-sky-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
        <span className="flex-1" />
        {([0, 7, 30, 90] as const).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRange(r)}
            className={chipCls(range === r)}
          >
            {r === 0 ? '全部' : `近${r}天`}
          </button>
        ))}
        <span className="text-slate-700">·</span>
        {/* 缩放图标按钮（G10）：h-6 w-6 无边框幽灵样式，与档位 chips 分层 */}
        <button
          type="button"
          title="放大"
          onClick={() => zoomStep(1.25)}
          className="flex h-6 w-6 items-center justify-center rounded-full text-[13px] text-slate-400 transition-colors duration-150 hover:bg-white/10 hover:text-slate-200"
        >
          ＋
        </button>
        <button
          type="button"
          title="缩小"
          onClick={() => zoomStep(0.8)}
          className="flex h-6 w-6 items-center justify-center rounded-full text-[13px] text-slate-400 transition-colors duration-150 hover:bg-white/10 hover:text-slate-200"
        >
          －
        </button>
        {/* 重置视图（G11）：kbd「0」徽章对应下方 wrap 的 keydown 快捷键 */}
        <button
          type="button"
          title="重置视图（快捷键 0）"
          onClick={resetCam}
          className="flex h-6 items-center gap-1 rounded-full px-1.5 text-[13px] text-slate-400 transition-colors duration-150 hover:bg-white/10 hover:text-slate-200"
        >
          ⟲<span className="kbd">0</span>
        </button>
      </div>

      {/* 引导横幅：库没关键词时图谱退化为聚合节点，提前点破原因 */}
      {noKw && (
        <div className="rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3.5 py-2.5 text-[11.5px] leading-5 text-amber-200/90">
          尚无关键词：开启 AI 蒸馏或在导入时生成关键词后，图谱更丰富。当前可点击「未蒸馏」节点展开纯文本记忆
        </div>
      )}
      {rangeEmpty && (
        <div className="rounded-lg border border-dashed border-white/10 py-6 text-center text-xs text-slate-600">
          该时间范围内没有记忆，试试切回「全部」
        </div>
      )}

      {/* tabIndex 让画布可聚焦接收「0 重置」（G11 徽章的对应快捷键）；
          focus-visible 才出环——鼠标点击不闪蓝框 */}
      <div
        ref={wrapRef}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === '0') {
            e.preventDefault();
            resetCam();
          }
        }}
        className="relative h-[420px] touch-none overflow-hidden rounded-xl border border-white/[0.06] bg-black/20 outline-none focus-visible:ring-1 focus-visible:ring-sky-400/40"
      >
        <canvas
          ref={canvasRef}
          aria-label="记忆知识图谱"
          className="block h-full w-full"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={onDoubleClick}
        />
        {/* 操作提示（DOM 而非 canvas 文字：不参与重绘，主题自动适配） */}
        <div className="pointer-events-none absolute bottom-1.5 right-2.5 text-[10px] text-slate-600">
          滚轮缩放 · 拖背景平移 · 拖节点重排 · 双击聚焦
        </div>

        {/* 记忆节点详情弹层：点击位置锚定，pan/zoom 即关闭（见 effect 注释）。
            G8：anim-pop 入场 + card-lift 同款双层阴影（比笼统的 shadow-xl 更贴桌面） */}
        {pop && (
          <div
            className="anim-pop absolute z-20 w-[280px] rounded-xl border border-white/10 bg-[#12121a]/95 p-3 backdrop-blur shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55),0_2px_6px_-2px_rgba(0,0,0,0.3)]"
            style={{
              left: clamp(pop.x + 12, 8, Math.max(8, sizeRef.current.w - 292)),
              top: clamp(pop.y + 10, 8, Math.max(8, sizeRef.current.h - 190)),
            }}
          >
            <div className="flex items-center gap-2">
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${
                  KIND_CLS[pop.entry.kind]
                }`}
              >
                {KIND_LABEL[pop.entry.kind]}
              </span>
              {pop.entry.distilled && (
                <span title="AI 蒸馏" className="shrink-0 text-[11px]">
                  ✨
                </span>
              )}
              <span
                className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-200"
                title={pop.entry.title}
              >
                {pop.entry.title}
              </span>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setPop(null)}
                className="shrink-0 rounded px-1 text-[12px] text-slate-500 transition-colors duration-150 hover:text-slate-200"
              >
                ✕
              </button>
            </div>
            <div className="sn-scroll mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-5 text-slate-400">
              {pop.entry.text.slice(0, 200)}
              {pop.entry.text.length > 200 && '…'}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10.5px] text-slate-600">
              {pop.entry.app && (
                <span className="font-mono" title="采集时的前台应用">
                  {pop.entry.app}
                </span>
              )}
              <span>{relTime(pop.entry.ts)}</span>
              <span className="tabular-nums">{pop.entry.chars} 字</span>
              {!!pop.entry.keywords.length && (
                <span className="truncate" title={pop.entry.keywords.join('、')}>
                  # {pop.entry.keywords.slice(0, 4).join(' / ')}
                </span>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => onCopy(pop.entry)}
                className={`rounded px-2 py-1 text-[11px] transition-colors duration-150 ${
                  copied
                    ? 'text-emerald-400'
                    : 'text-sky-400 hover:bg-white/10 hover:text-sky-300'
                }`}
              >
                {copied ? '已复制 ✓' : '复制全文'}
              </button>
              {mode === 'rel' && (
                <button
                  type="button"
                  onClick={() => {
                    setFocusId(pop.id === focusId ? null : pop.id);
                    setPop(null);
                  }}
                  className="rounded px-2 py-1 text-[11px] text-slate-400 transition-colors duration-150 hover:bg-white/10 hover:text-slate-200"
                  title="以此为中心展开 1 跳邻域"
                >
                  🔍 聚焦
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 图例：与时间轴类型徽章同色系，跨视图不重新学习。
          G12 悬停联动：hover 某行 → 该类节点 alpha 收敛到 1、其余 0.15
          （复用 G1 补间，写入 legendRef + 置脏即可，无 React 重渲染） */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-slate-500">
        {(
          [
            { sel: 'kw', dot: <span className="h-2.5 w-2.5 rounded-full border border-sky-400 bg-sky-400/25" />, label: '关键词（大小∝条数）' },
            ...(Object.keys(KIND_LABEL) as MemEntry['kind'][]).map((k) => ({
              sel: k as string,
              dot: (
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: `rgb(${KIND_RGB[k].join(',')})` }}
                />
              ),
              label: KIND_LABEL[k],
            })),
            { sel: 'agg', dot: <span className="h-2.5 w-2.5 rounded-full border border-dashed border-slate-400" />, label: '聚合（点击展开）' },
          ] as { sel: string; dot: ReactNode; label: string }[]
        ).map((row) => (
          <span
            key={row.sel}
            className="flex cursor-default items-center gap-1 transition-opacity duration-150 hover:opacity-100"
            onMouseEnter={() => {
              legendRef.current = row.sel;
              dirtyRef.current = true;
            }}
            onMouseLeave={() => {
              legendRef.current = null;
              dirtyRef.current = true;
            }}
          >
            {row.dot}
            {row.label}
          </span>
        ))}
      </div>
    </div>
  );
}
