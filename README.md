# Shadow Com

Wi-Fi / Bluetooth / インターネット不使用。PCのAV入出力（音・光・映像）でデータ転送するElectronアプリ。
エアギャップ環境・NIC完全無効化環境で動作。

## 通信モード

| モード | 媒体 | 速度目安 | ユースケース |
|--------|------|---------|------------|
| Mode 1 | 音波 (空気) | ~30 bps | テキスト・小ファイル |
| Mode 2 | 音波 (ケーブル直結) | ~67 bps | 数KBのファイル |
| Mode 4 | HDMI → キャプチャボード | ~15 Mbps (P=2, 30fps) | 大容量ファイル |

## ダウンロード

[Releases](https://github.com/kazuhitogo/shadow-com/releases) から各 OS 用の
インストーラをダウンロード:

- **macOS**: `Shadow Com-x.y.z-arm64.dmg`
- **Windows**: `Shadow Com Setup x.y.z.exe`
- **Linux**: `Shadow Com-x.y.z.AppImage`

## セットアップ (開発者向け)

```bash
git clone https://github.com/kazuhitogo/shadow-com.git
cd shadow-com
npm install
npm run dev        # 開発起動
npm run build      # プロダクションビルド
npm run package    # インストーラ生成 (ローカル OS のみ)
npm test           # ユニットテスト
```

**必要環境**: Node.js 18+, npm 9+

## リリース

`main` に v1.2.3 のような Git タグを push すると GitHub Actions が
macOS / Windows / Linux ランナーで並列ビルドし、自動で GitHub Release に
インストーラをアップロードする。

```bash
# package.json と package-lock.json の version を更新後:
git tag -a v1.2.3 -m "Release v1.2.3"
git push origin v1.2.3
```

## ブランチ運用

- `main` への直接コミット禁止。新規開発・修正はブランチを切る (`feat/xxx`, `fix/xxx` 等)
- 動作確認後 PR でマージ。試行錯誤コミットは squash で1つに
- `main` は常にビルド可能・リリース可能な状態を保つ

## ハードウェア接続

### Mode 1 — Acoustic Air
- 送信側: スピーカー出力 (内蔵スピーカー可)
- 受信側: マイク入力 (内蔵マイク可)
- 距離目安: 1m 以内推奨、静かな環境

### Mode 2 — Wired Audio
- 3.5mm ステレオミニプラグ (TRRS) ケーブルで直結
- 送信側: イヤホンジャック (出力)
- 受信側: マイク端子 (入力)
- ノイズゼロのため Mode 1 より高速

### Mode 4 — Video Matrix (HDMI)
- 接続: 送信側PC HDMI出力 → キャプチャボード HDMI IN → 受信側PC USB
- キャプチャボード: UVC対応 (MS2109チップ等の汎用キャプチャカード)
- **macOS 注意**: USB-Cドック経由の場合、ドックのHDMIポートではなく
  "HDMI TO USB" USB ディスプレイアダプタの HDMI 出力を使うこと
- **カメラ権限**: 初回起動時に macOS カメラ権限ダイアログが表示される。許可すること
- キャリブレーション手順:
  1. 送信タブで外部ディスプレイを選択し「HDMIウィンドウ開く」
  2. 「キャリブレーション表示」で市松模様を送出
  3. 受信タブでキャプチャデバイスを選択し「キャリブレーション」を押す
  4. 「閾値キャリブレーション完了: XX」が表示されたら成功
  5. ピクセルサイズを送受信側で同じ値に設定して送受信開始

## アーキテクチャ

```
shadow-com/
├── electron/
│   ├── main.js          # Mainプロセス (IPC, ファイルI/O, HDMI窓管理)
│   └── preload.js       # contextBridge IPC bridge
├── src/
│   ├── renderer/
│   │   ├── index.html        # メインUI (6タブ)
│   │   ├── main.js           # Renderer ロジック
│   │   ├── styles.css        # ダークテーマ CSS
│   │   ├── hdmi-display.html # HDMI出力セカンダリウィンドウ
│   │   └── hdmi-display.js   # HDMI描画ロジック
│   ├── common/
│   │   ├── packet.js    # パケット分割・組立・CRC16 (RS統合)
│   │   └── rs-codec.js  # Reed-Solomon GF(2^8) 純JS (NROOTS=16, 8エラー訂正)
│   ├── modes/
│   │   ├── acoustic/
│   │   │   ├── mfsk.js      # MFSK設定・ビット変換・フレーム組立
│   │   │   └── air-modem.js # 音波送受信エンジン (Web Audio API)
│   │   └── hdmi/
│   │       ├── pixel-encoder.js # ピクセルマトリクス描画
│   │       └── pixel-decoder.js # ピクセルマトリクス解析
│   └── tests/
│       ├── rs-codec.test.js      # 7件
│       ├── packet.test.js        # 8件
│       ├── mfsk.test.js          # 9件
│       └── pixel-encoder.test.js # 8件
└── assets/
```

## パケットフォーマット (Mode 4 共通)

```
[seq:2B][total:2B][crc16:2B][payload:NB][rs_parity:16B]
```
- RS(255,239) — 最大8バイトエラー訂正
- 最大ペイロード: 217 bytes, HDMI は bytesPerFrame まで

## 技術スタック

- **Electron** 33 + **electron-vite** 2 + **Vite** 5
- **Web Audio API** — MFSK音波変調/復調
- **Canvas API + ImageData** — ピクセルマトリクス描画
- **Vitest** — ユニットテスト

## セキュリティ

- OSネットワークスタック (TCP/IP) 一切不使用
- localhost 以外のポート開放なし
- NIC完全無効化環境で全機能動作
