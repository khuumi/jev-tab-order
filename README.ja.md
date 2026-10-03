<div align="center">
  <img src="store-assets/social-preview-1280x640.png" alt="Jev Tab Order" width="640" height="320">

# Jev Tab Order

[English](README.md) | [日本語](README.ja.md)

[![Chrome Web Store Version](https://img.shields.io/chrome-web-store/v/afbcjklgfmfokamphkgclkocfhgablka.svg)](https://chromewebstore.google.com/detail/jev-tab-order/afbcjklgfmfokamphkgclkocfhgablka)
[![Chrome Web Store Users](https://img.shields.io/chrome-web-store/users/afbcjklgfmfokamphkgclkocfhgablka.svg)](https://chromewebstore.google.com/detail/jev-tab-order/afbcjklgfmfokamphkgclkocfhgablka)
[![Chrome Web Store Rating](https://img.shields.io/chrome-web-store/rating/afbcjklgfmfokamphkgclkocfhgablka.svg)](https://chromewebstore.google.com/detail/jev-tab-order/afbcjklgfmfokamphkgclkocfhgablka)
[![GitHub Stars](https://img.shields.io/github/stars/proshunsuke/jev-tab-order.svg)](https://github.com/proshunsuke/jev-tab-order)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/)
[![License](https://img.shields.io/github/license/proshunsuke/jev-tab-order.svg)](https://github.com/proshunsuke/jev-tab-order)

<a href="https://chromewebstore.google.com/detail/jev-tab-order/afbcjklgfmfokamphkgclkocfhgablka">
  <img src="https://developer.chrome.com/static/docs/webstore/branding/image/iNEddTyWiMfLSwFD6qGq.png" alt="Available in the Chrome Web Store" width="248" height="75">
</a>

</div>

[Jev](https://typesafe.ai/)を利用し、現在のウィンドウのタブとグループを意味や指定した並べ替えルールに沿って整理するChrome拡張機能です。固定タブと既存グループの所属を維持します。

**サイズを制限したJevリクエストでウィンドウ全体を整理。** 段階的に判断し、大きな処理は自動的に分割します。

## 使い始める

1. [Chrome Web Store](https://chromewebstore.google.com/detail/jev-tab-order/afbcjklgfmfokamphkgclkocfhgablka)から拡張機能をインストールします。
2. 拡張機能の設定を開き、Jevプロバイダーを選び、その設定を保存します。
3. 整理したいウィンドウでツールバーのアイコンをクリックします。ポップアップは開かず、アイコンに実行中は「…」、完了時は「✓」を表示し、完了から3秒後にバッジが消えます。ページの右クリックメニューや設定済みショートカットからも実行できます。

[対応言語](locales/)を参照してください。

ソースコードから導入する場合は、[手動インストール](#手動インストール)を参照してください。

### 設定

Jevの実行先を選択します。既存の設定は、保存済みのキーを保持してOpenRouterを使用します。

| プロバイダー        | 接続先                                      | 既定のモデル           | APIキー              |
| ------------------- | ------------------------------------------- | ---------------------- | -------------------- |
| OpenRouter          | `https://openrouter.ai/api/alpha/decisions` | `~typesafe/jev-latest` | OpenRouterキーが必要 |
| TypeSafe            | `https://api.typesafe.ai/v1/systemone`      | `jev-latest`           | TypeSafeキーが必要   |
| カスタム / ローカル | 入力した完全なURL                           | 未指定なら省略         | 任意                 |

- **モデル**：互換性のあるJevモデル識別子で既定値を変更できます。空欄なら既定値を使用し、カスタム / ローカルではモデルを送信しません。
- **判断APIのURL**：カスタム / ローカルでは入力したHTTPまたはHTTPSのURLをそのまま使用します。APIのパスまで含めてください。パスの自動追加はありません。`{ state, questions, model? }` を受け取り、Jevの選択・スコア形式で `{ answers }` を返すAPIが必要です。汎用チャット補完APIには対応しません。認証情報、クエリ、フラグメントを含むURLは拒否し、リダイレクトには追従しません。
- **APIキー**：この端末だけに保存します。プロバイダーの切り替えやカスタム接続先のオリジン変更時にキーを消去し（同一オリジンのパス変更では保持）、別のサービスへの誤送信を防ぎます。カスタム / ローカルで空欄ならAuthorizationヘッダーは送信しません。保存と接続テストでTypeSafeまたはカスタム接続先へのアクセスを要求し、拒否された場合は保存・テストしません。Chromeの許可はホスト単位で、APIのパスだけには限定されません。HTTPはlocalhostを含め、APIキーなしの場合のみ使用できます。キーを使用する接続先にはHTTPSが必要です。
- **接続テスト**：保存前でも現在入力したプロバイダー、接続先、モデル、キーを使用します。整理・プレビューは保存済み設定を使い、大きな処理はサイズを制限したリクエストに分割します。元に戻す操作では送信しません。

- **並べ替えルール**：空欄なら既定ルールを使用します。入力すると既定ルール全体を置き換えます。例：「公式ドキュメントを先に、その後に解説記事。グループは開発、調査、個人の順。」
- **新規グループを許可**：この設定が有効で、関連する未所属タブが複数あり、命名用のChrome内蔵AIが利用できる場合に作成します。初回ダウンロードが必要な場合は設定画面の準備ボタンを押してください。

<img src="store-assets/screenshots/ja/01-settings.png" alt="Jev Tab Orderの設定画面" width="640">

## 仕組み

拡張機能がウィンドウのタブ情報を集め、Jevに判断を依頼し、その回答から配置を組み立ててChromeに反映します。

1. **情報を集める — 拡張機能：** タブのタイトル、URL、現在の位置、グループへの所属を取得し、ルールとグループ名を合わせて準備します。固定タブはJevへの入力から除外し、ページ本文は読みません。URLの認証情報・クエリ・フラグメントは送信前に除去します。
2. **意味を判断する — Jev：** 「未所属タブをどの既存グループに追加するか」「どのタブやグループを隣接させるか」「ルール上、どれを前方・後方に配置するか」を、**サイズを制限したリクエストで判定**します。選択肢にはドメインやグループ名も添えます。回答は選択結果や優先度の数値で返り、選択確率と確信度も含まれます。
3. **配置を組み立てる — 拡張機能：** 採用した選択結果から未所属タブの追加先を決め、関連する項目を隣接するまとまりにします。その内部とまとまり同士を、Jevの優先度が小さい順に並べます。採用基準を下回る回答は使わず、同順位なら元の順序を維持し、有効な優先度がない項目はそのソート段階での位置を保ちます。配置の組み立ては端末内で行います。順位の決定には追加のサイズを制限した比較を使う場合があります。
4. **新規グループに名前を付ける — 有効な場合のみChromeのローカルAI：** 設定が有効で、Jevが関連性を十分な確信度で判断した場合、関連する未所属タブから新規グループを作れます。名前はタブのタイトルをもとにChrome内蔵AIが生成します。命名できなければ、新規グループを作らず隣接した状態にします。
5. **検証して反映する — 拡張機能：** タブの欠落や重複がなく、固定タブと既存グループの所属を維持できる計画かを確認し、Chrome APIでタブとグループを移動します。プレビューでは適用前で止まり、元に戻す操作ではJevを呼ばずに保存済みの配置を復元します。

たとえば、Jevが未所属タブの追加先として「GitHub」を選び、その回答が採用基準を満たした場合、拡張機能が既存のGitHubグループへタブを追加します。意味の判断をJevが担当し、ブラウザ上の操作を拡張機能が担当します。

### Jevに送るリクエストの内容

OpenRouterを選択した場合、ネイティブの `fetch` を使い、`POST https://openrouter.ai/api/alpha/decisions` に、`model: "~typesafe/jev-latest"` を指定してJSONを送ります。本文は共通の判断材料（`state`）と複数の質問（`questions`）で構成します。**各APIリクエストにはサイズを制限した質問のバッチを含めます。** 構造を決めてから順位の質問を準備します。

- **`state` — 判断材料：** 適用するルール、WebタブのID・タイトル・加工済みURL・グループへの所属、既存グループの名前と所属タブのID、グループと未所属タブの現在の並びを渡します。各段階は必要な判断材料だけを送ります。
- **`questions` — 判定してほしいこと：** 各質問に、`type`（ChoiceかScore）、`instructions`（ルールに従って何を判断するか）、`criteria`（選択肢または順序付きの評価段階）を指定します。

| 判定内容                                       | 種類                   | 求める回答                                                                                                        |
| ---------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 各未所属タブの追加先                           | **Choice**（`choice`） | 名前を添えた既存グループのID、または未所属のままにする `none`                                                     |
| 隣接させるタブ                                 | **Choice**（`choice`） | ドメインを添えた前方の候補タブのID、または該当なしの `self`。候補は同じ既存グループ内、または未所属タブ同士に限定 |
| 隣接させるグループ・未所属タブ                 | **Choice**（`choice`） | グループ名やドメインを添えた前方の候補のID、または別々にする `self`                                               |
| 各タブ、およびグループ・未所属タブの配置優先度 | **Score**（`score`）   | 「最も前・前・中間／順序指定なし・後・最も後」の5段階によるスコア                                                 |

Choiceでは選んだIDが `choice` に返り、拡張機能がタブ同士の関連付けや追加先の決定に使います。Scoreでは **0〜4の数値**（小数を含む）が返り、これをソートの優先度、またはマージソートの局所的な比較に使います。最終的なタブの位置番号ではありません。どちらも `probabilities`（各選択肢・段階の確率）と `confidence`（確信度）が付き、拡張機能が採用前に確認します。Scoreには段階番号と説明を対応させる `legend` も含まれます。

### 段階的なリクエスト例

固定されていない2つのタブが異なる入れ物にあります。タブ `1`（GitHub）はグループ `7`（GitHub）に所属し、タブ `2`（GitHub Docs）は未所属です。最初のリクエストで所属を決めます。ブロックの隣接関係は別の簡潔な判断材料を使います。例では通信時のモデル名を省略しています。固定の指示は英語で、ユーザーのルールは翻訳せずに送ります。

**構造のリクエスト：**

```json
{
  "state": {
    "rules": "Add GitHub tabs to the GitHub group. Put documentation first.",
    "tabs": [
      {
        "id": "1",
        "title": "GitHub",
        "url": "https://github.com/",
        "groupId": 7
      },
      {
        "id": "2",
        "title": "GitHub Docs",
        "url": "https://docs.github.com/",
        "groupId": -1
      }
    ],
    "groups": [
      {
        "key": "group_7",
        "title": "GitHub",
        "tabIds": ["1"]
      }
    ],
    "blocks": [
      {
        "key": "group_7",
        "title": "GitHub",
        "tabIds": ["1"]
      },
      {
        "key": "topic_2",
        "title": "",
        "tabIds": ["2"]
      }
    ]
  },
  "questions": {
    "membership_2": {
      "type": "choice",
      "instructions": "According to state.rules, select an existing group for ungrouped tab 2 (Domain: docs.github.com), or none.",
      "criteria": {
        "none": "Keep ungrouped",
        "group_7": "Group name: \"GitHub\""
      }
    }
  },
  "model": "~typesafe/jev-latest"
}
```

所属の回答が `group_7` を選ぶと、両方のタブが同じ比較対象になります。後続のリクエストは最終的な比較対象だけを評価し、入れ物の名前と最終的な所属を保持します。

```json
{
  "state": {
    "rules": "Add GitHub tabs to the GitHub group. Put documentation first.",
    "container": {
      "key": "group_7",
      "title": "GitHub"
    },
    "tabs": [
      {
        "key": "1",
        "id": "1",
        "title": "GitHub",
        "url": "https://github.com/",
        "groupId": 7
      },
      {
        "key": "2",
        "id": "2",
        "title": "GitHub Docs",
        "url": "https://docs.github.com/",
        "groupId": 7
      }
    ]
  },
  "questions": {
    "rank_tab_1": {
      "type": "score",
      "instructions": "Rate the position of tab 1 among the complete ranking peers in state.tabs under state.rules; earlier is lower. Use the middle level if no order is specified.",
      "criteria": [
        "Earliest priority under the rules",
        "Early priority under the rules",
        "Middle priority or no distinguished order under the rules",
        "Late priority under the rules",
        "Latest priority under the rules"
      ]
    },
    "rank_tab_2": {
      "type": "score",
      "instructions": "Rate the position of tab 2 among the complete ranking peers in state.tabs under state.rules; earlier is lower. Use the middle level if no order is specified.",
      "criteria": [
        "Earliest priority under the rules",
        "Early priority under the rules",
        "Middle priority or no distinguished order under the rules",
        "Late priority under the rules",
        "Latest priority under the rules"
      ]
    }
  }
}
```

Scoreの回答は前述の5段階の `legend` と確率分布を含みます。最終ブロックが1つならブロックの順位リクエストは不要です。最終ブロックが複数なら、別のリクエストで簡潔なブロック記述を使います。新しいグループの命名は順位の決定後に行います。

## プライバシー

[プライバシーポリシー](PRIVACY.md)を参照してください。

## 開発

### 環境構築

[package.json](package.json)の対応範囲のNode.jsを使用してください。[CIワークフロー](.github/workflows/test.yml)ではNode.js 24を使用しています。プロジェクトディレクトリで実行します。

```fish
npm ci
```

### 主なコマンド

```fish
npm run dev          # ホットリロード対応のChrome開発モードを起動
npm run build        # Chrome拡張機能をビルド
npm run typecheck    # TypeScriptの型チェック
npm run lint:check   # ファイルを変更せずlintを確認
npm run format:check # ファイルを変更せず整形を確認
```

### 手動インストール

環境構築を完了してから実施します。

1. `npm run build`を実行します。
2. Chromeで`chrome://extensions`を開き、**デベロッパーモード**を有効にします。
3. **パッケージ化されていない拡張機能を読み込む**から`dist/chrome-mv3`を選択します。
4. 拡張機能の設定を開き、APIキーを入力して**設定を保存**をクリックします。

再ビルド後は、`chrome://extensions`から拡張機能を再読み込みして更新を反映してください。

### 単体テスト

共通の通信テストをOpenRouter、TypeSafe、カスタム / ローカルに対して実行します。モデルの変更、キーなしのローカル通信、URL検証、アクセス許可、既存設定の移行もテストします。

```fish
npm run test:unit
```

### E2Eテスト

初回実行前にPlaywrightのChromiumをインストールします。

```fish
npx playwright install chromium
npm run test:e2e
```

## リリース

準備と公開の手順は[リリースガイド](.agents/skills/jev-tab-order-release/SKILL.md)、変更履歴は[CHANGELOG.md](CHANGELOG.md)を参照してください。

### リクエストの上限

プロバイダーはモデル名、ルール、判断材料、質問を含むUTF-8 JSON本文を計測し、保守的な64,000バイトの予算と比較します。小さなカスタム・ローカルモデルには `createJudge` の `maxRequestBytes` を指定できます。これは入力サイズの推定であり、正確なトークン数ではありません。HTTP 413または認識可能なHTTP 400のトークン上限エラーだけを分割して再試行します。最小限の質問も収まらなければ入力上限エラーを返します。

計画は段階的に作成します。所属と隣接関係を決め、最終的な入れ物を構成し、その中でタブを並べ、最終ブロックを並べてから、新しいグループを命名します。独立した構造のリクエストは同時に実行し、入れ物の順位評価は最大4件を並列で実行します。各段階は開始済みのリクエストが完了してからエラーを通知します。タブの順位評価には最終的な入れ物の対象タブだけを含めます。新規グループ作成を許可した場合は、その候補グループごとに比較します。ブロックの評価にはキー、既存のグループ名、元の位置、最大3件の代表的なタイトルと無害化したURLを含む簡潔な記述を使い、ウィンドウ全体の詳細な状態を重複して送りません。

比較対象全体が収まる場合は、その判断材料を共有して5段階の優先度を評価します。バッチ処理は評価質問から比較対象を削除しません。全体が収まらない場合やプロバイダーがサイズ上限で拒否した場合は、収まる最大の分割内で順位を評価し、2件ずつ比較する安定マージソートで分割を統合します。分割内の評価値はその分割を並べるためだけに使い、全体順位には転用しません。兄弟の分割の処理は2件を並列で実行でき、より深い再帰は逐次実行します。各マージでは両方の分割の先頭を同じルールで比較します。局所的な評価値は次の先頭を選ぶためだけに使い、全体順位には転用しません。同点や不確かな比較では左側を選びます。モデルの好みが推移的でない場合も、決定論的な比較順序で結果を定めます。2件の比較も収まらなければ入力上限エラーを返します。1件だけの入れ物は順位のリクエストを必要としません。大きな順位評価にはO(n log n)件の比較リクエストが必要になる場合があります。

選択質問は収まる限り全状態を保持し、それ以外では対象、候補、明示的に参照するグループ・ブロックの所属タブに判断材料を絞れます。タブの隣接質問では、所属するグループの名前と参照する所属タブのIDだけを保持し、所属タブ全体は展開しません。大きな隣接質問は候補を順番に分割して最初の確信度の高い一致を選び、所属質問は各分割の候補を比較します。命名は必要な判断がすべて終わってから開始します。キャンセル時に部分的な計画を適用しません。構造の比較量は二次的に増える場合があります。モデルの回答は判断材料によって変わる可能性があり、決定論的なテストは実モデルの戦略間の同一性ではなく、比較結果の組み立てを検証します。
