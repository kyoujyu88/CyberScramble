# 自前LLM連携 重点仕様 (AI Interface Spec)

> ノード・ドミニオン / L3「自前LLM・外部AIエンドポイント」連携仕様
> バージョン: 2.0 / 最終更新: 2026-06-22
> 親ドキュメント: [`GDD.md`](./GDD.md) / 実装デモ: [`../../../demo/`](../../../demo/)

本ドキュメントは GDD 第4章で定義した3レイヤーのうち、本企画の主役である **L3（自前LLM / 外部AIエンドポイント連携）** の仕様を扱う。プレイヤーが用意したLLM（ローカル/外部）を「作戦AI」としてサーバーに接続し、戦闘フェーズの各tickで陣取りの行動を決定させる。

> 同梱の `demo/` は本仕様（state/actions スキーマ・検証・決定論tickループ）をブラウザ上で再現しており、**自前AI（JSポリシー or ローカルLLMエンドポイント）対 NPC（L1）** を実際に動かせる。

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
│   │ (真の盤面/所有/  │──▶│ (行動検証・適用・  │──▶│ (CP回復/SP収入/    │   │
│   │  ユニット/CP/SP) │   │  戦闘解決・占領)   │   │  special更新)     │   │
│   └────────────────┘   └────────────────┘   └──────────────────┘   │
│            │                    ▲                                   │
│            │ ① 部分観測ビュー生成   │ ③ 検証済み行動                     │
│            ▼ (霧フィルタ)          │                                   │
│   ┌─────────────────────────────────────────┐                      │
│   │ エージェント・ゲートウェイ                    │                      │
│   │ (スキーマ強制 / deadline_ms / CP・行動数上限) │                      │
│   └─────────────────────────────────────────┘                      │
└─────────────│──────────────────────▲──────────────────────────────┘
             │ state(JSON)            │ actions(JSON)
             ▼                        │
   ┌────────────────────┐    ┌────────────────────┐
   │ プレイヤーA の作戦AI   │    │ プレイヤーB の作戦AI   │
   │ (ローカルLLM等)       │    │ (NPC=内蔵ルール等)    │
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
- `demo/agents.js` の `llmAgent` がこのアダプタの最小実装にあたる（ブラウザから OpenAI互換エンドポイントへ fetch）。

---

## 2. 盤面状態スキーマ（state / JSON）

サーバーが各tickでエージェントへ送る部分観測ビュー。**敵情報は霧（fog of war）でフィルタ** され、未観測の敵ノードは含まれない／戦力は推定で渡る。

```json
{
  "schema_version": "2.0",
  "match_id": "m_8f3a",
  "round": 2,
  "tick": 47,
  "tick_rate_hz": 1,
  "phase": "battle",
  "deadline_ms": 1000,
  "map": { "size": "M", "total_nodes": 13 },
  "you": {
    "side": "A",
    "resources": { "cp": 62, "cp_cap": 108, "cp_regen": 10, "sp": 220 },
    "home_base": { "id": "A_home", "hp_pct": 86, "fortify": 1 },
    "node_control": { "yours": 5, "enemy": 4, "neutral": 4 },
    "nodes": [
      {
        "id": "n_3", "type": "supply", "owner": "A",
        "pos": [3, 1], "connections": ["A_home", "n_5", "n_4"],
        "fortify": 1,
        "garrison": { "assault": 2, "guard": 3, "skirmish": 0 }
      },
      {
        "id": "n_5", "type": "fortress", "owner": "A",
        "pos": [4, 1], "connections": ["n_3", "n_7"],
        "fortify": 2,
        "garrison": { "assault": 0, "guard": 4, "skirmish": 1 }
      }
    ],
    "units_total": { "assault": 4, "guard": 9, "skirmish": 2 }
  },
  "enemy": {
    "side": "B",
    "visibility_pct": 55,
    "home_base": { "id": "B_home", "hp_estimate": "high" },
    "known_nodes": [
      {
        "id": "n_7", "type": "normal", "owner": "B",
        "pos": [5, 1], "connections": ["n_5", "?"],
        "fortify_estimate": "low",
        "strength_estimate": "mid",
        "last_seen_tick": 47
      },
      {
        "id": "n_9", "type": "unknown", "owner": "B",
        "pos": [6, 2], "connections": ["?"],
        "strength_estimate": "low",
        "last_seen_tick": 41
      }
    ]
  },
  "recent_events": [
    { "tick": 46, "type": "node_captured", "node": "n_5", "by": "A" },
    { "tick": 45, "type": "node_lost", "node": "n_8", "to": "B" },
    { "tick": 44, "type": "defense_success", "node": "n_3" }
  ],
  "specials": {
    "surge":    { "charge_pct": 73, "ready": false },
    "recon":    { "charge_pct": 31, "ready": false },
    "scorched": { "available": false, "reason": "home_hp_above_threshold" }
  }
}
```

### 2.1 霧（部分観測）の扱い

| フィールド | ルール |
| --- | --- |
| `enemy.visibility_pct` | 索敵進行度に応じた敵盤面の解明率（0〜100） |
| `enemy.known_nodes` | 一度でも観測された敵/中立ノードのみ。未観測ノードは **配列に含めない** |
| `strength_estimate` | 敵駐留戦力は数値ではなく `low` / `mid` / `high` の3段階推定でのみ渡す |
| `home_base.hp_estimate` | 敵本拠地HPも `low`/`mid`/`high` の推定 |
| `connections: ["?"]` | 接続先が未解明の場合は `"?"` プレースホルダ |
| `type: "unknown"` | 種別未判明のノード（攻撃対象に指定不可。後述4） |
| `last_seen_tick` | 最後に観測したtick。古い情報は陳腐化している可能性 |

> 自軍情報（`you`）は完全観測。敵情報（`enemy`）は霧でフィルタされた部分観測。この非対称性が「機動ユニットで索敵する」行動に価値を与える。

---

## 3. 行動スキーマ（actions / JSON）

エージェントが返す行動の配列。1tickで複数行動を返せるが、**合計CPコストと行動数の上限はサーバーが強制** する。

```json
{
  "schema_version": "2.0",
  "match_id": "m_8f3a",
  "tick": 47,
  "reason": "敵占領が優位。補給ノードn_7へ突撃で侵攻しつつ前線n_5を要塞化。CP温存。",
  "actions": [
    { "op": "attack",  "from": "n_5", "to": "n_7", "unit_type": "assault", "count": 3 },
    { "op": "produce", "unit_type": "guard", "count": 1 },
    { "op": "fortify", "node": "n_5" }
  ]
}
```

### 3.1 オペレーション一覧

| op | 説明 | 主パラメータ | CPコスト目安 |
| --- | --- | --- | --- |
| `attack` | 隣接する敵/中立ノードへ進軍して戦闘 | `from`, `to`, `unit_type`, `count` | 1 |
| `move` | 隣接する自軍/空ノードへ部隊移動 | `from`, `to`, `unit_type`, `count` | 1 |
| `reinforce` | 隣接する自軍ノードへ増援（`move`の別名） | `from`, `to`, `unit_type`, `count` | 1 |
| `retreat` | 隣接する自軍ノードへ後退（`move`の別名） | `from`, `to`, `unit_type`, `count` | 1 |
| `produce` | 本拠地でユニット生産（SPも消費） | `unit_type`, `count` | 2 |
| `fortify` | 自軍ノードを拠点強化（SPも消費） | `node` | 2 |
| `scout` | 機動ユニットで指定ノード周辺の霧を晴らす | `node`（または `actor`） | 1 |
| `use_special` | スペシャル発動 | `special`(`surge`/`recon`/`scorched`) | 0（ゲージ消費） |
| `idle` | 何もしない（CP温存） | — | 0 |

> `unit_type` は `assault` / `guard` / `skirmish`。`move`/`reinforce`/`retreat` は実装上 `move` に正規化される。

### 3.2 1tick あたりの制約

| 制約 | 標準値 | 強制主体 |
| --- | --- | --- |
| 1tickの最大行動数 | **6** | サーバー（超過分は末尾から破棄） |
| 1tickの消費CP合計 | 現在CP以下 | サーバー（先頭優先で採用、超過分は無効） |
| 同一ユニット群の重複移動 | 1tick1回 | サーバー（後勝ち or 拒否） |
| `deadline_ms` | **1000ms**（tick_rate 1Hz に整合） | サーバー（超過は全 idle） |

> `reason` フィールドは必須。LLMの思考過程をここに **短く要約** させる（リプレイ解析・デバッグ・観戦用）。冗長な思考は禁止し、本文はあくまで `actions` で表現させる（後述6章）。

---

## 4. 公平性・不正対策

| 対策 | 内容 |
| --- | --- |
| **deadline 強制** | `deadline_ms` を超えた応答は破棄し、その tick は全 `idle` 扱い。遅いLLMが有利にも不利にもならない |
| **CP上限のサーバー強制** | エージェント申告ではなくサーバーが実コストを計算しCP残量で頭打ち。超過行動は無効化 |
| **行動数上限の強制** | 1tick最大6行動。超過分は破棄 |
| **スキーマ強制** | JSON Schema 検証。不正な op・存在しないノード・型不一致は当該行動のみ無効（マッチは継続） |
| **隣接性の強制** | `from` と `to` がエッジで接続されていない移動・攻撃は拒否 |
| **シード固定** | マッチ単位でRNGシードを固定。戦闘解決も両者同条件・**決定論的**にリプレイ再現可能 |
| **見えない敵は対象不可** | `enemy.known_nodes` に無い id、または `type: "unknown"` のノードを `to` に指定した行動は **拒否**。霧の向こうへの当て推量攻撃を防ぐ |
| **状態の一方向性** | エージェントは state を読むだけ。書き込みはサーバーの検証経路のみ。クライアント申告の状態は一切信用しない |

> 設計思想: 「強いLLM」ではなく「良い作戦ポリシー」が勝つようにする。計算資源や応答速度の差が勝敗を左右しないよう、すべての非対称性をサーバー側のルールで吸収する。`demo/engine.js` の `validateActions()` が本表の検証を実装している。

---

## 5. 非同期対戦フロー

両プレイヤーが同時刻にオンラインである必要はない。エージェントを登録すればサーバーが自動的に試合を実行する。

```
プレイヤーA                  サーバー                    プレイヤーB
   │                           │                           │
   │─ ① エージェント登録 ───────▶│◀─── ① エージェント登録 ──────│
   │  (初期配置＋AI接続情報)      │   (初期配置＋AI接続情報)      │
   │                           │                           │
   │                    ② マッチング成立                      │
   │                           │                           │
   │                    ③ 戦闘フェーズ自動実行                  │
   │                    （tickループで両AIを呼び出し           │
   │                      検証・適用・占領・判定）              │
   │                           │                           │
   │◀──── ④ リプレイ配信 ───────│──── ④ リプレイ配信 ────────▶│
   │  (全tickのstate/actions/   │                           │
   │   reason を含む決定論ログ)   │                           │
   │                           │                           │
   │─ ⑤ ポリシー/配置 再調整 ────▶│◀─ ⑤ ポリシー再調整 ─────────│
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
| **状態圧縮** | state はトークンを食う。未観測敵ノードは送らない（霧で削減済み）、変化のない静的情報は省略を検討 |
| **厳格JSON出力強制** | 出力は `actions` スキーマに準拠したJSONのみ。Markdownや散文を混ぜさせない（パーサが弾く） |
| **思考は reason に要約** | 連鎖思考を本文に垂れ流させず、結論の要約だけを `reason`（1〜2文）に格納させる |
| **deadline 厳守** | 出力長を絞り低レイテンシで返す。長考は idle 罰につながると明示 |
| **temperature 低め** | 再現性・安定性のため temperature は 0〜0.3 程度を推奨。作戦の一貫性を保つ |

### 6.2 推奨システムプロンプト骨子

```text
あなたはネットワーク陣取りRTS「ノード・ドミニオン」の作戦AIである。
目的: 敵本拠地を占領するか、制限時間までに占領ノード数で上回ること。
同時に自軍本拠地を守ること。

【入力】
毎tick、JSONで現在の盤面状態(state)が与えられる。
- you: 自軍の完全情報（CP/SP/本拠地HP/ノードと駐留ユニット）
- enemy: 敵軍の部分情報（霧で隠れる。戦力はlow/mid/highの推定のみ）
- map / recent_events / specials も参照せよ。

【出力】
次のJSONスキーマに厳密に従う actions オブジェクトのみを出力せよ。
散文・コードフェンス・前置きは一切禁止。JSON以外を出力してはならない。
{ "tick": <int>, "reason": "<1〜2文の要約>", "actions": [ {op, ...}, ... ] }

【制約】
- 1tickの行動は最大6件。合計CPは現在CPを超えないこと（超過分は破棄される）。
- from と to は隣接（connections）していること。隣接しない移動は拒否される。
- enemy.known_nodes に無いノードや type=unknown は to に指定するな（拒否される）。
- ユニットは assault/guard/skirmish の三すくみ（突撃>機動>防衛>突撃）。
- 思考過程は出力するな。結論の要約だけを reason に1〜2文で書け。
- 応答は deadline_ms 以内。遅延は全idleとして処理される。

【方針】
- SPは占領ノードから増える。補給ノードの確保を重視せよ。
- CPは有限。攻めと守りのCP配分を毎tick判断せよ。
- 可視率が低いときは scout を優先し、当て推量の攻撃を避けよ。
- 敵の主力ユニットにカウンターする種類を produce せよ。
- specials は劣勢時の逆転札。発動条件と効果・リスクを踏まえて慎重に使え。
```

---

## 7. 戦闘フェーズ PoC 擬似コード

サーバー側の戦闘フェーズ・メインループの参照実装（擬似コード）。L1/L2/L3 の呼び分けを含む。`demo/engine.js` が本擬似コードの実装である。

```python
def run_battle_phase(match):
    state = init_state(match)            # マップ生成(S/M/L)・初期所有/配置・初期SP・抽出0
    rng = SeededRNG(match.seed)          # マッチ単位の決定論シード

    while not state.is_over():           # 敵本拠地占領 / ラウンド制限tick 到達
        actions_by_side = {}

        for side in ("A", "B"):
            agent = match.agents[side]
            view  = build_partial_view(state, side)   # 霧フィルタ・敵戦力はlow/mid/high

            # ---- L1/L2/L3 の呼び分け ----
            if agent.layer == "L1":
                # 内蔵ルールエンジン（IF-THEN）。決定論・即時。デモのNPC。
                raw = eval_builtin_rules(agent.rules, view)
            elif agent.layer == "L2":
                # サンドボックスでDSL/ノードグラフを実行。タイムボックス付き。
                raw = run_sandbox(agent.program, view, deadline_ms=1000)
            else:  # L3
                # 外部/ローカルLLM(またはJSポリシー)へ state を投げ actions を得る。
                raw = call_agent_endpoint(agent.endpoint, view, deadline_ms=1000)
                if raw is TIMEOUT:
                    raw = {"actions": [{"op": "idle"}]}   # deadline超過は全idle

            # ---- サーバー権威の検証 ----
            valid = validate_actions(
                raw, state, side,
                max_actions=6,            # 行動数上限
                cp_available=state[side].cp,  # CP上限強制
                schema=ACTIONS_SCHEMA,    # スキーマ強制
                adjacency=state.graph,    # 隣接性の強制
                fog=view.fog,             # 見えない敵は対象不可
            )
            actions_by_side[side] = valid

        # ---- 同時適用（両陣営の検証済み行動をこのtickに反映） ----
        for side in ("A", "B"):
            apply_actions(state, side, actions_by_side[side])

        resolve_combat(state, rng)       # 対峙ノードで三すくみ戦闘解決→占領判定
        regen_cp(state)                  # +cp_regen（90tick以降は上限漸増）
        accrue_supply(state)             # 占領ノード数に応じSP収入（home+5 / supply+3）
        update_specials(state)           # surge劣勢ゲージ / recon偵察ゲージ / scorched可否
        award_combat_rewards(state)      # 攻撃成功/防御成功のCP・SP報酬

        log_replay(state, actions_by_side)  # 決定論リプレイ用に全tickを記録
        state.tick += 1

    return decide_winner(state)          # 敵本拠地占領 > 占領ノード数 > 本拠地HP > 総戦力
```

### 7.1 補足

- `apply_actions` は両陣営の行動を **同一tick内で同時適用** する（先手後手の有利を作らない）。
- すべての乱数は `SeededRNG(match.seed)` 経由。同じ入力からは必ず同じ試合が再生される（リプレイ・学習ループの基盤）。
- L1/L2/L3いずれの経路を通っても、`validate_actions` 以降の処理は完全に共通。レイヤーによる判定の差は生じない。
- 本擬似コードの動作する実装が `demo/`。NPC が L1、自前AI が L3（JSポリシー or ローカルLLM）として対戦する。

---

→ 親ドキュメント: [`GDD.md`](./GDD.md) / 実装デモ: [`../../../demo/README.md`](../../../demo/README.md)
