# Shadow Com — 開発計画

## 現在地

Phase 1〜5 完了。Phase 6 (次の改善候補) 検討中。

---

## Phase 1: 基盤 ✅

- [x] プロジェクト初期化 (Electron + electron-vite)
- [x] 共通パケット基盤 (`packet.js` / `rs-codec.js` / ユニットテスト32件)
- [x] 6タブUI (Air送受信 / AUX送受信 / HDMI送受信)

---

## Phase 2: Air / AUX ✅

- [x] 純JS MFSK実装 (`mfsk.js`)
- [x] Air: 8-FSK / 100ms/symbol / 15-19.5kHz
- [x] AUX: 16-FSK / 6-10.5kHz / `air-modem.js` 共通エンジン
- [x] FFTスペクトラムビジュアライザ

---

## Phase 3: HDMI ✅

- [x] `pixel-encoder.js` / `pixel-decoder.js`
- [x] セカンダリウィンドウ → HDMIディスプレイ全画面送出
- [x] キャリブレーション機能

---

## Phase 4: 統合・仕上げ ✅

- [x] パッケージング (`electron-builder`)
- [x] エラーハンドリング
- [x] README.md

---

## Phase 5: AUX 受信品質改善 ✅

### 完了
- [x] rAFジッター修正: beat-drop問題 (symPeriodとrAF周期の干渉) を解消
- [x] ISI修正: fftSize 2048→1024 (21ms窓 < 30ms symbol) + 33%ゲート
- [x] symbolStartずれ修正: syncフェーズ導入 (プリアンブル終了後、最初のデータ信号でsymbolStart確定)
- [x] AudioWorklet移行: rAF(16.7ms/ジッターあり) → AudioWorkletProcessor(5.3ms hop/sample-accurate)
- [x] symbolDuration 30→60ms: rAFジッターによるシンボル欠落をゼロに
- [x] FFT visualizer修正: `_lastFreqData` キャッシュ経由に変更
- [x] ループバック削除: 実機テストと乖離するため UI・エンジンから全面削除
- [x] symbolDuration 60→30ms に戻す: AudioWorklet移行により安全。実機動作確認済み

---

## Phase 6: HDMI 実機デバッグ・修正 ✅

### 完了
- [x] Mode 1 (Air) ISI修正: `mfsk.js` fftSize 4096→2048
- [x] HDMI受信: キャリブレーションボタンがカメラ未起動で失敗する問題を修正
- [x] HDMI受信: キャリブレーション失敗時にコントラスト値を表示
- [x] HDMI送受信: ディスプレイ/デバイス一覧にOS名称を表示・更新ボタン追加
- [x] HDMI受信: macOS カメラ権限リクエスト追加
- [x] HDMI受信: デバッグログ (`logs/hdmi_debug.json`) 自動保存
- [x] HDMI送信: FPSスライダー追加 (1〜30fps)、連続ループ送信
- [x] HDMI: `backgroundThrottling: false` でバックグラウンド時のrAF低下防止
- [x] HDMI: SAFE_H=1080 — 全高使用、実機確認済み
- [x] HDMI: P<4 ガード行追加 — JPEG 8×8 ブロックのヘッダ汚染を修正
- [x] HDMI: Pスライダー範囲 2〜20 に制限 (P=1: sync壊滅、P>20: header overflow)
- [x] HDMI: FPSスライダー上限 30 に制限 (UGREEN UVC キャプチャ上限)
- [x] **実機転送動作確認**: P=2〜16 で全フレーム受信・ファイル保存成功

---

## Phase 7: HDMI UI改善 ✅

### 送信側

- [x] ディスプレイ一覧: 内蔵ディスプレイ (`d.internal===true`) を除外
- [x] ディスプレイ一覧: ラベルに "USB" を含むものを最上位、次に "HDMI" を含むもの、残りをその後に並べる
- [x] ボタン名変更: 「ディスプレイ一覧を更新」→「外部出力先を探す」
- [x] ディスプレイ選択変更時: 旧ウィンドウを閉じて新ディスプレイにウィンドウを開き直す (自動追従)
  - 更新ボタン押下時は現在の選択 (displayId) を維持する
- [x] ウィンドウ開いた後、自動でキャリブレーションフレームを送信 (`setSimpleFullScreen` 完了後に delay して sendFrame)
- [x] 「HDMIウィンドウ開く」ボタン廃止 (ディスプレイ選択変更が代替)
- [x] 「ウィンドウ閉じる」ボタン廃止
- [x] デフォルト値変更: Pixel Size `8→2` (2×2)、FPS `10→30`
- [x] UIレイアウト順序: 外部出力先を探す → ディスプレイ選択 → Px/FPS → ファイル選択 → 送信開始

### 受信側

- [x] キャプチャデバイス一覧: ラベルに "Capture"/"USB Video"/"UVC"/"UGREEN"/"AV" を含むものを先頭に並べる (カメラは後ろ)
- [x] デフォルト値変更: Pixel Size `8→2` (2×2)
- [x] UIレイアウト順序: キャプチャデバイス → Px → キャリブ → 受信開始 → Received Frames (フレームグリッド+欠損) → ファイル保存 → 停止
- [x] LIVE CAPTURE動画: `min-height: 40vh` で最小サイズ確保 (現状小さすぎ)

---

## Phase 8: RGB 高速化試行 (失敗・撤回)

- [x] HDMI: RGB 3bit/cell エンコード実装 (1b5679f) — P=2 で 64KB→192KB、理論 5.8 MB/s
- [x] header `payload_len` を uint24 化 (f771180) — RGB P=2 で uint16 オーバーフロー対応
- [x] **撤回 (白黒 1bit/cell に戻す)** — UVC キャプチャ (MS2109 等) が MJPEG 4:2:0 圧縮:
  - クロマ平面 16×16 + 1/2 サブサンプリング → 小さい P で色情報が完全平均化
  - P=8: クロマブロック内 1 セル → 動作
  - P=4: クロマブロック内 4 セル → 欠損率 80%
  - P=2: クロマブロック内 16 セル → 壊滅 (sync 行までグレー均一化)
  - 白黒は luma 平面 (8×8) のみ判定で P=2 動作実績あり、RGB は本質的にクロマ依存
  - header `payload_len` uint24 は将来拡張のため維持
- [ ] (将来案) luma 多値 (グレースケール N値) でクロマ非依存の高速化

## Phase 9: HDMI UIボタン状態管理

- [x] 送信: `refreshDisplayList`中に `外部出力先を探す` + `ディスプレイ選択` を disabled
- [x] 送信: `openAndCalibrate`中に `外部出力先を探す` + `ディスプレイ選択` + `Px` + `FPS` を disabled
- [x] 送信: 送信中/再送中に `ファイル選択` + `Px` + `FPS` + `ディスプレイ選択` + `外部出力先を探す` + `再送開始` を disabled
- [x] 送信: `onHdmiWinClosed`で `再送開始` も disabled
- [x] 送信: ウィンドウ再開後にファイルあれば `再送開始` を enabled に戻す
- [x] 受信: 受信中に `デバイス選択` + `Px` を disabled、完了/停止/エラー時に enabled に戻す

## Phase 10: 次の改善候補

- [x] AUX: maxPayload拡大 (60B → 233B、RS上限MAX_DATA-HEADER=239-6=233)
- [ ] AUX受信: デバイスリスト自動更新 — `devicechange` イベント監視 + 更新ボタン追加 (現状タブクリック時のみ更新)
- [ ] Air/AUX: FEC — MFSKシンボル列にReed-Solomon追加
- [ ] HDMI: FPS実測値の表示 (送信・受信それぞれ)
- [ ] HDMI: 転送完了後の自動ファイル保存
