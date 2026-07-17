# 🚀 GETTING_STARTED.md

このガイドでは、「小人の靴屋」をあなたの PC に迎え入れ、最初の仕事を頼むまでの手順を説明します。

> [!CAUTION]
> 本プロダクトは 任意のシェルコマンド実行およびファイル操作権限 を持つ高権限エージェントとして動作します。
> 誤動作や悪意ある入力により、意図しないコマンド実行・ファイル削除・情報漏洩が発生する可能性があります。
> WSL2 + Docker は被害軽減策に過ぎず、安全性を保証するものではありません。

## 🧩 環境構成の概要

以降の手順では、安全性と再現性を最優先し、実行環境を明確に分離しています。

* **Windows（ホスト）**

  * LM Studio / Ollama を実行
  * GPU・モデル管理のみ担当
  * AI エージェントからの直接操作は禁止

* **WSL2（Ubuntu）**

  * リポジトリの `git clone`
  * `.env` の作成・管理
  * Docker のビルド・起動
  * Windows ファイルシステム（`C:\`, `/mnt/c`）は使用しない

* **Docker（AI エージェント実行環境）**

  * Node / pnpm / git / shell を内包
  * 任意コマンド実行・ファイル書き換えを許可
  * 破壊前提のサンドボックス（read-only ルート / 実行後破棄）

## 1. WSL2 & Docker 環境の構築

### 1.1 WSL2 のインストール

管理者権限の PowerShell または コマンドプロンプトで実行：

```powershell
wsl --install
```

インストール完了後、**Windowsを必ず再起動**してください。

> [!TIP]
> 再起動せずに進むと「WSL2 は、現在のマシン構成ではサポートされていません。」等のエラーが出ることがあります。
> これは仮想化機能が反映されていないだけなので、まずは落ち着いて再起動してください。
> 手順をちゃんと守らないせっかちなホモは†悔い改めて†

再起動後、状態を確認：

```powershell
wsl --status
```

以下のように表示されれば OK です：

```
既定のバージョン: 2
WSL1 は、現在のマシン構成ではサポートされていません。
WSL1 を使用するには、"Linux 用 Windows サブシステム" オプション コンポーネントを有効にしてください。
```

### 1.2 Ubuntu のインストール

WSL2 上で使用する Linux ディストリビューションとして Ubuntu を導入します。

```powershell
wsl --install -d Ubuntu
```

初回起動時に：

* Linux ユーザー名
* パスワード

を設定してください。

以降の作業は **Ubuntu（WSL2）内のターミナル**で行います。

### 1.3 Docker Engine のインストール

本プロジェクトでは **WSL2 内に直接 Docker Engine をインストール**します。
（Docker Desktop は不要・非推奨）

Ubuntu ターミナルで以下を実行：

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg
```

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
```

```bash
echo \
  "deb [arch=$(dpkg --print-architecture) \
  signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

```bash
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io
```

### 1.4 Docker を sudo なしで使えるようにする

#### 1.4.1 Ubuntu 内

```bash
sudo usermod -aG docker $USER
exit   # ここでシェルを抜ける
```

#### 1.4.2 PowerShell / CMD 側

```powershell
wsl --shutdown
```

#### 1.4.3 Ubuntu を再起動

```powershell
wsl
```

#### 1.4.4 動作確認

```bash
docker ps
```

出力例：

```
CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES
```

WSL に Docker をインストールした直後は、
まだコンテナが存在しないため、この出力になるのが正しい挙動です。

エラーが出なければ、sudo なしで Docker コマンドを実行できています。

### 1.5 ネットワークについて（LM Studio との疎通）

最終的には **Windows → WSL → Docker コンテナ** の経路で LLM API に接続できる必要があります。

まずは切り分けとして、**WSL2 内部から Windows 側 LLM API への疎通**を確認します。

#### 1.5.1 Windows 側 LLM API の待ち受け確認（LM Studio）

LM Studio を使用している場合、
起動中の API Server 画面に **Reachable at:** として表示される URL を確認してください。

例：

```
Reachable at:
http://192.168.0.23:1234
```

この **IP アドレスが、WSL2 から到達可能な Windows 側の実体**です。

#### 1.5.2 疎通確認（WSL → Windows）

WSL2（Ubuntu）内で、**上で確認した IP アドレスを使って**疎通確認を行います。

```bash
curl http://192.168.0.23:1234
```

##### 判定

* JSON が返れば成功
  → **WSL2 → Windows の疎通は OK**
* 接続できない場合は以下を確認してください：

  * LM Studio が起動しているか
  * API Server が有効になっているか
  * ポート番号（例: `1234`）が一致しているか
  * Windows ファイアウォールでブロックされていないか

#### 1.5.3 次のステップ

この時点では：

* ✅ **WSL → Windows** の疎通のみ確認
* ❌ Docker コンテナからの疎通はまだ

Docker コンテナ → Windows の疎通確認は、
**後続の Docker 起動手順完了後**に行います。

> [!NOTE]
> `docker-compose.yml` は `extra_hosts: host.docker.internal:host-gateway` を設定済みのため、
> **Docker を動かしている Windows マシン自身**で LLM API が動いている場合に限り、
> IP 直指定ではなく `host.docker.internal` で到達できます
> （`.env` の `LLM_BASE_URL=http://host.docker.internal:1234/v1` を参照）。
>
> `host.docker.internal` は「Docker Engine のホストマシン」だけを指す特殊名であり、
> LAN 上の任意のアドレスに解決されるわけではありません。
> LLM や unj-reze が **別の LAN マシン**（例: `192.168.0.3`）で動いている場合は、
> `host.docker.internal` は使えないため、そのマシンの IP を `.env` に直接指定してください
> （コンテナは既定のブリッジネットワーク経由で LAN 上の他ホストへ普通に到達できます）。
>
> 上記の IP アドレスでの疎通確認は、あくまで「WSL → Windows」経路の切り分け用です。

### 1.6 プロジェクトのクローン

Ubuntu ターミナルで：

```bash
mkdir -p ~/workspace
cd ~/workspace
git clone https://github.com/onjmin/elves-shoemaker.git
cd elves-shoemaker
```

以降、**このディレクトリが作業ルート**になります。

## 2. 環境設定（.env）

Docker コンテナは **設定を保持しません**。
そのため `.env` は **ホスト（WSL2）側で作成・管理**します。

### 2.1 .env を作成

```bash
cp .env.example .env
```

### 2.2 nano で編集（WSL Ubuntu）

```bash
nano .env
```

操作方法:

* **切り取り**: `Ctrl + K`
* **貼り付け**: `Ctrl + U`
* **保存**: `Ctrl + O` → Enter
* **終了**: `Ctrl + X`

### 2.3 必要な値を設定

以下を `.env` に記入してください：

* LLM API URL（例：`http://192.168.0.23:1234/v1/chat/completions`）
* Discord webhook URL
* GitHub Token
* その他の環境変数

## 3. AI エージェント実行環境（Docker）

> [!NOTE]
> **WSL側で `pnpm install` を実行しないでください**  
> WSL側でインストールを行うと、**WSLの環境で実行される前提の `node_modules` が構築されてしまう**ため、Linuxコンテナ内での動作不良やバイナリ不整合の原因となります。  
> もし誤って実行した場合は、 `rm -rf node_modules` で削除してから進めてください。

本プロジェクトは **Docker Compose** で運用します（単体の `Dockerfile` は廃止し、ビルド定義は
`docker-compose.yml` に一本化しています）。

### 3.1 イメージのビルド

```bash
docker compose build
```

### 3.2 安全なコンテナ起動

このコマンドを実行するとコンテナが立ち上がり、起動直後は自動的に **コンテナ内部のシェル** に入ります。

```bash
docker compose run --rm agent
```

#### compose 側で設定済みの内容

`docker-compose.yml` に、以前 `docker run` の引数として渡していた設定をすべて定義済みです。

* **read_only: true**: ルートファイルシステム（`/`）を読み取り専用にし、OS破壊や永続的な改変を防止
* **cap_drop: [ALL]**: Linux カーネルの権限をすべて削除し、権限昇格や不正操作を防止
* **tmpfs**: pnpm や tsx が内部的にキャッシュや一時ファイルを書き込むため、やむを得ずマウント外の領域にも一時的な書き込み先を用意する
* **volumes: .:/app:rw**: ホストの作業ディレクトリを `/app` にマウント。ソースコードや成果物はホスト側に保持される
* **env_file: .env**: `.env` を自動で読み込む（`docker run -e` の手打ちが不要になった）
* **extra_hosts: host.docker.internal:host-gateway**: コンテナ内部から Windows 側（LM Studio 等）を含む
  LAN 上のアドレスへ到達するための設定。`.env` の `LLM_BASE_URL` は `http://host.docker.internal:1234/v1`
  のように指定する（`docker run --add-host=host.docker.internal:host-gateway` 相当）

> [!TIP]
> `docker compose run --rm agent` は `--rm` により終了時にコンテナを破棄しますが、
> `docker-compose.yml` 自体（イメージ定義）はそのまま残ります。再ビルドが必要なのは
> `docker-compose.yml` を編集したときだけです。

### 3.3 依存関係のインストール（初回のみ）

（※コンテナ内部のシェルで以下のコマンドを実行）

```bash
pnpm install
```

## 4. 疎通確認（Health Check）

小人を本格的に動かす前に、各パーツが正しく接続されているか確認しましょう。
以下のコマンドで、LLMや外部ツールへの接続テストを一括実行できます。

（※コンテナ内部のシェルで以下のコマンドを実行）

```bash
pnpm test:all
```

個別に確認したい場合は、以下のコマンドを利用してください：

* **ファイル操作**: `pnpm test:file`
* **シェル実行**: `pnpm test:shell`
* **LLM接続**: `pnpm test:llm`
* **Web取得**: `pnpm test:fetch`
* **Wikipedia**: `pnpm test:wikipedia`
* **Web検索 (Tavily)**: `pnpm test:search`
* **GitHub連携**: `pnpm test:github`
* **Discord疎通**: `pnpm test:discord`

## 5. 小人に仕事を頼む（GOAL.md）

小人はデスク（プロジェクトルート）に置かれた ``GOAL.md`` を見て、その日の仕事を理解します。
リポジトリにある **``GOAL.md`` を直接書き換えて**、以下の3つのセクションを記入してください。

> [!IMPORTANT]
> **英語での記述を強く推奨します（推奨理由：精度とリソース限界）**
> 1. **内部プロンプトとの整合性**: 小人の「脳（内部プロンプト）」はすべて英語で構成されています。指示も英語で統一することで、AIが文脈を正確に解釈でき、誤作動のリスクを最小限に抑えられます。
> 2. **トークン効率とリソース管理**: 日本語は英語に比べ、同じ意味を伝えるのにより多くのトークンを消費します。vRAM 16GB環境で大型モデル（12Bクラスなど）を動かす場合、日本語による長大なコンテキストは**メモリー不足（OOM）を引き起こし、システムを停止させる原因**になります。英語で記述することで、物理的な限界を守りつつ、より多くの情報をAIに渡すことができます。
>
> 以下の日本語例は、あくまで「3つのセクションに分ける」という構成を分かりやすく示すためのものです。

```markdown
挨拶スクリプトの作成（※実際は英語で記述してください）

---

srcディレクトリにhello.tsを作成してください。
"Hello, Elves!"という文字列を返す関数をエクスポートし、コンソールにも出力してください。

---

1. src/hello.tsが存在すること
2. 関数が正しい文字列を返すこと
3. 実行時に"Hello, Elves!"と出力されること
```

※ セパレーター（``---``）を消さないように注意してください。

## 6. 実行

準備ができたら、小人を呼び出しましょう。

（※コンテナ内部のシェルで以下のコマンドを実行）

```bash
pnpm start
```

小人は ``GOAL.md`` を読み込み、スタックにタスクを積み、一歩ずつ作業を開始します。
進捗はコンソール、および設定した Discord で確認できます。
