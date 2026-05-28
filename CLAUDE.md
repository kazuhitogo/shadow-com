# Shadow Com — Claude向け指示

## セッション開始時に必ず読め

1. `SPEC.md` — アプリ仕様・モード詳細・設定値
2. `PLAN.md` — 実装フェーズ・タスクチェックリスト（完了済み・次のタスク）

実装前に PLAN.md のチェックリストで現在地確認 → 次タスク特定 → 着手。
完了したタスクは `- [x]` に更新。

## ドキュメント同期ルール（必須）

コード変更が以下に該当する場合、**コードと同じコミットで**対応ドキュメントを更新せよ。
更新漏れはプロジェクトの地図が腐る原因になる。

| 変更内容 | 更新対象 |
|----------|---------|
| 設定値変更 (周波数・duration・threshold・maxPayload等) | `SPEC.md` の該当モード設定値ブロック + 速度目標 |
| 速度・スループット変化 | `SPEC.md` §5.1 速度目標 + `README.md` 通信モード表 |
| フェーズ・タスク完了 | `PLAN.md` の該当 `- [ ]` → `- [x]` |
| 新機能追加・削除 | `SPEC.md` 該当セクション + `README.md` |
| アーキテクチャ変更 | `SPEC.md` §6 ディレクトリ構成 + `README.md` アーキテクチャ |

**チェックリスト（タスク完了前に確認）:**
- [ ] SPEC.md の設定値・仕様は現在のコードと一致しているか
- [ ] README.md の速度目安・接続方法は正確か
- [ ] PLAN.md のタスク状態は現在地を反映しているか

## 開発コマンド

```bash
npm run dev      # 開発サーバー起動 (electron-vite)
npm run build    # プロダクションビルド
npm run package  # electron-builder パッケージング
```

コード変更後は必ず `rm -rf out/ && npm run dev` でリビルド。

## 重要ファイル

```
src/modes/acoustic/mfsk.js          # MFSK設定値・encode/decode純関数
src/modes/acoustic/air-modem.js     # 送受信エンジン (AudioWorklet使用)
src/modes/acoustic/modem-worklet.js # AudioWorkletProcessor (FFT実装込み)
src/modes/hdmi/pixel-encoder.js     # HDMI フレーム描画・容量計算
src/modes/hdmi/pixel-decoder.js     # HDMI ピクセル読取・CRC検証
src/renderer/main.js                # UIロジック全体
electron/main.js                    # IPCハンドラ
electron/preload.js                 # contextBridge
```

## デバッグログ

- AUX受信デバッグログ: `logs/aux_debug.json`（受信停止時に自動保存）
- HDMI受信デバッグログ: `logs/hdmi_debug.json`（受信停止時・保存失敗時に自動保存）
- `logs/` は `.gitignore` 済み

## 音響モードの注意点

- AUX受信はAnalyserNode+rAFではなく **AudioWorklet** を使用（sample-accurate）
- `modem-worklet.js` は `?raw` importでBlobURL経由でロード
- FFT visualizerは `modem._lastFreqData` を参照（AnalyserNodeは存在しない）
- Mode 2 (AUX) の symbolDuration は SPEC.md の値を確認してから触ること
- **symbolDuration変更時は送受信両機を必ず同時リビルド**。片方のみだとシンボル境界ずれで受信不能になる

## HDMI モードの注意点

- **SAFE_H = 1080**: 全高使用。エンコーダ・デコーダ両方に定数あり
- **dataRowOffset(P)**: P<4 のとき JPEG 8×8 ブロック境界問題を避けるためガード行を挿入。P=2→dataStart=4、P=3→3、P≥4→2
  - 理由: P<4 だとヘッダ行とデータ行が同一 JPEG 8×8 ブロック(y=0-7)に入り、DCT リンギングでヘッダビットが化ける
- **P の有効範囲: 2〜20**。P=1: JPEG でシンク行が壊滅。P>20: cols<96 でヘッダが1行に収まらない
- **FPS 上限: 30**（UGREEN UVC キャプチャボード 1080p@30fps 上限）
- **エンコーダ・デコーダの定数は必ず同期**。片方だけ変えるとフレームレイアウトがずれて全フレーム CRC 失敗
- Electron の `backgroundThrottling: false` が HDMI ウィンドウに設定済み（なければ rAF が 1fps に落ちる）
