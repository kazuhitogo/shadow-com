# Shadow Com — 仕様書

## 1. 概要

Wi-Fi/Bluetooth/インターネット不使用。PCのAV入出力（音・光・映像）でデータ転送するElectronアプリ。

**エアギャップ環境でも動作。NIC完全無効化環境対応。**

---

## 2. 動作環境

- プラットフォーム: Electron (Main: Node.js / Renderer: Chromium)
- OS: Windows 10/11 / macOS (Intel・Apple Silicon) / Linux (Ubuntu等)
- 主要ライブラリ:
  - Web Audio API — MFSK音波変調/復調
  - Canvas API + ImageData — ピクセルマトリクス描画

---

## 3. 共通機能

### 3.1 ファイルセレクター
- 転送ファイル選択 (テキスト/CSV/画像等)
- 送受信モード切替

### 3.2 進捗UI
- パケット分割状況
- 転送レート (Bytes/s)
- エラー訂正発生状況
- パケットロス率
- 残り時間

### 3.3 パケット共通フォーマット
```
[seq:2B][total:2B][crc16:2B][payload:NB][rs_parity:16B]
```
- RS(255,239) — 最大8バイトエラー訂正
- 最大ペイロード: 233 bytes (255 - NROOTS(16) - HEADER(6) = 233)

---

## 4. 通信モード

### Air — スピーカー/マイク音波

**インターフェース**: 内蔵スピーカー → 内蔵マイク (同室1m以内)  
**目標速度**: ~30 bps  
**ユースケース**: テキスト・数十バイトの小ファイル

**送信 (変調)**:
- 8-FSK、15〜18.5kHz帯、500Hz間隔、100ms/symbol
- プリアンブル: 19.5kHz、400ms
- OscillatorNode でソフトエンベロープ付きトーン生成

**受信 (復調)**:
- getUserMedia マイクキャプチャ
- AudioWorkletProcessor FFT (AUXと共通エンジン)
- プリアンブル検知 → syncフェーズ → シンボルデコード → RS誤り訂正

**Mode 1 設定値 (`mfsk.js`)**:
```js
tones: 8, bitsPerSymbol: 3
baseFreq: 10000, freqSpacing: 500  // 10000〜13500 Hz
symbolDuration: 100                 // ms
preambleFreq: 9000, preambleDuration: 400, silenceGap: 100  // 9kHz: データ帯域下側。silenceGap=symbolDuration: sync誤検出防止
fftSize: 2048, threshold: -65      // ~43ms窓
maxPayload: 20                      // bytes/packet
```

---

### AUX — 3.5mmステレオミニケーブル直結音波

**インターフェース**: イヤホンジャック(出力) → マイク端子(入力) ケーブル直結  
**目標速度**: ~128 bps (symbolDuration=30ms、maxPayload=233B)
**ユースケース**: 数KBのファイル

**送信 (変調)**:
- 16-FSK、6〜10.5kHz帯、300Hz間隔、**30ms/symbol**
- プリアンブル: 11kHz / 200ms + 10msサイレンス
- Air モードと共通エンジン (`mfsk.js` / `air-modem.js`)

**受信 (復調)**:
- **AudioWorkletProcessor** でFFT計算 (`modem-worklet.js`)
  - hop = fftSize/4 = 256サンプル ≈ 5.3ms (sample-accurate、rAFジッターなし)
- fftSize=1024 (≈21ms窓) — symbolDurationより短くISI回避
- 33%ゲート: 各シンボル先頭33%をスキップ (前シンボルのFFT残響除去)
- syncフェーズ: プリアンブル終了後、データ帯域の最初の信号でsymbolStart確定
- `_lastFreqData` キャッシュ経由でFFT visualizerに提供

**AUX受信 デバイス選択 既知の問題**:
- デバイスリストはタブクリック時のみ更新 — ケーブル刺し後にタブ再クリックで手動更新が必要
- `devicechange` イベント未監視 — ホットプラグで自動更新されない
- 対策: `navigator.mediaDevices.addEventListener('devicechange', ...)` + 更新ボタン追加が必要

**Mode 2 設定値 (`mfsk.js`)**:
```js
tones: 16, bitsPerSymbol: 4
baseFreq: 6000, freqSpacing: 300   // 6000〜10500 Hz
symbolDuration: 30                  // ms
preambleFreq: 11000, preambleDuration: 200, silenceGap: 10
fftSize: 1024, threshold: -45
maxPayload: 233                     // bytes/packet (RS上限: MAX_DATA-HEADER_SIZE=239-6=233)
```

---

### HDMI — ビデオマトリクス

**インターフェース**: HDMI出力 → USBキャプチャボード (UVC対応)  
**実測スループット**: P=2 で約 63KB/フレーム × 最大30fps ≈ **1.9 MB/s** (monochrome 1bit/cell)  
**ユースケース**: 大容量ファイル (数MB〜)

**送信**:
- データ → ビットマップ変換 (白=1, 黒=0)
- 有効キャンバス: 1920×**1080** px (SAFE_H=1080、全高使用)
- ピクセルサイズ P: **2〜20** px (P=1: JPEG sync壊滅。P>20: ヘッダ96ビットが1行に収まらない)
- FPS: **1〜30** fps (UVC キャプチャボード上限 1080p@30fps)
- フレームレイアウト (グリッド行単位):
  - row 0: シンクロ行 (奇数列=白・偶数列=黒の交互)
  - row 1: ヘッダ行 — frame_idx(4B) + data_total(2B) + parity_count(1B) + payload_len(3B) + crc16(2B) = 96ビット
  - rows 2〜dataStart-1: **ガード行** (P<4 のみ、全黒) — JPEG 8×8 ブロック汚染防止
  - rows dataStart〜: データ行 (MSB first、左→右・上→下)
- dataStart = P<4 ? ceil(8/P) : 2 (P=2→4、P=3→3、P≥4→2)
- 容量: floor((floor(SAFE_H/P) − dataStart) × floor(1920/P) / 8) bytes/frame (monochrome 1bit/cell)
  - P=2: 64,320 B/frame、P=8: 3,990 B/frame、P=16: 975 B/frame
- 1サイクル送信: data frames → parity frames を一度だけ送って停止 (欠損は手動再送 UI で個別指定)
- Electron セカンダリウィンドウ (backgroundThrottling: false) に全画面描画

**受信**:
- UVCキャプチャボード → getUserMedia ビデオ入力
- 純JS ピクセル輝度解析 (opencv不要)
- 動的閾値: 毎フレームのシンクロ行から黒/白平均を算出し (avgBlack+avgWhite)/2 を使用
- キャリブレーション機能: 市松フレームで静的閾値を初期設定
- 多点サンプリング: r=max(0, floor(min(scaledPx, scaledPy)/4)) の正方領域を平均
- CRC-16/CCITT (polynomial 0x1021) でフレーム検証

---

## 5. 非機能要件

### 5.1 速度目標

- Air: ~30 bps (テキスト、数十バイト)
- AUX: ~128 bps (数KB、maxPayload=233B)
- HDMI: ~1.9 MB/s (P=2, 30fps) 〜 ~9.7 KB/s (P=16, 10fps)

### 5.2 セキュリティ・隔離性
- OSネットワークスタック (TCP/IP・UDP) 一切不使用
- localhost以外のポート開放禁止
- NIC完全無効化環境で全機能動作

### 5.3 UI/UX
- Electronシングルウィンドウ (6タブ: Air/AUX/HDMI × 送受信)
- HDMI送信は専用セカンダリウィンドウ
- ダークテーマ

**HDMI送信 UIフロー**:
1. 「外部出力先を探す」ボタンでディスプレイ一覧を取得
   - 内蔵ディスプレイ (`d.internal===true`) を除外
   - ラベルに "USB" を含むものを最上位、次に "HDMI"、残りをその後に並べる
2. ディスプレイ選択変更 → 旧ウィンドウ閉じて新ディスプレイにウィンドウ開き直し (自動追従)
   - ウィンドウ開放後、`setSimpleFullScreen` 完了を待ってキャリブレーションフレームを自動送信
3. Pixel Size / FPS 設定 (デフォルト: Px=2×2、FPS=30)
4. ファイル選択
5. 送信開始

**HDMI送信 ボタン状態管理**:
- ディスプレイ探索中 (`refreshDisplayList`): `外部出力先を探す` + `ディスプレイ選択` → disabled
- ウィンドウ開く中 (`openAndCalibrate`): `外部出力先を探す` + `ディスプレイ選択` + `Px` + `FPS` → disabled
- 送信中/再送中: `ファイル選択` + `Px` + `FPS` + `ディスプレイ選択` + `外部出力先を探す` + `再送開始` → disabled
- ウィンドウ消滅 (`onHdmiWinClosed`): `送信開始` + `再送開始` → disabled
- ウィンドウ再開後にファイルあり: `送信開始` + `再送開始` → enabled

**HDMI受信 UIフロー**:
1. キャプチャデバイス選択
   - ラベルに "Capture"/"USB Video"/"UVC"/"UGREEN"/"AV" を含むものを先頭 (カメラは後ろ)
2. Pixel Size 設定 (デフォルト: Px=2×2)
3. キャリブレーション
4. 受信開始
5. Received Frames (フレームグリッド + 欠損フレーム表示)
6. ファイル保存
7. 停止
- LIVE CAPTURE 動画: `min-height: 40vh`

**HDMI受信 ボタン状態管理**:
- 受信中 (カメラ起動〜完了/停止まで): `デバイス選択` + `Px` → disabled
- 完了/停止後: `デバイス選択` + `Px` → enabled

---

## 6. ディレクトリ構成

```
shadow-com/
├── package.json
├── electron/
│   ├── main.js          # Mainプロセス
│   └── preload.js       # IPC bridge
├── src/
│   ├── renderer/        # UI (index.html / main.js / styles.css)
│   ├── modes/
│   │   ├── acoustic/    # Air・Cable 共通音波エンジン
│   │   │   ├── mfsk.js           # MFSK設定・フレーム組立
│   │   │   ├── air-modem.js      # 送受信エンジン
│   │   │   └── modem-worklet.js  # AudioWorkletProcessor (FFT実装込み)
│   │   └── hdmi/        # HDMI ビデオマトリクス
│   │       ├── pixel-encoder.js
│   │       └── pixel-decoder.js
│   └── common/
│       ├── packet.js    # パケット分割・組立・CRC16
│       └── rs-codec.js  # Reed-Solomon GF(2^8)
└── assets/
```
