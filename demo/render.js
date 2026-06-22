/*
 * ノード・ドミニオン — Canvas 描画 (demo)
 * グラフ（ノード/エッジ/所有/守備/要塞化）を描く。HUD/ログは DOM 側で表示。
 */
(function (global) {
  "use strict";
  const UT = global.Engine.UNIT_TYPES;
  const COLOR = { A: "#3b82f6", B: "#ef4444", null: "#94a3b8" };
  const COLOR_SOFT = { A: "rgba(59,130,246,0.15)", B: "rgba(239,68,68,0.15)", null: "rgba(148,163,184,0.12)" };

  function pos(node, w, h, pad) {
    return { x: pad + node.pos.x * (w - 2 * pad), y: pad + node.pos.y * (h - 2 * pad) };
  }

  function draw(canvas, state) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height, pad = 48;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, w, h);

    const nodes = state.map.nodes;

    // エッジ
    ctx.strokeStyle = "rgba(148,163,184,0.25)";
    ctx.lineWidth = 2;
    const drawn = new Set();
    for (const id in nodes) {
      const n = nodes[id], p = pos(n, w, h, pad);
      for (const c of n.connections) {
        const key = id < c ? id + "|" + c : c + "|" + id;
        if (drawn.has(key)) continue; drawn.add(key);
        const q = pos(nodes[c], w, h, pad);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
    }

    // ノード
    for (const id in nodes) {
      const n = nodes[id], p = pos(n, w, h, pad);
      const col = COLOR[n.owner];
      const isHome = n.type === "home";
      const R = isHome ? 26 : n.type === "fortress" ? 20 : 16;

      // 所有のハロー
      ctx.fillStyle = COLOR_SOFT[n.owner];
      ctx.beginPath(); ctx.arc(p.x, p.y, R + 10, 0, Math.PI * 2); ctx.fill();

      // 形状: home=二重円, fortress=菱形, supply=四角, normal=円
      ctx.fillStyle = "#111827";
      ctx.strokeStyle = col; ctx.lineWidth = isHome ? 4 : 3;
      ctx.beginPath();
      if (n.type === "fortress") { diamond(ctx, p.x, p.y, R); }
      else if (n.type === "supply") { ctx.rect(p.x - R, p.y - R, R * 2, R * 2); }
      else { ctx.arc(p.x, p.y, R, 0, Math.PI * 2); }
      ctx.fill(); ctx.stroke();
      if (isHome) { ctx.beginPath(); ctx.arc(p.x, p.y, R - 6, 0, Math.PI * 2); ctx.stroke(); }

      // 要塞化リング
      for (let i = 0; i < n.fortify; i++) {
        ctx.strokeStyle = "rgba(250,204,21,0.8)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, R + 4 + i * 4, -0.4, 0.4 + i); ctx.stroke();
      }

      // ラベル（種別）
      ctx.fillStyle = "#cbd5e1"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
      const tlabel = { home: "本拠地", supply: "補給", fortress: "要塞", normal: "" }[n.type];
      if (tlabel) ctx.fillText(tlabel, p.x, p.y - R - 8);

      // 守備カウント A2 G3 S1
      const g = n.garrison;
      const parts = [];
      if (g.assault >= 0.05) parts.push("突" + Math.round(g.assault));
      if (g.guard >= 0.05) parts.push("防" + Math.round(g.guard));
      if (g.skirmish >= 0.05) parts.push("機" + Math.round(g.skirmish));
      const txt = parts.join(" ");
      if (txt) {
        ctx.fillStyle = "#e5e7eb"; ctx.font = "11px monospace";
        ctx.fillText(txt, p.x, p.y + R + 14);
      }
    }

    // tick / ラウンド表示
    ctx.fillStyle = "#64748b"; ctx.font = "12px monospace"; ctx.textAlign = "left";
    ctx.fillText("tick " + state.tick + " / " + state.round_limit + "  (map " + state.map.size + ")", 12, 18);
    if (state.over) {
      ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(0, h / 2 - 40, w, 80);
      ctx.fillStyle = COLOR[state.winner]; ctx.font = "bold 36px sans-serif"; ctx.textAlign = "center";
      ctx.fillText((state.winner === "A" ? "プレイヤーA" : "プレイヤーB") + " の勝利", w / 2, h / 2 + 12);
    }
  }

  function diamond(ctx, x, y, r) {
    ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
  }

  global.Render = { draw };
})(typeof window !== "undefined" ? window : globalThis);
