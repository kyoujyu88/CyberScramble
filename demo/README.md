# ノード・ドミニオン — デモプレイ

自律AIネットワーク陣取りRTS「ノード・ドミニオン」（旧コードネーム: サイバー・データ・スクランブル）の**動くデモ**です。ビルド不要・依存ゼロのブラウザ単体実装で、設計ドキュメントの仕組みをそのまま動かせます。

- 設計: [`../docs/games/cyber-data-scramble/GDD.md`](../docs/games/cyber-data-scramble/GDD.md)
- 連携仕様: [`../docs/games/cyber-data-scramble/ai-interface.md`](../docs/games/cyber-data-scramble/ai-interface.md)

## 何ができるか

- **自前AI 対 NPC** の対戦を観戦できる（既定: プレイヤーA=自前AI、プレイヤーB=NPC）。
- マップ規模（小/中/大）でノード数が変わる。
- 戦闘は**操作不可**。両陣営の作戦AIが自律で進軍・占領・防衛する。
- 勝利条件: **敵本拠地の占領**で即勝ち、時間切れ時は**占領ノード数**が多い側。

## 起動方法

ビルドは不要です。次のいずれかで `index.html` を開いてください。

```bash
# 方法1: ファイルを直接開く（JSポリシー/NPC対戦はこれでOK）
#   demo/index.html をブラウザにドラッグ＆ドロップ

# 方法2: 簡易サーバ経由（推奨。ローカルLLM接続もしやすい）
cd demo
python3 -m http.server 8000
#   → http://localhost:8000/ を開く
```

「▶ 開始」で戦闘フェーズが進行します。`1tick` でコマ送り、`リセット`で再生成。

## 対戦相手の選び方

- **プレイヤーA / B** のドロップダウンで、それぞれ次から選べます。
  - `自前AI（JSポリシー）` … ブラウザ内で編集する自作AI（下記）
  - `自前AI（ローカルLLM / L3）` … 手元のLLMを作戦AIとして接続（下記）
  - `NPC: バランス型 / 攻撃型 / 防御型` … 内蔵ルールエンジン（L1）

## 自前AI その1: JSポリシー（設定不要）

画面下の「自前AI: JSポリシー」で `decide(state)` を編集し「適用」を押すだけ。

```js
function decide(state) {
  // state は ai-interface.md の「部分観測ビュー」(JSON)
  //   state.you.nodes ......... 自軍ノードと駐留ユニット(完全情報)
  //   state.enemy.known_nodes . 可視の敵/中立ノード(霧でフィルタ・戦力は推定)
  //   state.you.resources ..... { cp, cp_cap, sp }
  //   state.specials .......... 逆転札ゲージ
  const me = state.you;
  return {
    reason: "最寄りを攻める",
    actions: [
      { op: "produce", unit_type: "assault", count: 1 },
      // { op: "attack", from: "A_home", to: "n0", unit_type: "guard", count: 3 },
    ],
  };
}
```

返した行動は**サーバー権威の検証**（`Engine.validateActions`）を通ります。CP超過・行動数オーバー（>6）・隣接していない移動・霧の向こうの敵への攻撃などは**自動的に無視**されるので、壊れたAIでもゲームは破綻しません。

## 自前AI その2: ローカルLLM（L3）

「自前AI: ローカルLLM 接続」に **OpenAI互換** エンドポイントを設定します（Ollama / LM Studio / vLLM など）。

| 項目 | 例 |
| --- | --- |
| エンドポイントURL | `http://localhost:11434/v1/chat/completions` |
| モデル名 | `llama3.1` など |
| APIキー | ローカルなら空でOK |

- 毎tick、サーバーが部分観測の `state(JSON)` を送り、LLMが `actions(JSON)` を返します。
- **deadline 1000ms** を超えた応答・パース失敗は、そのtickを `idle`（何もしない）として扱います（公平性のためサーバーが強制）。
- ブラウザから直接呼ぶため、**LLMサーバ側でCORS許可**が必要です。
  - 例: Ollama は `OLLAMA_ORIGINS=*` を設定して起動。
- 送信プロンプトの骨子は `Agents.LLM_SYSTEM_PROMPT`（`agents.js`）にあります。`ai-interface.md` 6.2 と対応。

## 行動スキーマ（抜粋）

| op | パラメータ | 説明 |
| --- | --- | --- |
| `attack` | `from, to, unit_type, count` | 隣接する敵/中立ノードへ進軍・戦闘 |
| `move` / `reinforce` / `retreat` | `from, to, unit_type, count` | 隣接する自軍/空ノードへ移動 |
| `produce` | `unit_type, count` | 本拠地でユニット生産（SP消費） |
| `fortify` | `node` | 自軍ノードを拠点強化（SP消費） |
| `scout` | `node` | 偵察（ゲージ加速） |
| `use_special` | `special`(`surge`/`recon`/`scorched`) | 逆転札 |
| `idle` | — | 何もしない（CP温存） |

`unit_type` は `assault`(突撃) / `guard`(防衛) / `skirmish`(機動)。三すくみは **突撃 > 機動 > 防衛 > 突撃**。

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | UI・コントロール・メインループ |
| `engine.js` | 決定論エンジン（`createMatch` / `buildView` / `validateActions` / `step`）。`ai-interface.md` 7章のPoC擬似コードの実装 |
| `agents.js` | NPCプリセット(L1)・自前JSポリシー・LLMアダプタ(L3) |
| `render.js` | Canvas描画 |
| `styles.css` | スタイル |

## ヘッドレス検証（任意）

Node.js で UI 抜きにエンジンを回せます（CIや調整用）。

```bash
cd demo
node -e '
require("./engine.js"); require("./agents.js");
const { Engine, Agents } = global;
const s = Engine.createMatch({ size: "M", seed: 1 });
const A = Agents.PRESETS.aggressive, B = Agents.PRESETS.defensive;
while (!s.over) Engine.step(s, A(Engine.buildView(s,"A")), B(Engine.buildView(s,"B")));
console.log("winner:", s.winner, "tick:", s.tick);
'
```

## デモの範囲（スコープ）

- L1（NPC）と L3（自前JS/LLM）を実装。**L2（DSL/ノードグラフ）はスコープ外**＝拡張ポイント。
- 1ラウンドの戦闘フェーズを実演（Best of N のラウンド管理は設計のみ）。
- 戦闘解決はデモ向けに簡略化（数ラウンドで決着する近似モデル）。数値は `engine.js` 冒頭の定数で `GDD.md` と一致。
