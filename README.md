# CF-B2 私有图床 (Cloudflare Workers + Backblaze B2)

基于 **Cloudflare Workers** 与 **Backblaze B2 对象存储（S3 兼容协议）** 的零外部依赖个人私有图床。

借助 Cloudflare 与 Backblaze 的 **Bandwidth Alliance（带宽联盟）**，Cloudflare 回源读取 Backblaze B2 **免收外网流量费**；配合 Worker 的 **AWS SigV4 私有桶签名代理 + Cloudflare Edge Cache 全球边缘缓存**，无需暴露源站桶地址，也无需担心刷量产生天价账单。

---

## 🌟 核心特性

- **纯网页图形化操作**：部署、配置、上传、相册管理全程可在浏览器 Web 界面完成，无需运行复杂命令行。
- **无需数据库**：直接利用 B2 S3 API 列举与管理相册，免去配置 D1 或 KV 数据库的繁琐步骤。
- **B2 私有桶安全回源**：存储桶保持完全 **Private（私有）**，由 Worker 签名代理读取并自动写入 Cloudflare 边缘缓存，图片删除时自动联动清理缓存。
- **现代化 Web 管理后台**：
  - 支持浅色 / 深色主题自适应切换
  - 支持拖拽多图上传、全局 `Ctrl+V` / `⌘+V` 截屏直接粘贴上传
  - 前端可选 **智能压缩与自动转 WebP**（智能跳过动态 GIF、动态 WebP 与 SVG）
  - 一键复制 **直链 URL / Markdown / HTML / BBCode**
  - 相册目录筛选、文件名搜索、Lightbox 大图全屏预览、多选批量复制与批量删除
- **客户端图形化一键接入**：
  - 后台直接提供 **PicGo 图形配置参数**，并支持一键下载 **ShareX `.sxcu` 配置文件**（双击即可自动导入）
- **安全防护**：
  - 恒定时间密码比对 + HttpOnly 会话 Cookie
  - 严格二进制文件头（Magic Bytes）检查，防御伪装可执行文件
  - SVG 图片强制沙箱 CSP，彻底阻断存储型 XSS
  - 可选 **Referer 防盗链域名白名单**（支持通配符子域名，命中边缘缓存时依然生效）

---

## 📖 纯图形端部署教程（全程网页操作）

---

### 第一步：Backblaze B2 网页控制台配置

#### 1. 创建私有存储桶
1. 访问并登录 [Backblaze B2 控制台](https://secure.backblaze.com/b2_buckets.htm)。
2. 在左侧菜单点击 **Buckets**，然后点击 **Create a Bucket** 按钮：
   - **Bucket Unique Name**：输入你的存储桶名称（全局唯一，例如 `my-private-img-2026`）。
   - **Files in Bucket are**：选择 **Private**（强烈推荐私有，禁止公网直接读取源站）。
   - 其余默认，点击 **Create a Bucket**。
3. 创建完成后，在存储桶列表中找到该桶，记录卡片上的 **Endpoint**（例如：`s3.us-west-004.backblazeb2.com`）。

![Backblaze Bucket](https://img.shields.io/badge/Backblaze-Bucket%20Private-orange?style=flat-square)

#### 2. 生成专用的 Application Key
1. 点击左侧菜单的 **Application Keys**，向下滑动找到并点击 **Add a New Application Key**：
   - **Name of Key**：输入便于识别的名称（如 `cf-img-worker`）。
   - **Allow access to Bucket(s)**：在下拉框中**仅选择刚才创建的存储桶**（遵循最小权限原则）。
   - **Type of Access**：勾选 **Read and Write**。
   - 其余选项保持默认，点击 **Create New Key**。
2. **⚠️ 重点注意**：页面会弹出带有绿色背景的密钥信息，请**立刻复制保存**以下两项（离开页面后将永久无法查看）：
   - `keyID`（对应后文的 `B2_KEY_ID`）
   - `applicationKey`（对应后文的 `B2_APPLICATION_KEY`）

---

### 第二步：Cloudflare 网页控制台部署与配置

你可以直接使用本 GitHub 仓库通过 Cloudflare Dashboard 导入部署：

#### 1. 在 Cloudflare 中导入 GitHub 仓库
1. 登录 [Cloudflare Dashboard 控制台](https://dash.cloudflare.com/)。
2. 在左侧导航栏点击 **Compute (Workers) -> Workers & Pages**。
3. 点击页面右上角的 **Create**（创建），选择 **Import from Git**（从 Git 导入）。
4. 连接你的 GitHub 账号，选择仓库 **`CFB2-Pic`**，点击 **Begin setup**。
5. 配置构建设置（Build Settings）：
   - **Project name**：自定义 Worker 名称（如 `cf-b2-images`）
   - **Production branch**：选择 `main`
   - **Build command**（构建命令）：留空（无需编译）
   - **Deploy command**（部署命令）：留空或保持默认
6. 点击 **Save and Deploy**（保存并部署）。

---

#### 2. 图形化添加环境变量与 Secrets（机密）
构建完成后，需要把 Backblaze B2 的密钥和你的后台访问密码填入 Worker：

1. 进入创建好的 Worker 详情页，点击顶部的 **Settings**（设置）标签页。
2. 点击左侧子菜单 **Variables and Secrets**（变量与机密）。
3. **添加机密（Secrets，加密存储）**：
   - 点击 **Add** 按钮，类型选择 **Secret**，依次添加以下 3 项：
     - 名称：`B2_KEY_ID` ➡️ 填入 Backblaze 的 `keyID`
     - 名称：`B2_APPLICATION_KEY` ➡️ 填入 Backblaze 的 `applicationKey`
     - 名称：`AUTH_TOKEN` ➡️ 填入你自定义的**后台登录密码 / API 访问密钥**（请设置一个高强度密码）
4. **添加环境变量（Variables，明文配置）**：
   - 点击 **Add** 按钮，类型选择 **Text**，依次添加：
     - 名称：`B2_BUCKET` ➡️ 填入你的 B2 存储桶名称（例如 `my-private-img-2026`）
     - 名称：`B2_ENDPOINT` ➡️ 填入你的 B2 Endpoint（例如 `s3.us-west-004.backblazeb2.com`）
     - （可选）`ALLOWED_REFERERS` ➡️ 防盗链白名单，如需防盗链可填 `yourblog.com, *.yourblog.com`；留空表示公开访问
5. 添加完成后点击 **Save and Deploy**（保存并重新部署），让配置立即生效。

部署后，实际生效的 B2 签名区域可在图床后台 **「客户端接入 & 状态」** 的 **Region** 一栏查看。

---

#### 3. 绑定自定义域名（强烈推荐）
绑定自定义域名可激活 Cloudflare 全球 CDN 边缘节点缓存，避免重复回源读取 B2：

1. 在当前 Worker 的 **Settings**（设置）页面中，点击左侧子菜单 **Domains & Routes**（域与路由）。
2. 在 **Custom Domains**（自定义域）区域点击 **Add** -> **Custom Domain**。
3. 输入你托管在 Cloudflare 上的二级域名（例如 `img.yourdomain.com`）。
4. 点击 **Add Custom Domain**，Cloudflare 会自动完成 DNS 解析记录的添加并申请 SSL 证书。
5. 稍等 1~2 分钟，即可通过 `https://img.yourdomain.com` 访问你的图床！

---

## 🖥️ Web 图床管理台使用说明

部署完成后，在浏览器打开你的图床域名，界面将呈现全图形化交互操作：

### 1. 登录解锁
- 首次打开将显示解锁卡片，输入你在环境变量中设置的 `AUTH_TOKEN` 即可解锁进入管理后台。
- 登录成功后会下发安全的 `HttpOnly` 会话 Cookie，免去频繁重复输入的麻烦。

### 2. 批量上传与智能处理
- **上传方式**：
  - 点击虚线框选择电脑中的图片
  - 直接把多张图片拖放进网页虚线框
  - 在截图工具截图后，直接在浏览器窗口内按下键盘快捷键 <kbd>Ctrl</kbd> + <kbd>V</kbd>（Mac 下为 <kbd>⌘</kbd> + <kbd>V</kbd>）即可直接上传剪贴板截图
- **压缩选项（可选）**：
  - **处理模式**：可在下拉框中切换【智能转 WebP】、【仅压缩体积】或【原图无损上传】。
  - **画质滑块**：可直观拖动 55% ~ 96% 调节压缩比。
  - **分辨率限制**：支持一键限制最长边不超过 1080p / 2K / 4K。
- **命名规则**：
  - 支持按【日期目录 + 随机短链】、【日期目录 + 原文件名】、【纯随机短链】或【原文件名】存放，亦可在输入框指定上传的子文件夹名称（如 `blog`）。
- **一键复制**：上传结果列表支持实时显示节省的文件体积百分比，并可一键切换与批量复制 **直链 URL**、**Markdown**、**HTML** 或 **BBCode**。

### 3. 相册管理
- 切换到 **「相册管理」** 标签页：
  - 顶部支持按文件夹下拉筛选、文件名关键词搜索。
  - 点击图片卡片可唤起 **Lightbox 大图全屏浏览**。
  - 支持勾选多张图片进行 **批量复制直链 / Markdown** 或 **批量从 B2 彻底删除**。
  - 删除图片时系统会自动向 Cloudflare 发出 Purge 请求，实时清理对应图片的边缘缓存。

---

## 📱 客户端接入图形化配置

进入后台顶部的 **「客户端接入 & 状态」** 标签页，所有配置参数均已根据当前域名自动生成，直接复制或下载即可：

### 1. ShareX（Windows 用户推荐，一键导入）
1. 在图床后台的 **「客户端接入 & 状态」** 页面中，找到 ShareX 卡片。
2. 在输入框填入你的 `AUTH_TOKEN`，点击 **「下载 ShareX 配置 (.sxcu)」** 按钮。
3. 双击下载的 `.sxcu` 文件，ShareX 会自动弹出提示并设为默认图片上传服务，无需手动填写任何参数！

### 2. PicGo 图形界面配置
1. 打开 PicGo 软件，进入 **插件设置**，搜索并安装 `web-uploader` 插件。
2. 进入 **图床设置 -> 自定义 Web 图床**，对照后台页面填入对应参数：
   - **API 地址**：`https://你的域名/api/upload`
   - **POST 参数名**：`file`
   - **JSON 路径**：`url`
   - **自定义请求头**：`{"X-API-Key":"你的AUTH_TOKEN"}`
3. 点击 **确定** 并设为默认图床，即可使用快捷键随处截图并自动上传。

---

## ⚙️ 环境变量速查表

| 变量名 | 类型 | 是否必填 | 网页端配置说明 |
| :--- | :---: | :---: | :--- |
| `B2_KEY_ID` | Secret | **是** | Backblaze Application Key 的 `keyID` |
| `B2_APPLICATION_KEY` | Secret | **是** | Backblaze Application Key 的 `applicationKey` |
| `AUTH_TOKEN` | Secret | **是** | Web 管理员登录密码 & 第三方客户端上传 API Key |
| `B2_BUCKET` | Text (Var) | **是** | 你的 Backblaze B2 存储桶名称 |
| `B2_ENDPOINT` | Text (Var) | **是** | 从 Backblaze 控制台复制的 S3 Endpoint（如 `s3.us-west-004.backblazeb2.com`），Worker 从官方域名自动解析签名区域 |
| `PUBLIC_BASE_URL` | Text (Var) | 否 | 自定义外链域名（如 `https://img.example.com`），留空自动使用当前访问域名 |
| `PATH_STRATEGY` | Text (Var) | 否 | 默认文件命名策略：`date-random` / `date-original` / `flat-random` / `original` |
| `MAX_FILE_SIZE_MB` | Text (Var) | 否 | 单图最大限制（MB，默认 `25`） |
| `CACHE_TTL_SECONDS` | Text (Var) | 否 | 边缘缓存时长（秒，默认 `31536000` 即 1 年） |
| `ALLOWED_REFERERS` | Text (Var) | 否 | 防盗链白名单，如 `example.com, *.myblog.org`（留空则关闭防盗链） |
| `ALLOW_EMPTY_REFERER` | Text (Var) | 否 | 是否允许无 Referer 直接打开图片（默认 `true`） |

使用自定义 S3 Endpoint 时，可在部署配置中设置 `B2_REGION` 作为签名区域。该变量留空时使用 `us-west-004`。

---

## 💻 开发者本地开发与测试（仅供二次开发使用）

如果你需要修改代码或在本地调试：

```powershell
# 1. 安装开发依赖
npm.cmd install

# 2. 复制本地环境变量文件并填入密钥
Copy-Item .dev.vars.example .dev.vars

# 3. 运行本地开发服务器
npm.cmd run dev

# 4. 运行完整单元与端到端测试（含 AWS SigV4 官方向量校验）
npm.cmd test
```
