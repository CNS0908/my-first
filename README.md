# MindStarMap - Obsidian AI 智能整理插件

MindStarMap 是一个为 Obsidian 设计的 AI 智能笔记整理与语义连接插件。

## 功能特性

### 1. AI 整理当前笔记
- 自动分析笔记内容
- 智能重命名笔记
- 在 frontmatter 中添加标签
- 自动插入摘要区块

### 2. 全局关系扫描
- 扫描库中所有 Markdown 笔记
- 批量分析笔记间的语义关系
- 自动在笔记末尾插入内部链接

### 3. 侧边栏关联面板
- 显示当前笔记的所有关联
- 点击关联可直接跳转

### 4. 多 AI 供应商支持
- DeepSeek
- OpenAI 兼容接口
- Ollama（本地）
- 讯飞星火

## 安装方法

### 手动安装
1. 将整个 `mindstarmap-plugin` 文件夹复制到 `.obsidian/plugins/` 目录
2. 在 Obsidian 中启用插件

### 开发安装
```bash
cd mindstarmap-plugin
npm install
npm run build
```

## 使用方法

### 命令
- `MindStarMap: AI 整理当前笔记`
- `MindStarMap: 全局关系扫描`
- `MindStarMap: 打开关联面板`
- `MindStarMap: 刷新当前笔记关联`

## 许可证

MIT License