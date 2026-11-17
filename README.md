# CF-B2 私有图床 (Cloudflare Workers + Backblaze B2)

基于 **Cloudflare Workers** 与 **Backblaze B2 对象存储（S3 兼容接口）** 的零外部依赖个人私有图床。

借助 Cloudflare 与 Backblaze 的 **Bandwidth Alliance（带宽联盟）**，Cloudflare 回源读取 Backblaze B2 **免收流量出站费**；配合 Worker 的 **AWS SigV4 私有桶签名代理 + Cloudflare Edge Cache**，无需暴露真实 B2 存储桶名称和地址，也不会因外部刷流量产生天价账单。

---

## 核心特性

- **零数据库、零第三方运行时依赖**：基于 Web Crypto 原生实现 AWS Signature V4，直接利用 B2 S3 `ListObjectsV2` 列举与管理相册，无需绑定 KV 或 D1。
- **B2 私有桶签名读取 + Cloudflare 边缘缓存加速**：存储桶可保持完全 **Private（私有）**，由 Worker 签名回源并写入 `caches.default` 边缘缓存，支持 `ETag` / `304 Not Modified`，删除图片时自动清理边缘缓存。
- **现代化 Web 管理台**：
  - 支持深色/浅色主题、拖拽多图上传、全局 `Ctrl+V` / `⌘+V` 剪贴板截图粘贴上传
  - **前端可选智能压缩 / 自动转 WebP**（自动识别并保留 GIF 动图、动态 WebP 与 SVG 矢量图）
  - 一键切换与批量复制 **直链 URL / Markdown / HTML / BBCode**
  - 相册搜索、按目录筛选、Lightbox 大图预览、批量复制与批量删除
- **全生态客户端兼容**：
  - 开箱兼容 **PicGo (`web-uploader`)**、**ShareX（网页内可直接一键下载 `.sxcu` 配置文件）**、**uPic** 及 **cURL / Base64 API**
- **安全加固**：
  - 恒定时间（Timing-Safe）API Key 校验 + 无状态 HMAC `HttpOnly` 会话 Cookie
  - 二进制文件头（Magic Bytes）校验，拦截伪装成图片的可执行文件
  - SVG 图片自动附加 `Content-Security-Policy: ... sandbox`，彻底防御存储型 XSS
  - 可选 **Referer 防盗链白名单**（支持 `*.example.com` 通配符子域名，且命中边缘缓存时依然生效）

---

## 第一步：准备 Backblaze B2 存储桶与密钥

1. 登录 [Backblaze B2 Cloud Storage](https://www.backblaze.com/b2/cloud-storage.html)，进入 **Buckets -> Create a Bucket**：
   - **Bucket Unique Name**：填写桶名（如 `my-private-imgbed`）
   - **Files in Bucket are**：强烈推荐选择 **Private（私有）**
   - 创建后，在桶卡片上记录 **Endpoint**（形如 `s3.us-west-004.backblazeb2.com`）
2. 进入左侧 **Application Keys -> Add a New Application Key**：
   - **Name of Key**：如 `cf-worker-imgbed`
   - **Allow access to Bucket(s)**：仅勾选刚才创建的存储桶（最小权限原则）
   - **Type of Access**：选择 **Read and Write**
   - 创建后**立即保存**弹出的 `keyID`（对应 `B2_KEY_ID`）与 `applicationKey`（对应 `B2_APPLICATION_KEY`，仅显示一次）

---

## 第二步：配置与部署到 Cloudflare Workers

### 1. 修改 `wrangler.toml` 基础配置

打开项目根目录的 [wrangler.toml](./wrangler.toml)，填入你的桶名称与 Endpoint：

```toml
[vars]
B2_BUCKET = "你的B2存储桶名称"
B2_ENDPOINT = "s3.us-west-004.backblazeb2.com"
```

### 2. 本地调试（可选）

1. 安装开发依赖：
   ```bash
   npm install
   ```
2. 将 `.dev.vars.example` 复制为 `.dev.vars` 并填入密钥：
   ```ini
   B2_KEY_ID=004xxxxxxxxxxxxxxxxxxxxxx
   B2_APPLICATION_KEY=K004xxxxxxxxxxxxxxxxxxxxxxxxxxx
   AUTH_TOKEN=设置一个高强度的管理员密码或API_Key
   B2_BUCKET=你的B2存储桶名称
   B2_ENDPOINT=s3.us-west-004.backblazeb2.com
   ```
3. 启动本地开发服务器：
   ```bash
   npm run dev
   ```

### 3. 部署上线并写入加密 Secrets

```bash
# 首次运行会引导浏览器登录 Cloudflare 账号
npx wrangler deploy

# 将敏感密钥安全写入 Cloudflare Worker Secrets（密文存储）
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APPLICATION_KEY
npx wrangler secret put AUTH_TOKEN
```

> **提示**：你也可以直接将本项目推送至 GitHub，在 Cloudflare Dashboard -> **Workers & Pages -> Create -> Connect to Git** 中导入仓库，并在 Worker 的 **Settings -> Variables and Secrets** 页面添加 `B2_KEY_ID`、`B2_APPLICATION_KEY`、`AUTH_TOKEN` 三个 Secret。

### 4. 绑定自定义域名（强烈推荐）

在 Cloudflare Worker 详情页进入 **Settings -> Domains & Routes -> Add -> Custom Domain**，绑定托管在 Cloudflare 下的子域名（如 `img.yourdomain.com`）：
- 自定义域名可完整激活 Cloudflare 全球 CDN 节点的 `caches.default` 边缘缓存，大幅减少 B2 回源请求次数（Class B Transactions）。

---

## 环境变量说明

| 变量名 | 必填 | 类型 | 说明 |
| :--- | :---: | :---: | :--- |
| `B2_KEY_ID` | 是 | Secret | Backblaze B2 Application Key ID |
| `B2_APPLICATION_KEY` | 是 | Secret | Backblaze B2 Application Key |
| `AUTH_TOKEN` | 是 | Secret | Web 后台登录密码 & 第三方客户端上传 API Key |
| `B2_BUCKET` | 是 | Var | B2 存储桶名称 |
| `B2_ENDPOINT` | 是 | Var | B2 S3 Endpoint（如 `s3.us-west-004.backblazeb2.com`） |
| `B2_REGION` | 否 | Var | 留空会自动从 `B2_ENDPOINT` 提取（如 `us-west-004`） |
| `PUBLIC_BASE_URL` | 否 | Var | 自定义返回外链前缀（如 `https://img.example.com`），留空自动使用当前访问域名 |
| `UPLOAD_PREFIX` | 否 | Var | 桶内全局目录前缀（如 `blog`） |
| `PATH_STRATEGY` | 否 | Var | 默认命名策略：`date-random`（默认）\| `date-original` \| `flat-random` \| `original` |
| `MAX_FILE_SIZE_MB` | 否 | Var | 单张图片大小上限（MB，默认 `25`） |
| `CACHE_TTL_SECONDS` | 否 | Var | 边缘与浏览器缓存秒数（默认 `31536000` 即 1 年） |
| `ALLOWED_REFERERS` | 否 | Var | 防盗链白名单，逗号分隔（如 `example.com, *.mysite.org`）；留空则不开启防盗链 |
| `ALLOW_EMPTY_REFERER` | 否 | Var | 开启防盗链时是否允许无 Referer 直接访问（默认 `"true"`，设为 `"false"` 则禁止直接打开） |

---

## API 与第三方工具接入

登录 Web 界面后，点击顶部 **「客户端接入 & 状态」** 标签页即可直接复制为你当前域名预填好的 **PicGo 参数** 或一键下载 **ShareX `.sxcu` 配置文件**。

### 上传接口：`POST /api/upload`（别名 `POST /upload`）

支持以下任一鉴权方式：
- 请求头 `X-API-Key: <AUTH_TOKEN>`
- 请求头 `Authorization: Bearer <AUTH_TOKEN>`
- URL 参数 `?key=<AUTH_TOKEN>`

```bash
# Multipart 表单上传（字段名支持 file / image / smfile）
curl -X POST "https://img.example.com/api/upload" \
  -H "X-API-Key: YOUR_AUTH_TOKEN" \
  -F "file=@./photo.webp" \
  -F "folder=blog" \
  -F "naming=date-random"

# 二进制直传
curl -X POST "https://img.example.com/api/upload?filename=shot.png" \
  -H "X-API-Key: YOUR_AUTH_TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @./shot.png
```

返回 JSON 示例：

```json
{
  "success": true,
  "key": "blog/2026/11/18/8xk2p9m4q1.webp",
  "url": "https://img.example.com/i/blog/2026/11/18/8xk2p9m4q1.webp",
  "name": "photo.webp",
  "size": 84210,
  "type": "image/webp",
  "links": {
    "direct": "https://img.example.com/i/blog/2026/11/18/8xk2p9m4q1.webp",
    "markdown": "![photo.webp](https://img.example.com/i/blog/2026/11/18/8xk2p9m4q1.webp)",
    "html": "<img src=\"https://img.example.com/i/blog/2026/11/18/8xk2p9m4q1.webp\" alt=\"photo.webp\" />",
    "bbcode": "[img]https://img.example.com/i/blog/2026/11/18/8xk2p9m4q1.webp[/img]"
  },
  "data": {
    "url": "https://img.example.com/i/blog/2026/11/18/8xk2p9m4q1.webp",
    "key": "blog/2026/11/18/8xk2p9m4q1.webp"
  }
}
```

---

## 运行单元测试

本项目包含完整的 AWS SigV4 官方测试向量校验、XML 解析、防盗链及边缘缓存集成测试（使用 Node.js 内置测试运行器）：

```bash
npm test
```
