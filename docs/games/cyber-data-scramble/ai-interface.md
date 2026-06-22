# 自前LLM連携 重点仕様 (AI Interface Spec)

> サイバー・データ・スクランブル / L3「自前LLM・外部AIエンドポイント」連携仕様
> バージョン: 1.0 / 最終更新: 2026-06-22
> 親ドキュメント: [`GDD.md`](./GDD.md)

本ドキュメントは GDD 第4章で定義した3レイヤーのうち、本企画の主役である **L3（自前LLM / 外部AIエンドポイント連携）** の仕様を扱う。プレイヤーが用意したLLM（ローカル/外部）を「作戦AI」としてサーバーに接続し、戦闘フェーズの各ティックで行動を決定させる。

---

## 1. サーバー権威アーキテクチャ

### 1.1 原則

ゲームの真実（state）はすべて **サーバーが保持・計算・判定** する。LLMエージェントは「**行動の提案者**」に過ぎず、状態を直接書き換えられない。これにより不正・チート・非決定性を排除する。

```
┌──────────────────────────────────────────────────────────────────┐
│                        ゲームサーバー（権威）                          │
│                                                                    │
│   ┌────────────────┐   ┌────────────────┐   ┌──────────────────┐   │
│   │ 状態ストア       │   │ ルール/判定エンジン │   │ リソース計算       │   │
│   │ (真の盤面/HP/CP/ │──▶│ (行動検証・適用・  │──▶│ (CP回復/抽出進行/  │   │
│   │  DP/抽出%/RNG)   │   │  勝敗判定)        │   │  special更新)     │   │
│   └────────────────┘   └────────────────┘   └──────────────────┘   │
│            │                    ▲                                   │
│            │ ① 部分観測ビュー生成   │ ③ 検証済み行動                     │
│            ▼ (霧フィルタ)          │                                   │
│   ┌─────────────────────────────────────────┐                      │
│   │ エージェント・ゲートウェイ                    │                      │
│   │ (スキーマ強制 / deadline_ms / CP上限強制)    │                      │
│   └─────────────────────────────────────────┘                      │
└─────────────│──────────────────────▲──────────────────────────────┘
             │ state(JSON)            │ actions(JSON)
             ▼                        │
   ┌────────────────────┐    ┌────────────────────┐
   │ プレイヤーA の作戦AI   │    │ プレイヤーB の作戦AI   │
   │ (ローカルLLM等)       │    │ (外部エンドポイント等) │
   │ ※提案のみ・状態権限なし │    │ ※提案のみ・状態権限なし │
   └────────────────────┘    └────────────────────┘
```

### 1.2 ローカルLLMを作戦AIとして接続する参照構成

```
[プレイヤー環境]
  ローカルLLM (例: 量子化7B〜オープンウェイトモデル)
        │  OpenAI互換 /chat/completions エンドポイント (http://localhost:11434 等)
        ▼
  エージェント・アダプタ (薄いラッパ)
    - サーバーからの state(JSON) を受信
    - システムプロンプト＋state を組み立て LLM へ投入
    - LLM出力を actions(JSON) にパースし検証
    - deadline_ms 内に返信（超過は idle 扱い）
        │  WebSocket / HTTP (認証トークン付き)
        ▼
[ゲームサーバー] エージェント・ゲートウェイ
```

- サーバーは特定のLLM実装に依存しない。**JSON in / JSON out の契約** さえ満たせば、ローカルでも外部APIでも自作プログラムでも接続できる。
- 認証はマッチ単位の短命トークン。1エージェント=1陣営にバインドされる。

---

## 2. 盤面状態スキーマ（state / JSON）

サーバーが各ティックでエージェントへ送る部分観測ビュー。**敵情報は霧（fog of war）でフィルタ** され、未解明の敵ノードは含まれない／推定値のみが渡る。

```json
{
  "schema_version": "1.0",
  "match_id": "m_8f3a",
  "round": 2,
  "tick": 47,
  "tick_rate_hz": 4,
  "phase": "battle",
  "deadline_ms": 200,
  "you": {
    "side": "A",
    "resources": { "cp": 62, "cp_cap": 108, "cp_regen": 12, "dp": 740 },
    "extraction_progress_pct": 38.2,
    "core": { "id": "A_core", "hp_pct": 86 },
    "nodes": [
      {
        "id": "A_fw_1", "type": "firewall", "hp_pct": 71,
        "pos": [3, 5], "connections": ["A_core", "A_router_2"],
        "status": ["active"], "upkeep_dp": 3, "cp_per_tick": 1
      },
      {
        "id": "A_exploit_1", "type": "exploit_bot", "hp_pct": 100,
        "pos": [6, 4], "connections": ["A_router_2"],
        "status": ["attacking:B_router_1"], "upkeep_dp": 4, "cp_per_tick": 5
      },
      {
        "id": "A_scanner_1", "type": "scanner", "hp_pct": 90,
        "pos": [5, 6], "connections": ["A_router_2"],
        "status": ["idle"], "upkeep_dp": 2, "cp_per_tick": 0
      }
    ]
  },
  "enemy": {
    "side": "B",
    "extraction_progress_pct": 44.0,
    "visibility_pct": 55,
    "core": { "id": "B_core", "hp_estimate": "high" },
    "known_nodes": [
      {
        "id": "B_router_1", "type": "router", "hp_estimate": "mid",
        "pos": [12, 4], "connections": ["B_core", "?"],
        "status": ["active"], "last_seen_tick": 47
      },
      {
        "id": "B_unknown_2", "type": "unknown", "hp_estimate": "low",
        "pos": [13, 6], "connections": ["?"],
        "status": ["unknown"], "last_seen_tick": 41
      }
    ]
  },
  "recent_events": [
    { "tick": 46, "type": "node_destroyed", "target": "B_fw_2", "by": "A_exploit_1" },
    { "tick": 45, "type": "honeypot_triggered", "at": [11, 5], "source_hint": "B_scanner_?" },
    { "tick": 44, "type": "defense_success", "node": "A_fw_1" }
  ],
  "specials": {
    "traceback": { "charge_pct": 73, "ready": false },
    "zeroday": { "charge_pct": 31, "ready": false },
    "killswitch": { "available": false, "reason": "core_hp_above_threshold" }
  }
}
```

### 2.1 霧（部分観測）の扱い

| フィールド | ルール |
| --- | --- |
| `enemy.visibility_pct` | スキャン進行度に応じた敵トポロジー解明率（0〜100） |
| `enemy.known_nodes` | 一度でも観測された敵ノードのみ。未観測ノードは **配列に含めない** |
| `hp_estimate` | 敵HPは数値ではなく `high` / `mid` / `low` の3段階推定でのみ渡す（厳密値は秘匿） |
| `connections: ["?"]` | 接続先が未解明の場合は `"?"` プレースホルダ |
| `type: "unknown"` | 種別未判明のノード（攻撃対象には指定不可。後述4.6） |
| `last_seen_tick` | 最後に観測したtick。古い情報は陳腐化している可能性 |

> 自軍情報（`you`）は完全観測。敵情報（`enemy`）は霧でフィルタされた部分観測。この非対称性が「スキャンで情報を取る」行動に価値を与える。

---

## 3. 行動スキーマ（actions / JSON）

エージェントが返す行動の配列。1ティックで複数行動を返せるが、**合計CPコストと行動数の上限はサーバーが強制** する。

```json
{
  "schema_version": "1.0",
  "match_id": "m_8f3a",
  "tick": 47,
  "reason": "敵抽出が自軍を上回り可視率も低い。scannerで索敵しつつexploitは継続。CP温存。",
  "actions": [
    { "op": "attack",   "actor": "A_exploit_1", "target": "B_router_1" },
    { "op": "scan",     "actor": "A_scanner_1", "area": [11, 4] },
    { "op": "repair",   "actor": "A_repair_1",  "target": "A_fw_1" }
  ]
}
```

### 3.1 オペレーション一覧

| op | 説明 | 主パラメータ | CPコスト目安 |
| --- | --- | --- | --- |
| `attack` | 指定ノードへ攻撃 | `actor`, `target` | 5（exploit）/ 6（DDoS） |
| `defend` | 指定ノードへ防御集中（被ダメ減） | `actor`, `target` | 2 |
| `repair` | 味方ノードHP回復 | `actor`, `target` | 3 |
| `build` | ノード新設（戦闘中の増設、DPも消費） | `type`, `pos`, `connect_to[]` | 4 ＋ 設置DP |
| `relocate` | ノードを隣接座標へ移動 | `actor`, `to` | 3 |
| `deploy_decoy` | 囮を展開 | `actor` または `pos` | 1 |
| `scan` | 指定エリアの霧を晴らす | `actor`, `area` | 4 |
| `use_special` | スペシャル発動 | `special`(`traceback`/`zeroday`/`killswitch`), `option?` | 0（ゲージ消費） |
| `idle` | 何もしない（CP温存） | — | 0 |

### 3.2 1tick あたりの制約

| 制約 | 標準値 | 強制主体 |
| --- | --- | --- |
| 1tickの最大行動数 | **6** | サーバー（超過分は末尾から破棄） |
| 1tickの消費CP合計 | 現在CP以下 | サーバー（超過する行動は先頭優先で採用、残りは無効） |
| 同一actorの重複行動 | 不可（1tick1行動） | サーバー（後勝ち or 拒否） |
| `deadline_ms` | **200ms**（標準・GDDのtick_rate 4Hzに整合） | サーバー（超過は全 idle） |

> `reason` フィールドは必須。LLMの思考過程をここに **短く要約** させる（リプレイ解析・デバッグ・観戦用）。冗長な思考は禁止し、本文はあくまで `actions` で表現させる（後述7章）。

---

## 4. 公平性・不正対策

| 対策 | 内容 |
| --- | --- |
| **deadline 強制** | `deadline_ms` を超えた応答は破棄し、その tick は全 `idle` 扱い。遅いLLMが有利にも不利にもならない（待たない） |
| **CP上限のサーバー強制** | エージェントが申告したコストではなく、サーバーが実コストを計算しCP残量で頭打ち。超過行動は無効化 |
| **行動数上限の強制** | 1tick最大6行動。超過分は破棄 |
| **スキーマ強制** | JSON Schema 検証。不正な op・存在しない actor・型不一致は当該行動のみ無効（マッチは継続） |
| **シード固定** | マッチ単位でRNGシードを固定。ダメージ計算等に乱数を使う場合も両者同条件・**決定論的**にリプレイ再現可能 |
| **見えない敵は対象不可** | `enemy.known_nodes` に存在しない id、または `type: "unknown"` のノードを `target` に指定した行動は **拒否**。霧の向こうへの当て推量攻撃を防ぐ |
| **状態の一方向性** | エージェントは state を読むだけ。書き込みはサーバーの検証経路のみ。クライアント申告の状態は一切信用しない |

> 設計思想: 「強いLLM」ではなく「良い作戦ポリシー」が勝つようにする。計算資源や応答速度の差が勝敗を左右しないよう、すべての非対称性をサーバー側のルールで吸収する。

---

## 5. 非同期対戦フロー

両プレイヤーが同時刻にオンラインである必要はない。エージェントを登録すればサーバーが自動的に試合を実行する。

```
プレイヤーA                  サーバー                    プレイヤーB
   │                           │                           │
   │─ ① エージェント登録 ───────▶│◀─── ① エージェント登録 ──────│
   │  (トポロジー＋AI接続情報)    │   (トポロジー＋AI接続情報)    │
   │                           │                           │
   │                    ② マッチング成立                      │
   │                           │                           │
   │                    ③ 戦闘フェーズ自動実行                  │
   │                    （tickループで両AIを呼び出し           │
   │                      検証・適用・判定）                   │
   │                           │                           │
   │◀──── ④ リプレイ配信 ───────│──── ④ リプレイ配信 ────────▶│
   │  (全tickのstate/actions/   │                           │
   │   reason を含む決定論ログ)   │                           │
   │                           │                           │
   │─ ⑤ ポリシー/トポロジー再調整 ▶│◀─ ⑤ ポリシー再調整 ─────────│
   │  (リプレイを見て学習ループ)   │                           │
   ▼                           ▼                           ▼
```

- **学習ループ**: リプレイは決定論的に再現可能なため、プレイヤーは自分のLLMに過去マッチを食わせて作戦を改善できる。盤面状態→行動のログはそのまま教師データになる。
- **オフライン耐性**: 登録後はサーバーが完結して試合を進めるため、対戦相手の在席は不要。

---

## 6. LLMプロンプト設計指針

### 6.1 指針

| 指針 | 内容 |
| --- | --- |
| **状態圧縮** | state はトークンを食う。未観測敵ノードは送らない（霧で既に削減済み）、変化のない静的情報は差分送信や省略を検討 |
| **厳格JSON出力強制** | 出力は `actions` スキーマに準拠したJSONのみ。Markdownコードフェンスや散文を混ぜさせない（パーサが弾く） |
| **思考は reason に要約** | 連鎖思考を本文に垂れ流させず、結論の要約だけを `reason`（1〜2文）に格納させる。deadline内に収める助けにもなる |
| **deadline 厳守** | 出力長を絞り、低レイテンシで返す。長考は idle 罰につながると明示 |
| **temperature 低め** | 再現性・安定性のため temperature は 0〜0.3 程度を推奨。作戦の一貫性を保つ |

### 6.2 推奨システムプロンプト骨子

```text
あなたはネットワーク攻防RTS「サイバー・データ・スクランブル」の作戦AIである。
目的: 敵コアの機密データを100%抽出すること。同時に自軍コアの抽出を防ぐこと。

【入力】
毎ティック、JSONで現在の盤面状態(state)が与えられる。
- you: 自軍の完全情報（CP/DP/抽出%/ノード一覧）
- enemy: 敵軍の部分情報（霧で隠れる。HPはhigh/mid/lowの推定のみ）
- recent_events / specials も参照せよ。

【出力】
次のJSONスキーマに厳密に従う actions オブジェクトのみを出力せよ。
散文・コードフェンス・前置きは一切禁止。JSON以外を出力してはならない。
{ "tick": <int>, "reason": "<1〜2文の要約>", "actions": [ {op, ...}, ... ] }

【制約】
- 1tickの行動は最大6件。合計CPは現在CPを超えないこと（超過分はサーバーに破棄される）。
- enemy.known_nodes に無いノードや type=unknown は target に指定するな（拒否される）。
- 思考過程は出力するな。結論の要約だけを reason に1〜2文で書け。
- 応答は deadline_ms 以内。遅延は全idleとして処理される。

【方針】
- CPは有限。攻めと守りのCP配分を毎tick判断せよ。
- 可視率が低いときは scan を優先し、当て推量の攻撃を避けよ。
- specials は劣勢時の逆転札。発動条件と効果・リスクを踏まえて慎重に使え。
```

---

## 7. 戦闘フェーズ PoC 擬似コード

サーバー側の戦闘フェーズ・メインループの参照実装（擬似コード）。L1/L2/L3 の呼び分けを含む。

```python
def run_battle_phase(match):
    state = init_state(match)            # トポロジー・初期DP/CP・抽出0%・RNGシード固定
    rng = SeededRNG(match.seed)          # マッチ単位の決定論シード

    while not state.is_over():           # 抽出100% / コア陥落 / 制限時間180秒
        actions_by_side = {}

        for side in ("A", "B"):
            agent = match.agents[side]
            view  = build_partial_view(state, side)   # 霧フィルタ・敵HPはhigh/mid/low

            # ---- L1/L2/L3 の呼び分け ----
            if agent.layer == "L1":
                # 内蔵ルールエンジン（IF-THENビヘイビアツリー）。決定論・即時。
                raw = eval_builtin_rules(agent.rules, view)
            elif agent.layer == "L2":
                # サンドボックスでDSL/ノードグラフを実行。タイムボックス付き。
                raw = run_sandbox(agent.program, view, deadline_ms=200)
            else:  # L3
                # 外部/ローカルLLMエンドポイントへ state を投げ actions を得る。
                raw = call_agent_endpoint(agent.endpoint, view, deadline_ms=200)
                if raw is TIMEOUT:
                    raw = {"actions": [{"op": "idle"}]}   # deadline超過は全idle

            # ---- サーバー権威の検証 ----
            valid = validate_actions(
                raw, state, side,
                max_actions=6,            # 行動数上限
                cp_available=state[side].cp,  # CP上限強制
                schema=ACTIONS_SCHEMA,    # スキーマ強制
                fog=view.fog,             # 見えない敵は対象不可
            )
            actions_by_side[side] = valid

        # ---- 同時適用（両陣営の検証済み行動をこのtickに反映） ----
        for side in ("A", "B"):
            apply_actions(state, side, actions_by_side[side], rng)

        # ---- リソース・進行・スペシャルの更新 ----
        regen_cp(state)                  # +cp_regen（90秒以降は上限漸増）
        advance_extraction(state)        # 0.5%/秒 × 0.85^hop を経路ごとに合算
        update_specials(state)           # traceback解析率 / zeroday窮地ゲージ / killswitch可否
        accrue_resources(state)          # 攻撃/防御/解析の成功報酬DP・CPを付与

        log_replay(state, actions_by_side)  # 決定論リプレイ用に全tickを記録
        state.tick += 1

    return decide_winner(state)          # 抽出100% > 抽出%高 > 残コアHP の優先で判定
```

### 7.1 補足

- `apply_actions` は両陣営の行動を **同一tick内で同時適用** する（先手後手の有利を作らない）。
- すべての乱数は `SeededRNG(match.seed)` 経由。同じ入力からは必ず同じ試合が再生される（リプレイ・学習ループの基盤）。
- L1/L2/L3いずれの経路を通っても、`validate_actions` 以降の処理は完全に共通。レイヤーによる判定の差は生じない。

---

→ 親ドキュメント: [`GDD.md`](./GDD.md)
