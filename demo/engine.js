/*
 * ノード・ドミニオン — 決定論ゲームエンジン (demo)
 *
 * docs/games/cyber-data-scramble/ の GDD.md / ai-interface.md を実装したもの。
 * サーバー権威の検証 (validateActions) と決定論的な tick ループ (step) を提供する。
 * ブラウザから <script> で読み込み、グローバル `Engine` を公開する。
 *
 * 1 tick = 1 ゲーム秒。乱数は使わず、入力が同じなら結果は完全に同一（決定論）。
 */
(function (global) {
  "use strict";

  // ---- 定数（GDD.md の数値表と一致させる） -------------------------------
  const UNITS = {
    assault:  { atk: 10, hp: 20, move: 1, cost: 40, label: "突撃" },
    guard:    { atk: 6,  hp: 35, move: 1, cost: 50, label: "防衛" },
    skirmish: { atk: 7,  hp: 15, move: 2, cost: 45, label: "機動" },
  };
  const UNIT_TYPES = ["assault", "guard", "skirmish"];

  // 三すくみ: 突撃→機動→防衛→突撃
  const BEATS = { assault: "skirmish", skirmish: "guard", guard: "assault" };
  const MULT_ADV = 1.5;
  const MULT_DIS = 0.67;

  const FORTIFY_REDUCTION = 0.12; // 1段ごとの被ダメ軽減
  const FORTIFY_MAX = 3;
  const FORTIFY_SP = 30;
  const GUARD_DEFEND_BONUS = 0.15; // 防衛が守備時の追加軽減

  const SP_INIT = 300;
  const SP_HOME = 5;       // /tick
  const SP_SUPPLY = 3;     // /tick
  const CP_REGEN = 10;     // /tick
  const CP_CAP_BASE = 100;
  const CP_CAP_GROW_FROM = 90; // tick
  const CP_CAP_GROW = 2;       // /tick
  const CP_CAP_MAX = 160;

  const CP_COST = { attack: 1, move: 1, reinforce: 1, retreat: 1, produce: 2, fortify: 2, scout: 1, use_special: 0, idle: 0 };
  const MAX_ACTIONS = 6;

  const HOME_HP_REF = 200; // home_hp_pct 算出の基準（守備兵HP合計）
  const SCORCHED_HP_THRESHOLD = 10; // %

  const ROUND_LIMIT = { S: 120, M: 180, L: 240 };

  // 中立守備（占領するには排除が必要）
  const NEUTRAL_GARRISON = { normal: { guard: 1 }, supply: { guard: 1.5 }, fortress: { guard: 2 } };
  const FORTIFY_INIT = { home: 1, fortress: 2, supply: 0, normal: 0 };

  // マップテンプレート（列ごとのノード数。回文＝左右対称）
  const MAP_TEMPLATE = {
    S: [2, 1, 2],          // 中間5
    M: [2, 3, 1, 3, 2],    // 中間11
    L: [3, 4, 5, 4, 3],    // 中間19
  };

  // ---- ユーティリティ -----------------------------------------------------
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
  function emptyStack() { return { assault: 0, guard: 0, skirmish: 0 }; }
  function stackHp(g) { return UNIT_TYPES.reduce((s, t) => s + g[t] * UNITS[t].hp, 0); }
  function stackCount(g) { return UNIT_TYPES.reduce((s, t) => s + g[t], 0); }
  function dominantType(g) {
    let best = null, bv = -1;
    for (const t of UNIT_TYPES) if (g[t] > bv) { bv = g[t]; best = t; }
    return bv > 0 ? best : null;
  }
  function rpsMult(att, def) {
    if (!att || !def) return 1.0;
    if (BEATS[att] === def) return MULT_ADV;
    if (BEATS[def] === att) return MULT_DIS;
    return 1.0;
  }
  function estimateBucket(hp) {
    if (hp <= 0) return "low";
    if (hp < 40) return "low";
    if (hp < 100) return "mid";
    return "high";
  }

  // ---- マップ生成（決定論・左右対称） -------------------------------------
  function createMap(size) {
    const cols = MAP_TEMPLATE[size];
    const COLS = cols.length;
    const maxRows = Math.max(...cols);
    const nodes = {};
    const colNodeIds = []; // 列ごとの id 配列

    // 中間ノードを配置
    let idx = 0;
    for (let c = 0; c < COLS; c++) {
      const rows = cols[c];
      const ids = [];
      for (let r = 0; r < rows; r++) {
        const id = "n" + (idx++);
        // y を列内で中央寄せ
        const y = (r - (rows - 1) / 2);
        const isCenterCol = c === Math.floor(COLS / 2);
        const isCenterNode = isCenterCol && Math.abs(y) < 0.6;
        let type = "normal";
        if (isCenterNode) type = "fortress";
        else if (c === 0 || c === COLS - 1) type = "supply"; // 両陣営の近接列は補給
        nodes[id] = {
          id, type, owner: null,
          col: c + 1, row: y,
          pos: { x: (c + 1) / (COLS + 1), y: 0.5 + y / (maxRows + 1) },
          connections: [],
          fortify: FORTIFY_INIT[type] || 0,
          garrison: Object.assign(emptyStack(), NEUTRAL_GARRISON[type]),
        };
        ids.push(id);
      }
      colNodeIds.push(ids);
    }

    // 本拠地
    nodes["A_home"] = {
      id: "A_home", type: "home", owner: "A", col: 0, row: 0,
      pos: { x: 0.5 / (COLS + 1), y: 0.5 },
      connections: [], fortify: FORTIFY_INIT.home,
      garrison: { assault: 0, guard: 4, skirmish: 0 },
    };
    nodes["B_home"] = {
      id: "B_home", type: "home", owner: "B", col: COLS + 1, row: 0,
      pos: { x: (COLS + 0.5) / (COLS + 1), y: 0.5 },
      connections: [], fortify: FORTIFY_INIT.home,
      garrison: { assault: 0, guard: 4, skirmish: 0 },
    };

    // エッジ: 隣接列で row 距離 <= 1.05 を接続。同列の縦隣接も接続。
    function connect(a, b) {
      if (a === b) return;
      if (!nodes[a].connections.includes(b)) nodes[a].connections.push(b);
      if (!nodes[b].connections.includes(a)) nodes[b].connections.push(a);
    }
    for (let c = 0; c < COLS; c++) {
      // 縦隣接
      for (let i = 0; i + 1 < colNodeIds[c].length; i++) connect(colNodeIds[c][i], colNodeIds[c][i + 1]);
      // 次列との接続
      if (c + 1 < COLS) {
        for (const a of colNodeIds[c]) for (const b of colNodeIds[c + 1]) {
          if (Math.abs(nodes[a].row - nodes[b].row) <= 1.05) connect(a, b);
        }
      }
    }
    // 本拠地は最寄り列へ
    for (const b of colNodeIds[0]) connect("A_home", b);
    for (const b of colNodeIds[COLS - 1]) connect("B_home", b);

    return { size, total_nodes: Object.keys(nodes).length, nodes, colNodeIds, COLS };
  }

  // ---- マッチ生成 ---------------------------------------------------------
  function createMatch(opts) {
    const size = opts.size || "M";
    const map = createMap(size);
    const sideState = () => ({
      cp: CP_CAP_BASE, cp_cap: CP_CAP_BASE, sp: SP_INIT,
      specials: {
        surge: { charge: 0, ready: false, active: 0, cooldownProduce: 0 },
        recon: { charge: 0, ready: false, used: false, active: 0 },
        scorched: { used: false },
      },
      effects: { spMult: 1, atkBonus: 1, produceBlocked: 0, reinforceBlocked: 0, revealAll: 0 },
      lostThisTick: 0,
    });
    return {
      match_id: opts.match_id || "demo",
      seed: opts.seed || 1,
      round: opts.round || 1,
      tick: 0,
      tick_rate_hz: 1,
      phase: "battle",
      deadline_ms: opts.deadline_ms || 1000,
      round_limit: ROUND_LIMIT[size],
      map,
      A: sideState(),
      B: sideState(),
      events: [],
      over: false,
      winner: null,
      reasons: { A: "", B: "" },
    };
  }

  function node(state, id) { return state.map.nodes[id]; }
  function adjacent(state, a, b) { const n = node(state, a); return !!n && n.connections.includes(b); }
  function ownedNodes(state, side) { return Object.values(state.map.nodes).filter(n => n.owner === side); }
  function countControl(state, side) {
    let yours = 0, enemy = 0, neutral = 0;
    for (const n of Object.values(state.map.nodes)) {
      if (n.owner === side) yours++;
      else if (n.owner === null) neutral++;
      else enemy++;
    }
    return { yours, enemy, neutral };
  }
  function homeHpPct(state, side) {
    const h = node(state, side + "_home");
    return clamp(Math.round(stackHp(h.garrison) / HOME_HP_REF * 100), 0, 100);
  }
  function totalUnits(state, side) {
    const tot = emptyStack();
    for (const n of ownedNodes(state, side)) for (const t of UNIT_TYPES) tot[t] += n.garrison[t];
    return tot;
  }

  // ---- 部分観測ビュー (霧) -------------------------------------------------
  function buildView(state, side) {
    const foe = side === "A" ? "B" : "A";
    const reveal = state[side].effects.revealAll > 0;
    const visibleIds = new Set();
    // 自軍ノード＋その隣接
    for (const n of ownedNodes(state, side)) {
      visibleIds.add(n.id);
      for (const c of n.connections) visibleIds.add(c);
    }
    if (reveal) for (const id in state.map.nodes) visibleIds.add(id);

    const youNodes = ownedNodes(state, side).map(n => ({
      id: n.id, type: n.type, owner: n.owner, pos: [n.col, +n.row.toFixed(2)],
      connections: n.connections.slice(), fortify: n.fortify,
      garrison: { assault: r1(n.garrison.assault), guard: r1(n.garrison.guard), skirmish: r1(n.garrison.skirmish) },
    }));

    const known = [];
    let totalEnemy = 0, seenEnemy = 0;
    for (const n of Object.values(state.map.nodes)) {
      if (n.owner === foe) {
        totalEnemy++;
        if (n.id.endsWith("_home")) continue; // 本拠地は別枠
      }
      if (n.owner === side) continue;
      if (!visibleIds.has(n.id)) continue;
      if (n.id.endsWith("_home")) continue;
      if (n.owner === foe) seenEnemy++;
      const fogged = !reveal && !ownedAdjacent(state, side, n.id);
      known.push({
        id: n.id,
        type: fogged ? "unknown" : n.type,
        owner: n.owner,
        pos: [n.col, +n.row.toFixed(2)],
        connections: n.connections.map(c => (visibleIds.has(c) ? c : "?")),
        fortify_estimate: estimateBucket(n.fortify * 40),
        strength_estimate: estimateBucket(stackHp(n.garrison)),
        last_seen_tick: state.tick,
      });
    }

    const foeHome = node(state, foe + "_home");
    const ctrl = countControl(state, side);

    return {
      schema_version: "2.0",
      match_id: state.match_id, round: state.round, tick: state.tick,
      tick_rate_hz: state.tick_rate_hz, phase: state.phase, deadline_ms: state.deadline_ms,
      map: { size: state.map.size, total_nodes: state.map.total_nodes },
      you: {
        side,
        resources: { cp: r1(state[side].cp), cp_cap: state[side].cp_cap, cp_regen: CP_REGEN, sp: r1(state[side].sp) },
        home_base: { id: side + "_home", hp_pct: homeHpPct(state, side), fortify: node(state, side + "_home").fortify },
        node_control: ctrl,
        nodes: youNodes,
        units_total: roundStack(totalUnits(state, side)),
      },
      enemy: {
        side: foe,
        visibility_pct: totalEnemy ? Math.round((seenEnemy / totalEnemy) * 100) : 0,
        home_base: { id: foe + "_home", hp_estimate: estimateBucket(stackHp(foeHome.garrison)) },
        known_nodes: known,
      },
      recent_events: state.events.slice(-6),
      specials: {
        surge: { charge_pct: Math.round(state[side].specials.surge.charge), ready: state[side].specials.surge.ready },
        recon: { charge_pct: Math.round(state[side].specials.recon.charge), ready: state[side].specials.recon.ready },
        scorched: {
          available: homeHpPct(state, side) < SCORCHED_HP_THRESHOLD && !state[side].specials.scorched.used,
          reason: homeHpPct(state, side) < SCORCHED_HP_THRESHOLD ? "home_critical" : "home_hp_above_threshold",
        },
      },
    };
  }
  function ownedAdjacent(state, side, id) {
    const n = node(state, id);
    return n.connections.some(c => node(state, c).owner === side);
  }
  function r1(v) { return Math.round(v * 10) / 10; }
  function roundStack(g) { return { assault: r1(g.assault), guard: r1(g.guard), skirmish: r1(g.skirmish) }; }

  // ---- 行動検証 (サーバー権威) --------------------------------------------
  function validateActions(raw, state, side) {
    const out = [];
    if (!raw || !Array.isArray(raw.actions)) return out;
    let cpLeft = state[side].cp;
    const usedSources = new Set(); // 同一ノード×種別の重複移動を禁止
    const view = buildView(state, side);
    const knownIds = new Set(view.enemy.known_nodes.filter(n => n.type !== "unknown").map(n => n.id));

    for (const a0 of raw.actions) {
      if (out.length >= MAX_ACTIONS) break;
      if (!a0 || typeof a0.op !== "string") continue;
      let op = a0.op;
      if (op === "reinforce" || op === "retreat") op = "move";
      const a = Object.assign({}, a0, { op });
      const cost = CP_COST[a.op];
      if (cost === undefined) continue;
      if (cost > cpLeft) continue; // CP超過は不採用

      if (a.op === "move" || a.op === "attack") {
        if (!a.from || !a.to || !UNIT_TYPES.includes(a.unit_type)) continue;
        const src = node(state, a.from), dst = node(state, a.to);
        if (!src || !dst) continue;
        if (src.owner !== side) continue;                  // 自軍ノードからのみ
        if (!adjacent(state, a.from, a.to)) continue;      // 隣接性
        const key = a.from + ":" + a.unit_type;
        if (usedSources.has(key)) continue;                // 重複移動禁止
        const avail = src.garrison[a.unit_type];
        const count = clamp(Math.floor((a.count || 0) * 10) / 10, 0, avail);
        if (count <= 0) continue;
        // 霧: 見えない敵/中立ノードへの侵攻は不可（自軍/可視ノードのみ）
        if (dst.owner !== side) {
          if (dst.owner !== null && !knownIds.has(a.to) && !a.to.endsWith("_home")) continue;
        }
        usedSources.add(key);
        out.push({ op: a.op, from: a.from, to: a.to, unit_type: a.unit_type, count });
        cpLeft -= cost;
      } else if (a.op === "produce") {
        if (!UNIT_TYPES.includes(a.unit_type)) continue;
        if (state[side].effects.produceBlocked > 0) continue;
        let count = clamp(Math.floor(a.count || 1), 1, 5);
        const spCost = UNITS[a.unit_type].cost * count;
        if (spCost > state[side].sp) {
          count = Math.floor(state[side].sp / UNITS[a.unit_type].cost);
          if (count <= 0) continue;
        }
        out.push({ op: "produce", unit_type: a.unit_type, count });
        cpLeft -= cost;
      } else if (a.op === "fortify") {
        const n = node(state, a.node);
        if (!n || n.owner !== side) continue;
        if (n.fortify >= FORTIFY_MAX) continue;
        if (state[side].sp < FORTIFY_SP) continue;
        out.push({ op: "fortify", node: a.node });
        cpLeft -= cost;
      } else if (a.op === "scout") {
        const target = a.node || a.area;
        out.push({ op: "scout", node: target });
        cpLeft -= cost;
      } else if (a.op === "use_special") {
        if (!["surge", "recon", "scorched"].includes(a.special)) continue;
        out.push({ op: "use_special", special: a.special });
      } else if (a.op === "idle") {
        out.push({ op: "idle" });
      }
    }
    return out;
  }

  // ---- 1 tick 進行 --------------------------------------------------------
  // rawA / rawB は各エージェントの生出力 {reason, actions}
  function step(state, rawA, rawB) {
    if (state.over) return state;
    state.reasons.A = (rawA && rawA.reason) || "";
    state.reasons.B = (rawB && rawB.reason) || "";
    state.A.lostThisTick = 0; state.B.lostThisTick = 0;

    const actsA = validateActions(rawA, state, "A");
    const actsB = validateActions(rawB, state, "B");

    // CP 消費
    spendCp(state, "A", actsA);
    spendCp(state, "B", actsB);

    // 生産・強化・索敵・スペシャル（即時）
    applyImmediate(state, "A", actsA);
    applyImmediate(state, "B", actsB);

    // 移動・攻撃 → 到着を集約
    const arrivals = {}; // nodeId -> { A:{stack}, B:{stack} }
    collectMoves(state, "A", actsA, arrivals);
    collectMoves(state, "B", actsB, arrivals);

    // 到着先ごとに解決
    for (const nid in arrivals) resolveNode(state, nid, arrivals[nid]);

    // 戦闘成功報酬・防御成功報酬
    // (resolveNode 内で events に記録、報酬は下で集計)

    // リソース更新
    accrueSupply(state, "A");
    accrueSupply(state, "B");
    regenCp(state, "A");
    regenCp(state, "B");
    updateSpecials(state, "A");
    updateSpecials(state, "B");
    tickEffects(state, "A");
    tickEffects(state, "B");

    state.tick++;
    checkOver(state);
    return state;
  }

  function spendCp(state, side, acts) {
    let c = 0;
    for (const a of acts) c += (CP_COST[a.op] || 0);
    state[side].cp = clamp(state[side].cp - c, 0, state[side].cp_cap);
  }

  function applyImmediate(state, side, acts) {
    for (const a of acts) {
      if (a.op === "produce") {
        const home = node(state, side + "_home");
        home.garrison[a.unit_type] += a.count;
        state[side].sp -= UNITS[a.unit_type].cost * a.count;
        logEvent(state, { type: "produce", side, unit: a.unit_type, count: a.count });
      } else if (a.op === "fortify") {
        const n = node(state, a.node);
        n.fortify = clamp(n.fortify + 1, 0, FORTIFY_MAX);
        state[side].sp -= FORTIFY_SP;
        logEvent(state, { type: "fortify", side, node: a.node, level: n.fortify });
      } else if (a.op === "scout") {
        // 簡易: 偵察ゲージを加速（可視化は revealAll とは別に隣接で担保）
        state[side].specials.recon.charge = clamp(state[side].specials.recon.charge + 6, 0, 100);
      } else if (a.op === "use_special") {
        activateSpecial(state, side, a.special);
      }
    }
  }

  function collectMoves(state, side, acts, arrivals) {
    for (const a of acts) {
      if (a.op !== "move" && a.op !== "attack") continue;
      const src = node(state, a.from);
      const take = Math.min(a.count, src.garrison[a.unit_type]);
      if (take <= 0) continue;
      src.garrison[a.unit_type] -= take;
      if (!arrivals[a.to]) arrivals[a.to] = {};
      if (!arrivals[a.to][side]) arrivals[a.to][side] = emptyStack();
      arrivals[a.to][side][a.unit_type] += take;
    }
  }

  // 到着部隊と既存守備の解決（占領 or 撃退）
  function resolveNode(state, nid, byside) {
    const n = node(state, nid);
    const incA = byside.A || emptyStack();
    const incB = byside.B || emptyStack();
    const hasA = stackCount(incA) > 0, hasB = stackCount(incB) > 0;

    if (n.owner === "A") {
      addStack(n.garrison, incA);                 // 自軍へ合流
      if (hasB) battleAtNode(state, n, "B", incB);// 敵Bが攻撃
    } else if (n.owner === "B") {
      addStack(n.garrison, incB);
      if (hasA) battleAtNode(state, n, "A", incA);
    } else { // 中立
      if (hasA && hasB) {
        // 両者同時侵攻: まず中立守備を強い方が削る簡易処理 → その後 A vs B
        battleNeutralThenContest(state, n, incA, incB);
      } else if (hasA) {
        captureNeutral(state, n, "A", incA);
      } else if (hasB) {
        captureNeutral(state, n, "B", incB);
      }
    }
  }

  function captureNeutral(state, n, side, inc) {
    const defHp = stackHp(n.garrison);
    if (defHp <= 0) { occupy(state, n, side, inc); return; }
    const result = fight(inc, n.garrison, n, /*attackerSide*/ side, /*defenderNeutral*/ true);
    if (stackCount(result.def) <= 0 && stackCount(result.att) > 0) {
      n.garrison = emptyStack();
      occupy(state, n, side, result.att);
      logEvent(state, { type: "node_captured", node: n.id, by: side, from: "neutral" });
      reward(state, side, "capture");
    } else {
      n.garrison = result.def; // 中立が残存
    }
  }

  function battleNeutralThenContest(state, n, incA, incB) {
    // どちらも中立守備と戦い、生存者同士で取り合う簡易モデル
    let a = incA, b = incB;
    if (stackHp(n.garrison) > 0) {
      const ra = fight(a, deepClone(n.garrison), n, "A", true); a = ra.att;
      const rb = fight(b, deepClone(n.garrison), n, "B", true); b = rb.att;
      n.garrison = emptyStack();
    }
    const ca = stackCount(a), cb = stackCount(b);
    if (ca <= 0 && cb <= 0) return;
    if (ca > 0 && cb <= 0) { occupy(state, n, "A", a); logEvent(state, { type: "node_captured", node: n.id, by: "A", from: "neutral" }); }
    else if (cb > 0 && ca <= 0) { occupy(state, n, "B", b); logEvent(state, { type: "node_captured", node: n.id, by: "B", from: "neutral" }); }
    else {
      const r = fight(a, b, n, "A", false);
      if (stackCount(r.att) > 0) { occupy(state, n, "A", r.att); logEvent(state, { type: "node_captured", node: n.id, by: "A", from: "contested" }); }
      else if (stackCount(r.def) > 0) { occupy(state, n, "B", r.def); logEvent(state, { type: "node_captured", node: n.id, by: "B", from: "contested" }); }
    }
  }

  function battleAtNode(state, n, attackerSide, inc) {
    const defenderSide = n.owner;
    const result = fight(inc, n.garrison, n, attackerSide, false);
    if (stackCount(result.def) <= 0 && stackCount(result.att) > 0) {
      // 占領成立
      const wasHome = n.type === "home";
      n.garrison = emptyStack();
      occupy(state, n, attackerSide, result.att);
      state[defenderSide].lostThisTick++;
      logEvent(state, { type: "node_captured", node: n.id, by: attackerSide, from: defenderSide });
      reward(state, attackerSide, "capture");
      if (wasHome) { state.over = true; state.winner = attackerSide; }
    } else {
      // 守備が持ちこたえた → 防御成功報酬
      n.garrison = result.def;
      if (stackCount(result.att) > 0) {
        // 攻撃側生存者は撤退（消滅扱い: デモ簡略化）。記録のみ。
      }
      logEvent(state, { type: "defense_success", node: n.id, side: defenderSide });
      reward(state, defenderSide, "defense");
    }
  }

  // 攻撃スタック att と守備スタック def の戦闘（数ラウンドで決着）
  function fight(att, def, n, attackerSide, defenderNeutral) {
    let A = Object.assign(emptyStack(), att);
    let D = Object.assign(emptyStack(), def);
    const atkBonusA = attackerSide ? (n && state_atkBonus(attackerSide)) : 1;
    for (let round = 0; round < 6; round++) {
      const ca = stackCount(A), cd = stackCount(D);
      if (ca <= 0 || cd <= 0) break;
      const aDom = dominantType(A), dDom = dominantType(D);
      // 攻撃側 → 守備側
      let dmgToD = rawAtk(A) * rpsMult(aDom, dDom) * atkBonusA;
      // 拠点防御（守備側）。突撃が主力なら攻城で軽減を無視
      let red = 0;
      if (aDom !== "assault") red += (n ? n.fortify : 0) * FORTIFY_REDUCTION;
      if (dDom === "guard") red += GUARD_DEFEND_BONUS;
      dmgToD *= (1 - clamp(red, 0, 0.8));
      // 守備側 → 攻撃側
      let dmgToA = rawAtk(D) * rpsMult(dDom, aDom);
      D = applyDamage(D, dmgToD);
      A = applyDamage(A, dmgToA);
    }
    return { att: A, def: D };
  }

  function rawAtk(g) { return UNIT_TYPES.reduce((s, t) => s + g[t] * UNITS[t].atk, 0); }
  function applyDamage(g, dmg) {
    let hp = stackHp(g);
    if (hp <= 0 || dmg <= 0) return g;
    const frac = clamp(1 - dmg / hp, 0, 1);
    const out = emptyStack();
    for (const t of UNIT_TYPES) out[t] = Math.max(0, g[t] * frac);
    // 端数掃除
    for (const t of UNIT_TYPES) if (out[t] < 0.05) out[t] = 0;
    return out;
  }

  function addStack(g, inc) { for (const t of UNIT_TYPES) g[t] += inc[t]; }
  function occupy(state, n, side, stack) {
    n.owner = side;
    n.garrison = Object.assign(emptyStack(), stack);
    if (n.type === "fortress" && n.fortify < FORTIFY_INIT.fortress) n.fortify = FORTIFY_INIT.fortress;
  }

  // 戦闘内で攻撃側のサージ攻撃ボーナスを参照するためのフック
  let _stateRef = null;
  function state_atkBonus(side) { return _stateRef ? _stateRef[side].effects.atkBonus : 1; }

  function reward(state, side, kind) {
    if (kind === "capture") { state[side].sp += 15; state[side].cp = clamp(state[side].cp + 3, 0, state[side].cp_cap); }
    else if (kind === "defense") { state[side].sp += 5; state[side].cp = clamp(state[side].cp + 3, 0, state[side].cp_cap); }
  }

  function accrueSupply(state, side) {
    let inc = 0;
    for (const n of ownedNodes(state, side)) {
      if (n.type === "home") inc += SP_HOME;
      else if (n.type === "supply") inc += SP_SUPPLY;
    }
    inc *= state[side].effects.spMult;
    state[side].sp += inc;
  }

  function regenCp(state, side) {
    if (state.tick >= CP_CAP_GROW_FROM) state[side].cp_cap = clamp(state[side].cp_cap + CP_CAP_GROW, CP_CAP_BASE, CP_CAP_MAX);
    state[side].cp = clamp(state[side].cp + CP_REGEN, 0, state[side].cp_cap);
  }

  function updateSpecials(state, side) {
    const foe = side === "A" ? "B" : "A";
    const sp = state[side].specials;
    const my = countControl(state, side);
    // 劣勢ゲージ（増援サージ）
    let d = 0.5;
    d += Math.max(0, my.enemy - my.yours) * 0.6;
    d += state[side].lostThisTick * 4;
    d -= Math.max(0, my.yours - my.enemy) * 0.5;
    sp.surge.charge = clamp(sp.surge.charge + d, 0, 100);
    sp.surge.ready = sp.surge.charge >= 100 && sp.surge.cooldownProduce === 0;
    // 偵察ゲージ
    sp.recon.charge = clamp(sp.recon.charge + 1, 0, 100);
    sp.recon.ready = sp.recon.charge >= 100 && !sp.recon.used;
  }

  function activateSpecial(state, side, special) {
    const foe = side === "A" ? "B" : "A";
    const sp = state[side].specials;
    if (special === "surge" && sp.surge.ready) {
      sp.surge.charge = 0; sp.surge.ready = false;
      state[side].effects.spMult = 2; state[side].effects.atkBonus = 1.3;
      sp.surge.active = 10; sp.surge.cooldownProduce = 0;
      logEvent(state, { type: "special", side, special: "surge" });
    } else if (special === "recon" && sp.recon.ready) {
      sp.recon.charge = 0; sp.recon.ready = false; sp.recon.used = true;
      state[side].effects.revealAll = 15;
      state[foe].effects.reinforceBlocked = 4;
      state[foe].cp = clamp(state[foe].cp - 40, 0, state[foe].cp_cap);
      logEvent(state, { type: "special", side, special: "recon" });
    } else if (special === "scorched") {
      const home = node(state, side + "_home");
      if (homeHpPct(state, side) < SCORCHED_HP_THRESHOLD && !sp.scorched.used) {
        sp.scorched.used = true;
        home.fortify = clamp(home.fortify + 2, 0, FORTIFY_MAX);
        // 敵に隣接する自軍ノードを中立化（焦土）
        for (const n of ownedNodes(state, side)) {
          if (n.type === "home") continue;
          if (n.connections.some(c => node(state, c).owner === foe)) {
            n.owner = null; n.garrison = Object.assign(emptyStack(), NEUTRAL_GARRISON[n.type] || { guard: 1 });
          }
        }
        state[side].effects.spMult = Math.min(state[side].effects.spMult, 0.5);
        state[side]._scorched = true; // 残ラウンド半減フラグ
        logEvent(state, { type: "special", side, special: "scorched" });
      }
    }
  }

  function tickEffects(state, side) {
    const e = state[side].effects, sp = state[side].specials;
    if (sp.surge.active > 0) {
      sp.surge.active--;
      if (sp.surge.active === 0) { if (!state[side]._scorched) e.spMult = 1; e.atkBonus = 1; sp.surge.cooldownProduce = 5; e.produceBlocked = 5; }
    }
    if (sp.surge.cooldownProduce > 0 && sp.surge.active === 0) { /* produceBlocked 別管理 */ }
    if (e.produceBlocked > 0) e.produceBlocked--;
    if (e.reinforceBlocked > 0) e.reinforceBlocked--;
    if (e.revealAll > 0) e.revealAll--;
    if (state[side]._scorched) e.spMult = 0.5;
  }

  function logEvent(state, ev) { ev.tick = state.tick; state.events.push(ev); if (state.events.length > 200) state.events.shift(); }

  function checkOver(state) {
    if (state.over) return;
    const ctrlA = countControl(state, "A");
    if (node(state, "A_home").owner !== "A") { state.over = true; state.winner = "B"; return; }
    if (node(state, "B_home").owner !== "B") { state.over = true; state.winner = "A"; return; }
    if (state.tick >= state.round_limit) {
      state.over = true;
      const a = ownedNodes(state, "A").length, b = ownedNodes(state, "B").length;
      if (a !== b) state.winner = a > b ? "A" : "B";
      else {
        const ha = homeHpPct(state, "A"), hb = homeHpPct(state, "B");
        if (ha !== hb) state.winner = ha > hb ? "A" : "B";
        else {
          const ua = stackCount(totalUnits(state, "A")), ub = stackCount(totalUnits(state, "B"));
          state.winner = ua >= ub ? "A" : "B";
        }
      }
    }
  }

  // step 中に戦闘ボーナス参照用の _stateRef をセット
  const _origStep = step;
  function stepWrapped(state, rawA, rawB) { _stateRef = state; const r = _origStep(state, rawA, rawB); _stateRef = null; return r; }

  // ---- 公開 ---------------------------------------------------------------
  global.Engine = {
    UNITS, UNIT_TYPES, BEATS, MAP_TEMPLATE, ROUND_LIMIT,
    createMatch, buildView, validateActions, step: stepWrapped,
    node, adjacent, ownedNodes, countControl, homeHpPct, totalUnits,
    helpers: { stackCount, stackHp, rpsMult, dominantType, clamp },
  };
})(typeof window !== "undefined" ? window : globalThis);
