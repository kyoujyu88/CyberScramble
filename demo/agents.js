/*
 * ノード・ドミニオン — エージェント (demo)
 *
 * - NPC: L1 内蔵ルールエンジン（攻撃型 / 防御型 / バランス型のプリセット）
 * - 自前AI: (a) ブラウザ内で編集する JS ポリシー  (b) ローカルLLMエンドポイント(L3)
 *
 * すべてのエージェントは buildView() が返す「部分観測ビュー」を入力に取り、
 * { reason, actions } を返す（同期 or Promise）。実際の採否はサーバー権威の
 * Engine.validateActions() が決める。
 */
(function (global) {
  "use strict";

  const UNITS = global.Engine.UNITS;
  const BEATS = global.Engine.BEATS;
  const UT = global.Engine.UNIT_TYPES;
  const STR_RANK = { low: 1, mid: 2, high: 3 };

  // ---- ビュー操作ヘルパ ---------------------------------------------------
  function visibleMap(view) {
    const m = new Map();
    for (const n of view.you.nodes) m.set(n.id, { id: n.id, owner: n.owner, type: n.type, mine: true, node: n });
    for (const n of view.enemy.known_nodes) m.set(n.id, { id: n.id, owner: n.owner, type: n.type, mine: false, str: n.strength_estimate });
    return m;
  }
  function dir(side) { return side === "A" ? 1 : -1; } // A は col 増加方向が前進
  function colOf(view, id) {
    const own = view.you.nodes.find(n => n.id === id);
    if (own) return own.pos[0];
    const kn = view.enemy.known_nodes.find(n => n.id === id);
    return kn ? kn.pos[0] : null;
  }
  function stackCountOf(g) { return g.assault + g.guard + g.skirmish; }
  function dominant(g) {
    let b = null, v = -1;
    for (const t of UT) if (g[t] > v) { v = g[t]; b = t; }
    return v > 0 ? b : null;
  }
  function counterTo(type) { // type を倒すユニット
    for (const k in BEATS) if (BEATS[k] === type) return k;
    return "guard";
  }
  function enemyDominantGuess(view) {
    // 可視の敵ノードの種別は霧で隠れることが多いので、戦力推定から大雑把に決める
    // ここでは単純に「突撃」を仮置き（守備に防衛を厚くする保守策）
    return "assault";
  }

  // 共通の行動ビルダ。priorities に応じて produce / attack / advance を積む。
  function buildActions(view, opts) {
    const side = view.you.side;
    const me = view.you;
    const cpCost = { attack: 1, move: 1, produce: 2, fortify: 2, scout: 1 };
    let cp = me.resources.cp;
    let sp = me.resources.sp;
    const actions = [];
    const vmap = visibleMap(view);
    const homeId = me.home_base.id;
    const D = dir(side);

    function canSpend(op) { return cp >= cpCost[op] && actions.length < 6; }

    // 0) スペシャル
    if (opts.useSpecials) {
      if (view.specials.surge.ready && me.node_control.enemy > me.node_control.yours) {
        actions.push({ op: "use_special", special: "surge" });
      } else if (view.specials.scorched.available) {
        actions.push({ op: "use_special", special: "scorched" });
      } else if (view.specials.recon.ready && view.enemy.visibility_pct < 50) {
        actions.push({ op: "use_special", special: "recon" });
      }
    }

    // 1) 危機対応: 本拠地が手薄 or 敵隣接
    const homeNode = me.nodes.find(n => n.id === homeId);
    const enemyNearHome = homeNode && homeNode.connections.some(c => { const v = vmap.get(c); return v && v.owner && !v.mine; });
    if ((me.home_base.hp_pct < 35 || enemyNearHome)) {
      if (canSpend("fortify") && sp >= 30 && homeNode && homeNode.fortify < 3) {
        actions.push({ op: "fortify", node: homeId }); cp -= 2; sp -= 30;
      }
      if (canSpend("produce") && sp >= UNITS.guard.cost) {
        actions.push({ op: "produce", unit_type: "guard", count: 1 }); cp -= 2; sp -= UNITS.guard.cost;
      }
      // 後方ユニットを本拠地へ
      for (const n of me.nodes) {
        if (n.id === homeId) continue;
        if (!n.connections.includes(homeId)) continue;
        const t = ["guard", "assault", "skirmish"].find(x => n.garrison[x] > 0);
        if (t && canSpend("move")) { actions.push({ op: "reinforce", from: n.id, to: homeId, unit_type: t, count: n.garrison[t] }); cp -= 1; }
      }
    }

    // 2) CP 不足なら温存
    if (cp < 2 && actions.length === 0) return { reason: "CP不足のため温存（idle）", actions: [{ op: "idle" }] };

    // 3) 生産（CP/SPに余裕があれば構成を整える）
    const myTotal = me.units_total;
    const wantCounter = counterTo(enemyDominantGuess(view));
    while (canSpend("produce") && sp >= UNITS[opts.produceType || wantCounter].cost && countProduced(actions) < (opts.maxProduce || 1)) {
      const t = opts.produceType || (stackCountOf(myTotal) < 4 ? "assault" : wantCounter);
      if (sp < UNITS[t].cost) break;
      actions.push({ op: "produce", unit_type: t, count: 1 }); cp -= 2; sp -= UNITS[t].cost;
    }

    // 4) 攻撃: 自軍ノード→可視の敵/中立の最弱ターゲット
    const attackCandidates = [];
    for (const n of me.nodes) {
      const force = stackCountOf(n.garrison);
      if (force <= 0) continue;
      for (const c of n.connections) {
        const v = vmap.get(c);
        if (!v) continue;            // 霧の向こうは攻撃不可
        if (v.mine) continue;
        const targetStr = v.owner === null ? 1 : (STR_RANK[v.str] || 2);
        attackCandidates.push({ from: n.id, to: c, force, targetStr, neutral: v.owner === null });
      }
    }
    attackCandidates.sort((a, b) => (a.targetStr - b.targetStr) || (b.force - a.force));
    const usedSrc = new Set();
    for (const cand of attackCandidates) {
      if (!canSpend("attack")) break;
      const n = me.nodes.find(x => x.id === cand.from);
      const t = pickAttacker(n.garrison);
      const key = cand.from + ":" + t;
      if (!t || usedSrc.has(key)) continue;
      // 攻撃に十分な戦力があるときだけ（守備が強いと無謀）
      const send = n.garrison[t];
      if (send <= 0) continue;
      if (!opts.aggressive && cand.targetStr >= 3 && stackCountOf(n.garrison) < 4) continue;
      usedSrc.add(key);
      actions.push({ op: "attack", from: cand.from, to: cand.to, unit_type: t, count: send });
      cp -= 1;
    }

    // 5) 前進: 後方ユニットを敵方向の隣接へ寄せる
    for (const n of me.nodes) {
      if (!canSpend("move")) break;
      if (n.id === homeId && me.home_base.hp_pct < 50) continue;
      const total = stackCountOf(n.garrison);
      if (total <= 0) continue;
      // 既にこのノードから攻撃を出していたらスキップ
      if (actions.some(a => a.from === n.id)) continue;
      const fwd = n.connections
        .map(c => ({ c, col: colOf(view, c), v: vmap.get(c) }))
        .filter(o => o.col !== null && o.v && (o.v.mine || o.v.owner === null))
        .sort((a, b) => D * (b.col - a.col)); // 敵方向（前進）優先
      if (fwd.length) {
        const t = ["skirmish", "assault", "guard"].find(x => n.garrison[x] > 0);
        if (t) { actions.push({ op: "move", from: n.id, to: fwd[0].c, unit_type: t, count: n.garrison[t] }); cp -= 1; }
      }
    }

    if (actions.length === 0) actions.push({ op: "idle" });
    return { reason: opts.reason || "前線を押し上げつつ生産で補充", actions };
  }

  function countProduced(actions) { return actions.filter(a => a.op === "produce").length; }
  function pickAttacker(g) {
    // 攻撃には突撃 > 機動 > 防衛 の優先（攻城・機動性）
    return ["assault", "skirmish", "guard"].find(t => g[t] > 0) || null;
  }

  // ---- NPC プリセット (L1) ------------------------------------------------
  const PRESETS = {
    balanced: (view) => buildActions(view, { reason: "バランス型: 占領拡大と防衛の両立", useSpecials: true, maxProduce: 1 }),
    aggressive: (view) => buildActions(view, { reason: "攻撃型: 突撃を量産し敵本拠地へ前進", useSpecials: true, aggressive: true, produceType: "assault", maxProduce: 2 }),
    defensive: (view) => buildActions(view, { reason: "防御型: 防衛を固め時間切れの占領数勝ちを狙う", useSpecials: true, produceType: "guard", maxProduce: 2 }),
  };

  // ---- 自前AI: 既定の JS ポリシー（ユーザーが編集して上書き可） ----------
  const DEFAULT_JS_POLICY = `// 自前AI ポリシー: function decide(state) を実装する。
// state は ai-interface.md の部分観測ビュー(JSON)。{ reason, actions } を返す。
// 利用可能: state.you.nodes / state.enemy.known_nodes / state.specials など。
// CP/行動数/隣接性/霧 はサーバー(Engine.validateActions)が強制するので安全。
function decide(state) {
  const me = state.you;
  const actions = [];
  const homeId = me.home_base.id;
  const HOME_RESERVE = 2; // 本拠地に残す最低戦力

  // 1) 生産: 本拠地が危なければ防衛、それ以外は突撃
  if (me.home_base.hp_pct < 40 && me.resources.sp >= 50) {
    actions.push({ op: "produce", unit_type: "guard", count: 1 });
  } else if (me.resources.sp >= 40) {
    actions.push({ op: "produce", unit_type: "assault", count: 1 });
  }

  // 2) 逆転札: 劣勢でサージが溜まっていれば撃つ
  if (state.specials.surge.ready && me.node_control.enemy > me.node_control.yours) {
    actions.push({ op: "use_special", special: "surge" });
  }

  // 3) 可視ノードを把握
  const visible = new Map();
  me.nodes.forEach(n => visible.set(n.id, { mine: true }));
  state.enemy.known_nodes.forEach(n => visible.set(n.id, { mine: false, owner: n.owner }));

  // 4) 各ノードから: 可視の敵/中立を攻撃、無ければ敵方向へ前進（本拠地は予備を残す）
  const fwdSign = me.side === "A" ? 1 : -1;
  const colOf = (id) => {
    const o = me.nodes.find(n => n.id === id); if (o) return o.pos[0];
    const k = state.enemy.known_nodes.find(n => n.id === id); return k ? k.pos[0] : null;
  };
  for (const n of me.nodes) {
    if (actions.length >= 6) break;
    const reserve = n.id === homeId ? HOME_RESERVE : 0;
    const t = ["assault", "skirmish", "guard"].find(x => n.garrison[x] > 0);
    if (!t) continue;
    const movable = Math.max(0, n.garrison[t] - reserve);
    if (movable <= 0) continue;
    const target = n.connections.find(c => { const v = visible.get(c); return v && !v.mine; });
    if (target) {
      actions.push({ op: "attack", from: n.id, to: target, unit_type: t, count: movable });
    } else {
      const fwd = n.connections
        .map(c => ({ c, col: colOf(c) }))
        .filter(o => o.col !== null)
        .sort((a, b) => fwdSign * (b.col - a.col))[0];
      if (fwd) actions.push({ op: "move", from: n.id, to: fwd.c, unit_type: t, count: movable });
    }
  }

  if (actions.length === 0) actions.push({ op: "idle" });
  return { reason: "自前AI(既定): 生産しつつ前進・可視ターゲットを攻撃", actions };
}`;

  // ユーザーの JS 文字列から decide を生成（簡易サンドボックス: new Function）
  function makeJsAgent(code) {
    let decide;
    try {
      // eslint-disable-next-line no-new-func
      const factory = new Function(code + "\n;return decide;");
      decide = factory();
      if (typeof decide !== "function") throw new Error("decide 関数が定義されていません");
    } catch (e) {
      throw new Error("JSポリシーの読み込みに失敗: " + e.message);
    }
    return function (view) {
      try { return decide(view) || { reason: "no-op", actions: [{ op: "idle" }] }; }
      catch (e) { return { reason: "JS例外: " + e.message, actions: [{ op: "idle" }] }; }
    };
  }

  // ---- 自前AI: ローカルLLM エンドポイント (L3) ---------------------------
  // OpenAI互換 /chat/completions を fetch。deadline 超過は idle。
  function makeLlmAgent(cfg) {
    const url = cfg.url;
    const model = cfg.model || "local-model";
    const apiKey = cfg.apiKey || "";
    const deadline = cfg.deadline_ms || 1000;
    const sys = cfg.system || LLM_SYSTEM_PROMPT;

    return async function (view) {
      const body = {
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: "state = " + JSON.stringify(view) + "\nactions を JSON のみで返答せよ。" },
        ],
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), deadline);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, apiKey ? { Authorization: "Bearer " + apiKey } : {}),
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const data = await res.json();
        const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
        const parsed = extractJson(text);
        if (!parsed || !Array.isArray(parsed.actions)) return { reason: "LLM応答をパースできず idle", actions: [{ op: "idle" }] };
        return parsed;
      } catch (e) {
        clearTimeout(timer);
        return { reason: "LLM呼び出し失敗/deadline超過 → idle (" + e.message + ")", actions: [{ op: "idle" }] };
      }
    };
  }

  function extractJson(text) {
    if (!text) return null;
    // ```json ... ``` を剥がす
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    let s = fence ? fence[1] : text;
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start < 0 || end < 0) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
  }

  const LLM_SYSTEM_PROMPT =
`あなたはネットワーク陣取りRTS「ノード・ドミニオン」の作戦AIである。
目的: 敵本拠地を占領するか、制限時間までに占領ノード数で上回ること。自軍本拠地は守ること。
出力は次のJSONのみ(散文・コードフェンス禁止):
{ "tick": <int>, "reason": "<1〜2文>", "actions": [ {op,...}, ... ] }
op: attack/move/reinforce/produce/fortify/scout/use_special/idle。
attack/move は {from,to,unit_type,count}。from/to は隣接(connections)していること。
unit_type は assault/guard/skirmish（突撃>機動>防衛>突撃の三すくみ）。
enemy.known_nodes に無いノードや type=unknown は to に指定するな。
1tick最大6行動・CPは超過しないこと。SPは占領ノード(特にsupply)から増える。`;

  global.Agents = {
    PRESETS,
    DEFAULT_JS_POLICY,
    LLM_SYSTEM_PROMPT,
    makeJsAgent,
    makeLlmAgent,
  };
})(typeof window !== "undefined" ? window : globalThis);
