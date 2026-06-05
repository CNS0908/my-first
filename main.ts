import { App, Plugin, PluginSettingTab, Setting, Notice, ItemView, WorkspaceLeaf, TFile, TFolder, requestUrl, MarkdownView, Menu } from 'obsidian';

const VIEW_TYPE_MINDSTARMAP = 'mindstarmap-view';

interface MindStarMapSettings {
    provider: 'deepseek' | 'openai' | 'ollama' | 'xinghuo';
    apiKey: string;
    endpointUrl: string;
    modelName: string;
    appId: string;
    apiSecret: string;
    temperature: number;
    maxTokens: number;
    autoScanOnStartup: boolean;
    autoOrganizeOnStartup: boolean;
    autoOrganizeOnCreate: boolean;
    autoOrganizeOnModify: boolean;
    autoRelationScanAfterOrganize: boolean;
    batchSize: number;
    excludeFolders: string[];
    insertSummary: boolean;
    pluginInitialized: boolean;
    maxRelationsPerNote: number;
    enableWebSearch: boolean;
    maxGeneratedNotesPerNote: number;
}

const DEFAULT_SETTINGS: MindStarMapSettings = {
    provider: 'deepseek',
    apiKey: '',
    endpointUrl: '',
    modelName: '',
    appId: '',
    apiSecret: '',
    temperature: 0.7,
    maxTokens: 2000,
    autoScanOnStartup: false,
    autoOrganizeOnStartup: false,
    autoOrganizeOnCreate: false,
    autoOrganizeOnModify: false,
    autoRelationScanAfterOrganize: false,
    batchSize: 5,
    excludeFolders: [],
    insertSummary: false,
    pluginInitialized: false,
    maxRelationsPerNote: 99999,
    enableWebSearch: false,
    maxGeneratedNotesPerNote: 3,
}

interface AIResponse {
    tags: string[];
}

interface RelationResponse {
    source: string;
    target: string;
    type: string;
    commonGround: string;
}

interface NoteRelation {
    notePath: string;
    noteTitle: string;
    relationType: string;
    commonGround: string;
}

interface SearchResult {
    title: string;
    snippet: string;
    url: string;
    source: string;
}

interface GeneratedNote {
    title: string;
    content: string;
    tags: string[];
    references: SearchResult[];
}

export default class MindStarMapPlugin extends Plugin {
    settings: MindStarMapSettings;
    
    // ============ 防循环相关状态标志 ============
    // 全局防重入锁：防止并发分析
    isAnalyzing: boolean = false;
    // 忽略列表：插件即将修改的文件路径，修改后自动清理
    ignoreNextModify: Set<string> = new Set();
    // 分析计数器：记录短时间内笔记被分析的次数，用于熔断
    analysisCount: Map<string, { count: number; lastTime: number }> = new Map();
    // 熔断时间窗口（毫秒）
    FUSE_WINDOW_MS = 30000; // 30秒内
    // 熔断阈值
    FUSE_THRESHOLD = 3;
    
    // 启动标志：确保启动时的初始扫描只执行一次
    hasPerformedInitialScan: boolean = false;
    
    // ============ 防抖相关 ============
    // 防抖计时器映射：文件路径 -> 计时器ID
    debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    // 防抖延迟时间（毫秒）
    DEBOUNCE_DELAY_MS = 2000; // 2秒

    async onload() {
        await this.loadSettings();

        this.registerView(VIEW_TYPE_MINDSTARMAP, (leaf: WorkspaceLeaf) => new MindStarMapView(leaf, this));

        this.addRibbonIcon('dice', 'MindStarMap', () => {
            new Notice('MindStarMap 已启动！使用命令面板执行 AI 功能。');
        });

        this.addCommand({
            id: 'ai-organize-current-note',
            name: 'AI 整理当前笔记',
            callback: () => this.aiOrganizeCurrentNote()
        });

        this.addCommand({
            id: 'global-relation-scan',
            name: '全局关系扫描',
            callback: () => this.globalRelationScan()
        });

        this.addCommand({
            id: 'full-initialization',
            name: '执行完整初始化',
            callback: () => this.performFullInitialization()
        });

        this.addCommand({
            id: 'open-mindstarmap-view',
            name: '打开关联面板',
            callback: () => this.activateView()
        });

        this.addCommand({
            id: 'refresh-current-relations',
            name: '刷新当前笔记关联',
            callback: () => this.refreshCurrentNoteRelations()
        });

        this.addCommand({
            id: 'generate-related-notes',
            name: 'AI 生成关联笔记',
            callback: () => this.generateRelatedNotesForCurrent()
        });

        this.addSettingTab(new MindStarMapSettingTab(this.app, this));

        this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
            if (file instanceof TFile) {
                if (file.extension === 'md') {
                    menu.addItem((item) => {
                        item.setTitle('AI 重新整理笔记')
                            .setIcon('sparkles')
                            .onClick(() => {
                                this.aiOrganizeNote(file);
                            });
                    });

                    menu.addItem((item) => {
                        item.setTitle('AI 重新建立关系')
                            .setIcon('link-2')
                            .onClick(() => {
                                this.refreshNoteRelations(file);
                            });
                    });

                    menu.addItem((item) => {
                        item.setTitle('AI 生成关联笔记')
                            .setIcon('globe')
                            .onClick(() => {
                                this.generateRelatedNotes(file);
                            });
                    });
                }
            } else if (file instanceof TFolder) {
                menu.addItem((item) => {
                    item.setTitle('AI 批量整理文件夹')
                        .setIcon('sparkles')
                        .onClick(() => {
                            this.batchOrganizeFolder(file);
                        });
                });

                menu.addItem((item) => {
                    item.setTitle('AI 批量建立关系')
                        .setIcon('link-2')
                        .onClick(() => {
                            this.batchScanFolderRelations(file);
                        });
                });
            }
        }));

        this.registerEvent(
            this.app.vault.on('create', (file) => {
                if (this.settings.autoOrganizeOnCreate && file instanceof TFile && file.extension === 'md') {
                    // 使用防抖机制，2秒后执行分析
                    this.scheduleAnalysis(file);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (this.settings.autoOrganizeOnModify && file instanceof TFile && file.extension === 'md') {
                    // ============ 防循环：检查是否为插件自身修改 ============
                    if (this.ignoreNextModify.has(file.path)) {
                        console.log(`[MindStarMap] 跳过插件自身修改的文件: ${file.path}`);
                        this.ignoreNextModify.delete(file.path);
                        return;
                    }
                    // 使用防抖机制，2秒后执行分析（用户停止编辑后才触发）
                    this.scheduleAnalysis(file);
                }
            })
        );

        if (!this.settings.pluginInitialized) {
            this.settings.pluginInitialized = true;
            await this.saveSettings();
            new Notice('MindStarMap 首次启动，开始完整初始化...');
            setTimeout(() => {
                this.performFullInitialization();
            }, 2000);
        } else if (this.settings.autoOrganizeOnStartup && !this.hasPerformedInitialScan) {
            this.hasPerformedInitialScan = true;
            new Notice('MindStarMap 启动，开始自动初始化...');
            setTimeout(() => {
                this.performFullInitialization();
            }, 2000);
        }
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_MINDSTARMAP);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async performFullInitialization() {
        // ============ 防循环检查：全局防重入锁 ============
        if (this.isAnalyzing) {
            new Notice('MindStarMap: 正在执行初始化，请稍候...');
            return;
        }

        // ============ 设置全局防重入锁 ============
        this.isAnalyzing = true;
        new Notice('MindStarMap: 开始完整初始化流程...');

        try {
            await this.batchOrganizeAllNotes();
            
            if (this.settings.autoRelationScanAfterOrganize) {
                new Notice('MindStarMap: 所有笔记分析完成，开始关系扫描...');
                await this.globalRelationScan(true); // 传入 isNested: true
            }
            
            new Notice('MindStarMap: 完整初始化流程完成！');
        } catch (error) {
            console.error('初始化流程失败:', error);
            new Notice('MindStarMap: 初始化流程发生错误，请检查控制台');
        } finally {
            // ============ 释放全局防重入锁 ============
            this.isAnalyzing = false;
        }
    }

    async batchOrganizeAllNotes() {
        const files = this.app.vault.getMarkdownFiles();
        const filteredFiles = files.filter(f => {
            const path = f.path;
            return !this.settings.excludeFolders.some(folder => path.startsWith(folder));
        });

        const total = filteredFiles.length;
        new Notice(`MindStarMap: 共 ${total} 篇笔记待分析...`);

        const batchSize = this.settings.batchSize;
        let processedCount = 0;
        let successCount = 0;

        for (let i = 0; i < filteredFiles.length; i += batchSize) {
            const batch = filteredFiles.slice(i, i + batchSize);
            const promises = batch.map(async (file) => {
                try {
                    await this.aiOrganizeNote(file, false);
                    return true;
                } catch (error) {
                    console.error(`分析笔记 ${file.path} 失败:`, error);
                    return false;
                }
            });

            const results = await Promise.all(promises);
            successCount += results.filter(r => r).length;
            processedCount += batch.length;

            const progress = Math.round((processedCount / total) * 100);
            new Notice(`MindStarMap: 分析进度 ${processedCount}/${total} (${progress}%)`);
        }

        new Notice(`MindStarMap: 笔记分析完成，成功 ${successCount}/${total} 篇`);
    }

    async batchOrganizeFolder(folder: any) {
        const folderPath = folder.path;
        const files = this.app.vault.getMarkdownFiles().filter(f => 
            f.path.startsWith(folderPath) && 
            !this.settings.excludeFolders.some(exclude => f.path.startsWith(exclude))
        );

        const total = files.length;
        if (total === 0) {
            new Notice('MindStarMap: 文件夹中没有笔记');
            return;
        }

        new Notice(`MindStarMap: 共 ${total} 篇笔记待分析...`);

        const batchSize = this.settings.batchSize;
        let processedCount = 0;
        let successCount = 0;

        for (let i = 0; i < files.length; i += batchSize) {
            const batch = files.slice(i, i + batchSize);
            const promises = batch.map(async (file) => {
                try {
                    await this.aiOrganizeNote(file, false);
                    return true;
                } catch (error) {
                    console.error(`分析笔记 ${file.path} 失败:`, error);
                    return false;
                }
            });

            const results = await Promise.all(promises);
            successCount += results.filter(r => r).length;
            processedCount += batch.length;

            const progress = Math.round((processedCount / total) * 100);
            new Notice(`MindStarMap: 分析进度 ${processedCount}/${total} (${progress}%)`);
        }

        new Notice(`MindStarMap: 笔记分析完成，成功 ${successCount}/${total} 篇`);
    }

    async refreshNoteRelations(file: TFile) {
        new Notice(`MindStarMap: 正在为 ${file.basename} 重新建立关系...`);
        
        try {
            const content = await this.app.vault.read(file);
            
            const files = this.app.vault.getMarkdownFiles().filter(f => 
                f.path !== file.path && 
                !this.settings.excludeFolders.some(folder => f.path.startsWith(folder))
            );

            // 获取源笔记标签
            const sourceCache = this.app.metadataCache.getFileCache(file);
            const sourceTags = sourceCache?.frontmatter?.tags || [];
            const sourceTagsArray = Array.isArray(sourceTags) ? sourceTags : (sourceTags ? [sourceTags] : []);

            const relations: NoteRelation[] = [];

            for (const targetFile of files.slice(0, 20)) {
                const targetContent = await this.app.vault.read(targetFile);
                
                // 获取目标笔记标签
                const targetCache = this.app.metadataCache.getFileCache(targetFile);
                const targetTags = targetCache?.frontmatter?.tags || [];
                const targetTagsArray = Array.isArray(targetTags) ? targetTags : (targetTags ? [targetTags] : []);

                try {
                    const result = await this.analyzeRelation(
                        file.path,
                        file.basename,
                        content.substring(0, 500),
                        sourceTagsArray,
                        targetFile.path,
                        targetFile.basename,
                        targetContent.substring(0, 500),
                        targetTagsArray
                    );

                    if (result && result.length > 0) {
                        relations.push({
                            notePath: targetFile.path,
                            noteTitle: targetFile.basename,
                            relationType: result[0].type,
                            commonGround: result[0].commonGround
                        });
                    }
                } catch (error) {
                    console.error('关系分析失败:', error);
                }
            }

            const newContent = this.updateRelationsSection(content, relations);
            await this.app.vault.modify(file, newContent);

            new Notice(`MindStarMap: ${file.basename} 关系更新完成！`);
        } catch (error) {
            console.error('关系更新失败:', error);
            new Notice('MindStarMap: 关系更新失败');
        }
    }

    async batchScanFolderRelations(folder: any) {
        const folderPath = folder.path;
        const files = this.app.vault.getMarkdownFiles().filter(f => 
            f.path.startsWith(folderPath) && 
            !this.settings.excludeFolders.some(exclude => f.path.startsWith(exclude))
        );

        const total = files.length;
        if (total === 0) {
            new Notice('MindStarMap: 文件夹中没有笔记');
            return;
        }

        new Notice(`MindStarMap: 正在为 ${total} 篇笔记建立关系...`);

        const noteContents: Map<string, string> = new Map();
        const noteTitles: Map<string, string> = new Map();
        const noteTags: Map<string, string[]> = new Map();  // 新增：存储标签

        for (const file of files) {
            const content = await this.app.vault.read(file);
            noteContents.set(file.path, content.substring(0, 500));
            noteTitles.set(file.path, file.basename);
            
            // 获取笔记标签
            const cache = this.app.metadataCache.getFileCache(file);
            const tags = cache?.frontmatter?.tags || [];
            const tagsArray = Array.isArray(tags) ? tags : (tags ? [tags] : []);
            noteTags.set(file.path, tagsArray);
        }

        const allRelations: RelationResponse[] = [];
        const batchSize = 3;
        let processedCount = 0;

        for (let i = 0; i < files.length; i += batchSize) {
            const batch = files.slice(i, i + batchSize);
            
            for (const sourceFile of batch) {
                for (const targetFile of files) {
                    if (sourceFile.path === targetFile.path) continue;

                    const sourceContent = noteContents.get(sourceFile.path) || '';
                    const targetContent = noteContents.get(targetFile.path) || '';
                    const sourceTags = noteTags.get(sourceFile.path) || [];
                    const targetTags = noteTags.get(targetFile.path) || [];

                    try {
                        const relations = await this.analyzeRelation(
                            sourceFile.path,
                            noteTitles.get(sourceFile.path) || '',
                            sourceContent,
                            sourceTags,
                            targetFile.path,
                            noteTitles.get(targetFile.path) || '',
                            targetContent,
                            targetTags
                        );

                        if (relations) {
                            allRelations.push(...relations);
                        }
                    } catch (error) {
                        console.error('关系分析失败:', error);
                    }

                    processedCount++;
                    if (processedCount % 10 === 0) {
                        new Notice(`MindStarMap: 关系分析进度 ${processedCount}`);
                    }
                }
            }
        }

        await this.applyRelations(allRelations, noteTitles);
        new Notice('MindStarMap: 文件夹关系建立完成！');
    }

    // ============ 防抖调度方法 ============
    // 用户停止编辑并保存后，经过防抖延迟才触发分析
    scheduleAnalysis(file: TFile) {
        const filePath = file.path;
        
        // 如果存在之前的计时器，清除它（重置防抖）
        const existingTimer = this.debounceTimers.get(filePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        
        // 创建新的计时器
        const newTimer = setTimeout(async () => {
            // 计时器到期，执行分析
            await this.handleNoteCreateOrModify(file);
            // 执行完成后移除计时器记录
            this.debounceTimers.delete(filePath);
        }, this.DEBOUNCE_DELAY_MS);
        
        // 保存计时器引用
        this.debounceTimers.set(filePath, newTimer);
        console.log(`[MindStarMap] 已调度分析: ${file.basename}（${this.DEBOUNCE_DELAY_MS}ms 后执行）`);
    }

    // ============ 新笔记单次对比（一对一分析）===========
    // 当用户创建或修改笔记时触发，与库中其他笔记逐一对比
    async handleNoteCreateOrModify(file: TFile) {
        // ============ 防循环检查：全局防重入锁 ============
        if (this.isAnalyzing) {
            console.log(`[MindStarMap] 跳过分析（已有分析正在进行）: ${file.path}`);
            return;
        }

        try {
            const content = await this.app.vault.read(file);
            if (!content.trim()) {
                return;
            }

            // ============ 防循环检查：跳过自动生成的笔记 ============
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache?.frontmatter?.['auto-generated-related']) {
                console.log(`[MindStarMap] 跳过自动生成的笔记: ${file.path}`);
                return;
            }

            // ============ 防循环检查：熔断机制 ============
            const now = Date.now();
            const existingRecord = this.analysisCount.get(file.path);
            
            if (existingRecord) {
                if (now - existingRecord.lastTime < this.FUSE_WINDOW_MS) {
                    existingRecord.count++;
                    if (existingRecord.count > this.FUSE_THRESHOLD) {
                        console.log(`[MindStarMap] 熔断触发：笔记在短时间内被分析超过 ${this.FUSE_THRESHOLD} 次: ${file.path}`);
                        new Notice(`MindStarMap: 检测到频繁分析，已跳过 "${file.basename}"，请检查内容或手动分析`);
                        return;
                    }
                } else {
                    existingRecord.count = 1;
                }
                existingRecord.lastTime = now;
            } else {
                this.analysisCount.set(file.path, { count: 1, lastTime: now });
            }

            // ============ 设置全局防重入锁 ============
            this.isAnalyzing = true;

            try {
                new Notice(`MindStarMap: 分析笔记: ${file.basename}`);

                // 步骤1: AI分析笔记，提取关键词标签
                await this.aiOrganizeNote(file, false);

                // 步骤2: 与现有笔记建立关联（如果启用）
                if (this.settings.autoRelationScanAfterOrganize) {
                    await this.analyzeAndLinkNote(file, content);
                }

                new Notice(`MindStarMap: 笔记分析完成: ${file.basename}`);
            } finally {
                // ============ 释放全局防重入锁 ============
                this.isAnalyzing = false;
            }
        } catch (error) {
            console.error('自动分析笔记失败:', error);
            this.isAnalyzing = false;
        }
    }

    // ============ 新笔记与已有笔记的一对一关联分析 ============
    // 将新笔记与库中所有其他笔记逐一对比，必须同时满足标签重合和语义关联才能建立链接
    async analyzeAndLinkNote(sourceFile: TFile, sourceContent: string) {
        const files = this.app.vault.getMarkdownFiles();
        const filteredFiles = files.filter(f => {
            const path = f.path;
            return f.path !== sourceFile.path && 
                   !this.settings.excludeFolders.some(folder => path.startsWith(folder));
        });

        // 如果没有其他笔记，直接退出
        if (filteredFiles.length === 0) {
            return;
        }

        const sourceTitle = sourceFile.basename.replace('.md', '');
        const noteTitles: Map<string, string> = new Map();
        
        // 收集所有笔记的标签信息
        const noteTags: Map<string, string[]> = new Map();
        
        for (const file of filteredFiles) {
            noteTitles.set(file.path, file.basename.replace('.md', ''));
            
            // 获取笔记标签
            const cache = this.app.metadataCache.getFileCache(file);
            const tags = cache?.frontmatter?.tags || [];
            const tagsArray = Array.isArray(tags) ? tags : (tags ? [tags] : []);
            noteTags.set(file.path, tagsArray);
        }

        // 获取源笔记的标签
        const sourceCache = this.app.metadataCache.getFileCache(sourceFile);
        const sourceTags = sourceCache?.frontmatter?.tags || [];
        const sourceTagsArray = Array.isArray(sourceTags) ? sourceTags : (sourceTags ? [sourceTags] : []);

        const relations: RelationResponse[] = [];

        // 遍历所有已有笔记，逐一对比
        for (const targetFile of filteredFiles) {
            const targetContent = await this.app.vault.read(targetFile);
            const targetTitle = noteTitles.get(targetFile.path) || '';
            const targetTags = noteTags.get(targetFile.path) || [];

            // ============ 条件1：检查标签重合度 ============
            // 查找相同或高度近似的标签
            const commonTags = sourceTagsArray.filter(tag => 
                targetTags.some(targetTag => 
                    tag.toLowerCase() === targetTag.toLowerCase() ||
                    targetTag.toLowerCase().includes(tag.toLowerCase()) ||
                    tag.toLowerCase().includes(targetTag.toLowerCase())
                )
            );

            // 如果没有标签重合，跳过该笔记对（不建立关联）
            if (commonTags.length === 0) {
                console.log(`[MindStarMap] 跳过 "${sourceTitle}" 与 "${targetTitle}"：无标签重合`);
                continue;
            }

            // ============ 条件2：调用 AI 判断语义关联 ============
            try {
                const result = await this.analyzeRelation(
                    sourceFile.path,
                    sourceTitle,
                    sourceContent.substring(0, 500),
                    sourceTagsArray,  // 传入源笔记标签
                    targetFile.path,
                    targetTitle,
                    targetContent.substring(0, 500),
                    targetTags       // 传入目标笔记标签
                );

                if (result && result.length > 0) {
                    relations.push(...result);
                }
            } catch (error) {
                console.error('分析关系失败:', error);
            }
        }

        // 如果没有找到任何符合条件的联系，直接退出，不做任何修改
        if (relations.length === 0) {
            console.log(`[MindStarMap] 新笔记 "${sourceTitle}" 未找到符合条件的关联（标签+语义双重匹配）`);
            return;
        }

        // 有符合条件的联系，建立关联
        await this.applyRelations(relations, noteTitles);
        console.log(`[MindStarMap] 为 "${sourceTitle}" 建立了 ${relations.length} 条关联（均满足标签+语义双重条件）`);
    }

    async aiOrganizeNote(file: TFile, showNotice: boolean = true) {
        if (showNotice) {
            new Notice(`MindStarMap: 正在分析 ${file.basename}...`);
        }

        try {
            const content = await this.app.vault.read(file);
            const aiResponse = await this.callAIForOrganization(content);

            if (!aiResponse) {
                if (showNotice) {
                    new Notice(`MindStarMap: AI 分析 ${file.basename} 失败`);
                }
                return;
            }

            await this.applyAIResponse(file, content, aiResponse);
            
            if (showNotice) {
                new Notice(`MindStarMap: ${file.basename} 整理完成！`);
            }
        } catch (error) {
            console.error(`分析笔记 ${file.path} 失败:`, error);
            if (showNotice) {
                new Notice(`MindStarMap: 分析 ${file.basename} 时发生错误`);
            }
        }
    }

    async activateView() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_MINDSTARMAP);

        await this.app.workspace.getRightLeaf(false).setViewState({
            type: VIEW_TYPE_MINDSTARMAP,
            active: true,
        });

        this.app.workspace.revealLeaf(this.app.workspace.getLeavesOfType(VIEW_TYPE_MINDSTARMAP)[0]);
    }

    async aiOrganizeCurrentNote() {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) {
            new Notice('请先打开一个笔记');
            return;
        }

        const file = activeView.file;
        if (!file) {
            new Notice('无法获取当前文件');
            return;
        }

        await this.aiOrganizeNote(file);
    }

    async callAIForOrganization(content: string): Promise<AIResponse | null> {
        // 优化后的标签提取提示词
        // 要求模型严格依据笔记文本的语义主题和文中明确出现的特征词生成标签
        const prompt = `请从以下笔记内容中提取 3-5 个最核心的关键词作为标签。
        
要求：
1. 标签必须直接反映文本的语义主题；
2. 标签必须是文中出现过的特征词或紧密同义词；
3. 禁止添加文中未提及的泛化概念或推测性标签；
4. 标签数量限制在 3-5 个，避免过度标注；
5. 返回格式为 JSON，示例：{"tags": ["标签1", "标签2", "标签3"]}

笔记内容：
${content.substring(0, 2000)}

请只返回 JSON，不要添加其他内容。`;

        try {
            const response = await this.makeAIRequest(prompt);
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0]) as AIResponse;
                // 确保标签数量在 3-5 个之间
                const filteredTags = (result.tags || []).slice(0, 5);
                return { tags: filteredTags };
            }
            return null;
        } catch (error) {
            console.error('AI request failed:', error);
            return null;
        }
    }

    async applyAIResponse(file: TFile, content: string, response: AIResponse) {
        let newContent = content;
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;

        const tagsToAdd = response.tags || [];
        if (tagsToAdd.length > 0) {
            if (frontmatter) {
                const existingTags = frontmatter.tags || [];
                const mergedTags = [...new Set([...existingTags, ...tagsToAdd])];
                newContent = this.updateFrontmatterTags(newContent, mergedTags);
            } else {
                newContent = this.addFrontmatter(newContent, { tags: tagsToAdd });
            }
        }

        if (newContent !== content) {
            // ============ 防循环：在修改文件前将文件路径加入忽略列表 ============
            this.ignoreNextModify.add(file.path);
            await this.app.vault.modify(file, newContent);
        }
    }

    async generateRelatedNotesForCurrent() {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView || !activeView.file) {
            new Notice('请先打开一个笔记');
            return;
        }
        await this.generateRelatedNotes(activeView.file);
    }

    async generateRelatedNotes(file: TFile) {
        if (!this.settings.enableWebSearch) {
            new Notice('MindStarMap: 请先在设置中启用 AI 联网搜索功能');
            return;
        }

        if (this.settings.provider !== 'deepseek') {
            new Notice('MindStarMap: 仅 DeepSeek 支持联网搜索功能');
            return;
        }

        if (!this.settings.apiKey) {
            new Notice('MindStarMap: 请先配置 DeepSeek API Key');
            return;
        }

        new Notice(`MindStarMap: 正在为 ${file.basename} 生成关联笔记...`);

        try {
            const content = await this.app.vault.read(file);
            const title = file.basename.replace('.md', '');
            
            const existingGeneratedNotes = this.getGeneratedNotesForFile(file);
            if (existingGeneratedNotes >= this.settings.maxGeneratedNotesPerNote) {
                new Notice(`MindStarMap: 已达到最大生成笔记数（${this.settings.maxGeneratedNotesPerNote}）`);
                return;
            }

            // 使用 DeepSeek 联网搜索获取相关信息
            const prompt = `请搜索与 "${title}" 相关的权威信息，包括最新资讯、学术资料、技术文档等。请返回结构化的搜索结果，包含标题、摘要和来源链接。`;
            const searchResponse = await this.makeAIRequest(prompt, true);
            
            // 解析 DeepSeek 返回的搜索结果
            const searchResults = this.parseDeepSeekSearchResults(searchResponse);
            if (!searchResults || searchResults.length === 0) {
                new Notice('MindStarMap: 未找到相关搜索结果');
                return;
            }

            const numToGenerate = this.settings.maxGeneratedNotesPerNote - existingGeneratedNotes;
            for (let i = 0; i < Math.min(numToGenerate, searchResults.length); i++) {
                const result = searchResults[i];
                await this.createRelatedNote(file, result, i + 1);
            }

            new Notice(`MindStarMap: 成功生成 ${Math.min(numToGenerate, searchResults.length)} 篇关联笔记！`);
        } catch (error) {
            console.error('生成关联笔记失败:', error);
            new Notice('MindStarMap: 生成关联笔记时发生错误');
        }
    }

    parseDeepSeekSearchResults(response: string): SearchResult[] {
        const results: SearchResult[] = [];
        try {
            // DeepSeek 返回的搜索结果通常包含在响应内容中，尝试解析
            // 搜索结果格式可能为 JSON 或文本描述，这里尝试提取链接和摘要
            const urlRegex = /https?:\/\/[^\s\)]+/g;
            const urls = response.match(urlRegex) || [];
            
            // 提取标题和摘要
            const lines = response.split('\n');
            let currentTitle = '';
            let currentSnippet = '';
            
            for (const line of lines) {
                if (line.match(/^[\d\*\-]+\s*[^\s]/)) {
                    // 可能是一个新的搜索结果条目
                    if (currentTitle) {
                        results.push({
                            title: currentTitle.trim(),
                            snippet: currentSnippet.trim(),
                            url: urls.shift() || '',
                            source: urls[urls.length - 1] || ''
                        });
                    }
                    currentTitle = line.replace(/^[\d\*\-]+\s*/, '');
                    currentSnippet = '';
                } else if (currentTitle) {
                    currentSnippet += line + ' ';
                }
            }
            
            // 添加最后一个结果
            if (currentTitle) {
                results.push({
                    title: currentTitle.trim(),
                    snippet: currentSnippet.trim(),
                    url: urls.shift() || '',
                    source: urls[urls.length - 1] || ''
                });
            }
        } catch (error) {
            console.error('解析搜索结果失败:', error);
        }
        
        // 过滤有效结果
        return results.filter(r => r.title && r.url);
    }

    async createRelatedNote(sourceFile: TFile, searchResult: SearchResult, index: number) {
        const sourceTitle = sourceFile.basename.replace('.md', '');
        const newTitle = `${sourceTitle}-关联${index}`;
        
        const existingFile = this.app.vault.getAbstractFileByPath(`${sourceFile.parent?.path || ''}/${newTitle}.md`);
        if (existingFile) {
            return;
        }

        const frontmatter = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
        const sourceTags = frontmatter?.tags || [];
        const newTags = [...new Set([...sourceTags, 'AI生成', '关联拓展'])];

        const content = await this.generateNoteContent(searchResult);
        
        const frontmatterContent = `---
title: "${searchResult.title}"
tags: [${newTags.map(t => `"${t}"`).join(', ')}]
generatedFrom: "${sourceTitle}"
---

## 概述

${content}

## 关联

- [[${sourceTitle}|相关拓展]]

## 参考资料

- [${searchResult.title}](${searchResult.url})
`;

        const filePath = `${sourceFile.parent?.path || ''}/${newTitle}.md`;
        await this.app.vault.create(filePath, frontmatterContent);

        await this.addRelationToNote(sourceFile, newTitle, '相关拓展');
    }

    async generateNoteContent(searchResult: SearchResult): Promise<string> {
        const prompt = `基于以下搜索结果，撰写一篇详细的笔记内容：

搜索结果标题：${searchResult.title}
搜索结果摘要：${searchResult.snippet}
来源链接：${searchResult.url}

请撰写一篇完整的笔记内容，包括：
1. 主题概述
2. 核心要点
3. 关键信息

要求：
- 内容必须基于搜索结果，不要虚构信息
- 使用 Markdown 格式
- 语言清晰、结构合理
- 篇幅适中（200-500字）

请只返回笔记内容，不要添加其他内容。`;

        try {
            const response = await this.makeAIRequest(prompt);
            return response.trim();
        } catch (error) {
            return searchResult.snippet;
        }
    }

    async addRelationToNote(file: TFile, targetTitle: string, relationType: string) {
        const content = await this.app.vault.read(file);
        const relations: NoteRelation[] = [{
            notePath: targetTitle,
            noteTitle: targetTitle,
            relationType,
            commonGround: ''
        }];
        
        const newContent = this.updateRelationsSection(content, relations);
        await this.app.vault.modify(file, newContent);
    }

    updateFrontmatterTags(content: string, tags: string[]): string {
        const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
        const match = content.match(frontmatterRegex);

        if (match) {
            let frontmatter = match[1];
            const tagsLine = `tags: [${tags.map(t => `"${t}"`).join(', ')}]`;

            if (frontmatter.includes('tags:')) {
                frontmatter = frontmatter.replace(/tags:\s*\[[\s\S]*?\]/, tagsLine);
                frontmatter = frontmatter.replace(/tags:\s*\n\s*-[\s\S]*?(?=\n[^-\s]|\n---|$)/, tagsLine);
            } else {
                frontmatter = frontmatter + `\n${tagsLine}`;
            }

            return content.replace(frontmatterRegex, `---\n${frontmatter}\n---`);
        }

        return this.addFrontmatter(content, { tags });
    }

    addFrontmatter(content: string, data: Record<string, any>): string {
        const frontmatter = Object.entries(data)
            .map(([key, value]) => {
                if (Array.isArray(value)) {
                    return `${key}: [${value.map(v => `"${v}"`).join(', ')}]`;
                }
                return `${key}: "${value}"`;
            })
            .join('\n');

        return `---\n${frontmatter}\n---\n\n${content}`;
    }

    // ============ 全局关联分析（仅标签匹配）===========
    // 当用户点击"全局关联分析"按钮时触发，仅根据相同标签建立关联
    async globalRelationScan(isNested: boolean = false) {
        // ============ 防循环检查：全局防重入锁 ============
        if (this.isAnalyzing && !isNested) {
            new Notice('MindStarMap: 正在执行扫描，请稍候...');
            return;
        }

        // 如果是独立调用，设置全局防重入锁
        if (!isNested) {
            this.isAnalyzing = true;
        }
        new Notice('MindStarMap: 开始全局标签关联分析...');

        try {
            const files = this.app.vault.getMarkdownFiles();
            const filteredFiles = files.filter(f => {
                const path = f.path;
                return !this.settings.excludeFolders.some(folder => path.startsWith(folder));
            });

            // 收集每篇笔记的标签信息
            const noteTags: Map<string, string[]> = new Map();  // path -> tags[]
            const noteTitles: Map<string, string> = new Map();  // path -> title

            for (const file of filteredFiles) {
                const cache = this.app.metadataCache.getFileCache(file);
                const tags = cache?.frontmatter?.tags || [];
                // 确保 tags 是数组
                const tagsArray = Array.isArray(tags) ? tags : (tags ? [tags] : []);
                noteTags.set(file.path, tagsArray);
                noteTitles.set(file.path, file.basename.replace('.md', ''));
            }

            const allRelations: RelationResponse[] = [];
            const processedPairs = new Set<string>();  // 避免重复处理同一对

            // 遍历所有笔记对，仅当有相同标签时建立关联
            for (let i = 0; i < filteredFiles.length; i++) {
                for (let j = i + 1; j < filteredFiles.length; j++) {
                    const sourceFile = filteredFiles[i];
                    const targetFile = filteredFiles[j];

                    // 生成唯一标识，避免重复处理
                    const pairKey = [sourceFile.path, targetFile.path].sort().join('||');
                    if (processedPairs.has(pairKey)) {
                        continue;
                    }
                    processedPairs.add(pairKey);

                    const sourceTags = noteTags.get(sourceFile.path) || [];
                    const targetTags = noteTags.get(targetFile.path) || [];

                    // 找到共同标签
                    const commonTags = sourceTags.filter(tag => targetTags.includes(tag));

                    if (commonTags.length > 0) {
                        // 仅当有相同标签时建立关联
                        const relationType = `标签关联`;
                        const commonGround = `共同标签: ${commonTags.join(', ')}`;

                        allRelations.push({
                            source: sourceFile.path,
                            target: targetFile.path,
                            type: relationType,
                            commonGround: commonGround
                        });

                        // 双向关联
                        allRelations.push({
                            source: targetFile.path,
                            target: sourceFile.path,
                            type: relationType,
                            commonGround: commonGround
                        });
                    }
                    // 如果没有相同标签，不建立任何关联，直接跳过
                }
            }

            if (allRelations.length > 0) {
                await this.applyRelations(allRelations, noteTitles);
                new Notice(`MindStarMap: 全局标签关联分析完成！共建立 ${allRelations.length / 2} 对关联`);
            } else {
                new Notice('MindStarMap: 全局标签关联分析完成！未找到有共同标签的笔记对');
            }
        } catch (error) {
            console.error('全局标签关联分析失败:', error);
            new Notice('MindStarMap: 全局标签关联分析发生错误');
        } finally {
            // 如果是独立调用，释放锁；如果是嵌套调用，由外层释放
            if (!isNested) {
                this.isAnalyzing = false;
            }
        }
    }

    // ============ 语义关系分析方法 ============
    // 分析两篇笔记之间是否存在语义关联，返回 { hasRelation: boolean, type?: string, commonGround?: string }
    async analyzeRelation(
        sourcePath: string,
        sourceTitle: string,
        sourceContent: string,
        sourceTags: string[],        // 新增：源笔记标签
        targetPath: string,
        targetTitle: string,
        targetContent: string,
        targetTags: string[]         // 新增：目标笔记标签
    ): Promise<RelationResponse[] | null> {
        // 找出共同标签用于提示词
        const commonTags = sourceTags.filter(tag => 
            targetTags.some(t => t.toLowerCase() === tag.toLowerCase())
        );

        const prompt = `分析以下两个笔记内容是否存在语义关联。

笔记1: ${sourceTitle}
标签: ${sourceTags.join(', ') || '无'}
内容片段:
${sourceContent.substring(0, 300)}

笔记2: ${targetTitle}
标签: ${targetTags.join(', ') || '无'}
内容片段:
${targetContent.substring(0, 300)}

共同标签: ${commonTags.join(', ') || '无'}

请判断：
1. 两篇笔记是否存在明确的语义关联？（如补充、相反、因果、示例、主题延续等）
2. 如果存在关联，请明确说明关系类型和共同关注点。

返回格式为 JSON：
{
    "hasRelation": true/false,
    "type": "关系类型（如：补充|相反|因果|示例|相似|对比|主题延续）",
    "commonGround": "共同关注点或关联理由（简短描述）"
}

注意：
- 只有当存在明确的语义联系时，hasRelation 才为 true
- 如果内容无关或关联很弱，hasRelation 应为 false
- 仅当 hasRelation 为 true 时，type 和 commonGround 字段才需要填写
- 请严格按照 JSON 格式返回，不要添加其他内容`;

        try {
            const response = await this.makeAIRequest(prompt);
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0]);
                
                // 仅当 hasRelation 为 true 时才返回关联
                if (result.hasRelation) {
                    return [{
                        source: sourcePath,
                        target: targetPath,
                        type: result.type || '关联',
                        commonGround: result.commonGround || '语义关联'
                    }];
                } else {
                    console.log(`[MindStarMap] AI 判定 "${sourceTitle}" 与 "${targetTitle}" 无语义关联`);
                    return [];
                }
            }
            return null;
        } catch (error) {
            console.error('分析关系失败:', error);
            return null;
        }
    }

    async applyRelations(relations: RelationResponse[], noteTitles: Map<string, string>) {
        const relationMap: Map<string, NoteRelation[]> = new Map();
        const maxRelations = this.settings.maxRelationsPerNote || 5;

        for (const relation of relations) {
            const sourceRelations = relationMap.get(relation.source) || [];
            if (sourceRelations.length < maxRelations) {
                sourceRelations.push({
                    notePath: relation.target,
                    noteTitle: noteTitles.get(relation.target) || relation.target,
                    relationType: relation.type,
                    commonGround: relation.commonGround
                });
                relationMap.set(relation.source, sourceRelations);
            }

            const targetRelations = relationMap.get(relation.target) || [];
            if (targetRelations.length < maxRelations) {
                targetRelations.push({
                    notePath: relation.source,
                    noteTitle: noteTitles.get(relation.source) || relation.source,
                    relationType: relation.type,
                    commonGround: relation.commonGround
                });
                relationMap.set(relation.target, targetRelations);
            }
        }

        for (const [notePath, noteRelations] of relationMap) {
            const file = this.app.vault.getAbstractFileByPath(notePath);
            if (file instanceof TFile) {
                try {
                    const content = await this.app.vault.read(file);
                    const newContent = this.updateRelationsSection(content, noteRelations);
                    
                    // ============ 防循环：在修改文件前将文件路径加入忽略列表 ============
                    this.ignoreNextModify.add(notePath);
                    await this.app.vault.modify(file, newContent);
                } catch (error) {
                    console.error('Failed to update file:', error);
                }
            }
        }
    }

    updateRelationsSection(content: string, relations: NoteRelation[]): string {
        const relationsSectionRegex = /## 关联\n([\s\S]*?)(?=\n##|\n---|$)/;
        const maxRelations = this.settings.maxRelationsPerNote || 5;

        const filteredRelations = relations.slice(0, maxRelations);

        const links = filteredRelations
            .map(r => `- [[${r.noteTitle}|${r.relationType}]]`)
            .join('\n');

        if (relationsSectionRegex.test(content)) {
            return content.replace(
                relationsSectionRegex,
                `## 关联\n${links}\n`
            );
        } else {
            return content + `\n\n## 关联\n${links}\n`;
        }
    }

    async refreshCurrentNoteRelations() {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView || !activeView.file) {
            new Notice('请先打开一个笔记');
            return;
        }

        new Notice('正在刷新关联...');

        const file = activeView.file;
        const content = await this.app.vault.read(file);

        // 获取源笔记标签
        const sourceCache = this.app.metadataCache.getFileCache(file);
        const sourceTags = sourceCache?.frontmatter?.tags || [];
        const sourceTagsArray = Array.isArray(sourceTags) ? sourceTags : (sourceTags ? [sourceTags] : []);

        const files = this.app.vault.getMarkdownFiles();
        const filteredFiles = files.filter(f => {
            const path = f.path;
            return !this.settings.excludeFolders.some(folder => path.startsWith(folder)) && f.path !== file.path;
        });

        const relations: NoteRelation[] = [];

        for (const targetFile of filteredFiles.slice(0, 10)) {
            const targetContent = await this.app.vault.read(targetFile);
            
            // 获取目标笔记标签
            const targetCache = this.app.metadataCache.getFileCache(targetFile);
            const targetTags = targetCache?.frontmatter?.tags || [];
            const targetTagsArray = Array.isArray(targetTags) ? targetTags : (targetTags ? [targetTags] : []);

            try {
                const result = await this.analyzeRelation(
                    file.path,
                    file.basename,
                    content.substring(0, 500),
                    sourceTagsArray,
                    targetFile.path,
                    targetFile.basename,
                    targetContent.substring(0, 500),
                    targetTagsArray
                );

                if (result && result.length > 0) {
                    relations.push({
                        notePath: targetFile.path,
                        noteTitle: targetFile.basename,
                        relationType: result[0].type,
                        commonGround: result[0].commonGround
                    });
                }
            } catch (error) {
                console.error('Analysis failed:', error);
            }
        }

        const newContent = this.updateRelationsSection(content, relations);
        await this.app.vault.modify(file, newContent);

        new Notice('关联刷新完成！');

        this.activateView();
    }

    async makeAIRequest(prompt: string, enableSearch: boolean = false): Promise<string> {
        const { provider, apiKey, endpointUrl, modelName, temperature, maxTokens } = this.settings;

        let url = '';
        let headers: Record<string, string> = {};
        let body: any = {};

        switch (provider) {
            case 'deepseek':
                let deepseekBaseUrl = endpointUrl || 'https://api.deepseek.com';
                if (!deepseekBaseUrl.endsWith('/v1/chat/completions')) {
                    url = `${deepseekBaseUrl}/v1/chat/completions`;
                } else {
                    url = deepseekBaseUrl;
                }
                headers = {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                };
                body = {
                    model: modelName || 'deepseek-v4-flash',
                    messages: [{ role: 'user', content: prompt }],
                    temperature,
                    max_tokens: maxTokens
                };
                // 启用 DeepSeek 联网搜索（search: true 参数）
                if (enableSearch) {
                    body.search = true;
                }
                break;

            case 'openai':
                let baseUrl = endpointUrl || 'https://api.openai.com';
                if (!baseUrl.endsWith('/v1/chat/completions')) {
                    url = `${baseUrl}/v1/chat/completions`;
                } else {
                    url = baseUrl;
                }
                headers = {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                };
                body = {
                    model: modelName || 'gpt-3.5-turbo',
                    messages: [{ role: 'user', content: prompt }],
                    temperature,
                    max_tokens: maxTokens
                };
                break;

            case 'ollama':
                url = endpointUrl || 'http://localhost:11434/api/generate';
                headers = { 'Content-Type': 'application/json' };
                body = {
                    model: modelName || 'llama2',
                    prompt,
                    stream: false
                };
                break;

            case 'xinghuo':
                url = endpointUrl || 'https://spark-api-open.xf-yun.com/v1/chat/completions';
                headers = {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                };
                body = {
                    model: modelName || 'generalv3.5',
                    messages: [{ role: 'user', content: prompt }],
                    temperature,
                    max_tokens: maxTokens
                };
                break;
        }

        try {
            const response = await requestUrl({
                url,
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            if (provider === 'ollama') {
                return response.json.response;
            }

            return response.json.choices[0].message.content;
        } catch (error: any) {
            console.error(`MindStarMap AI Request Error:`);
            console.error(`Provider: ${provider}`);
            console.error(`URL: ${url}`);
            console.error(`Error:`, error);
            
            if (error.message) {
                console.error(`Error Message: ${error.message}`);
            }
            if (error.body) {
                console.error(`Response Body: ${error.body}`);
            }
            
            throw error;
        }
    }

    async testConnection(): Promise<{ success: boolean; error?: string }> {
        try {
            console.log('MindStarMap: Testing connection...');
            console.log('Provider:', this.settings.provider);
            console.log('Endpoint:', this.settings.endpointUrl || 'default');
            console.log('Model:', this.settings.modelName || 'default');
            
            const response = await this.makeAIRequest('Hello, respond with "OK"');
            const success = response.includes('OK') || response.length > 0;
            
            console.log('MindStarMap: Connection test result:', success);
            console.log('Response:', response);
            
            return { success };
        } catch (error: any) {
            console.error('MindStarMap Connection Test Failed:', error);
            
            let errorMessage = '连接失败';
            if (error.message) {
                errorMessage = error.message;
            } else if (error.status) {
                errorMessage = `HTTP ${error.status}: ${error.statusText || '未知错误'}`;
            }
            
            return { success: false, error: errorMessage };
        }
    }

    getCurrentNoteRelations(): NoteRelation[] {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView || !activeView.file) return [];

        const file = activeView.file;
        return this.extractRelationsSection(file);
    }

    extractRelationsSection(file: TFile): NoteRelation[] {
        const content = this.app.vault.cachedRead(file);
        const relationsSectionRegex = /## 关联\n([\s\S]*?)(?=\n##|\n---|$)/;
        const match = content.match(relationsSectionRegex);

        if (!match) return [];

        const relations: NoteRelation[] = [];
        const lines = match[1].split('\n');

        for (const line of lines) {
            const linkMatch = line.match(/\[\[([^\]]+)\]\]/);
            if (linkMatch) {
                const parts = linkMatch[1].split('|');
                const noteTitle = parts[0];
                const relationInfo = parts[1] || '';

                const typeMatch = relationInfo.match(/关系：([^\(]+)/);
                const commonGroundMatch = relationInfo.match(/\(([^\)]+)\)/);

                relations.push({
                    notePath: noteTitle,
                    noteTitle,
                    relationType: typeMatch ? typeMatch[1].trim() : 'related',
                    commonGround: commonGroundMatch ? commonGroundMatch[1].trim() : ''
                });
            }
        }

        return relations;
    }
}

class MindStarMapView extends ItemView {
    plugin: MindStarMapPlugin;

    constructor(leaf: WorkspaceLeaf, plugin: MindStarMapPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return VIEW_TYPE_MINDSTARMAP;
    }

    getDisplayText(): string {
        return 'MindStarMap 关联';
    }

    getIcon(): string {
        return 'dice';
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('mindstarmap-view');

        this.renderView();
    }

    async onClose() {
        this.containerEl.children[1].empty();
    }

    renderView() {
        const container = this.containerEl.children[1];
        container.empty();

        const header = container.createDiv({ cls: 'mindstarmap-header' });
        header.createEl('h3', { text: '关联想法' });
        header.createEl('button', { cls: 'mindstarmap-refresh-btn', text: '刷新' })
            .addEventListener('click', () => {
                this.plugin.refreshCurrentNoteRelations();
            });

        const relations = this.plugin.getCurrentNoteRelations();

        if (relations.length === 0) {
            const emptyState = container.createDiv({ cls: 'mindstarmap-empty' });
            emptyState.createEl('p', { text: '暂无关联' });
            emptyState.createEl('p', { cls: 'hint', text: '执行"全局关系扫描"或"刷新当前笔记关联"来发现关联' });
            return;
        }

        const list = container.createDiv({ cls: 'mindstarmap-list' });

        for (const relation of relations) {
            const item = list.createDiv({ cls: 'mindstarmap-item' });

            const titleEl = item.createEl('a', { cls: 'mindstarmap-title', text: relation.noteTitle });
            titleEl.addEventListener('click', () => {
                this.app.workspace.openLinkText(relation.noteTitle, '', false);
            });

            const metaEl = item.createDiv({ cls: 'mindstarmap-meta' });
            metaEl.createEl('span', { cls: 'mindstarmap-type', text: relation.relationType });
            if (relation.commonGround) {
                metaEl.createEl('span', { cls: 'mindstarmap-common', text: `(${relation.commonGround})` });
            }
        }
    }
}

class MindStarMapSettingTab extends PluginSettingTab {
    plugin: MindStarMapPlugin;

    constructor(app: App, plugin: MindStarMapPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'MindStarMap 设置' });

        new Setting(containerEl)
            .setName('AI 供应商')
            .setDesc('选择 AI 服务供应商')
            .addDropdown(dropdown => dropdown
                .addOption('deepseek', 'DeepSeek')
                .addOption('openai', 'OpenAI 兼容')
                .addOption('ollama', 'Ollama (本地)')
                .addOption('xinghuo', '讯飞星火')
                .setValue(this.plugin.settings.provider)
                .onChange(async (value: 'deepseek' | 'openai' | 'ollama' | 'xinghuo') => {
                    this.plugin.settings.provider = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        if (this.plugin.settings.provider === 'xinghuo') {
            new Setting(containerEl)
                .setName('APP ID')
                .addText(text => text
                    .setPlaceholder('输入 APP ID')
                    .setValue(this.plugin.settings.appId)
                    .onChange(async (value) => {
                        this.plugin.settings.appId = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('API Secret')
                .addText(text => text
                    .setPlaceholder('输入 API Secret')
                    .setValue(this.plugin.settings.apiSecret)
                    .onChange(async (value) => {
                        this.plugin.settings.apiSecret = value;
                        await this.plugin.saveSettings();
                    }));
        }

        new Setting(containerEl)
            .setName('API Key')
            .setDesc('输入 API Key')
            .addText(text => {
                text.setPlaceholder('输入 API Key')
                    .setValue(this.plugin.settings.apiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.apiKey = value;
                        await this.plugin.saveSettings();
                    });
                text.inputEl.style.width = '100%';
            });

        if (this.plugin.settings.provider !== 'ollama') {
            new Setting(containerEl)
                .setName('Endpoint URL')
                .setDesc('自定义 API 端点（可选）')
                .addText(text => {
                    text.setPlaceholder('https://api.example.com/v1/chat/completions')
                        .setValue(this.plugin.settings.endpointUrl)
                        .onChange(async (value) => {
                            this.plugin.settings.endpointUrl = value;
                            await this.plugin.saveSettings();
                        });
                    text.inputEl.style.width = '100%';
                });
        } else {
            new Setting(containerEl)
                .setName('Ollama 地址')
                .setDesc('本地 Ollama 服务地址')
                .addText(text => {
                    text.setPlaceholder('http://localhost:11434')
                        .setValue(this.plugin.settings.endpointUrl)
                        .onChange(async (value) => {
                            this.plugin.settings.endpointUrl = value;
                            await this.plugin.saveSettings();
                        });
                    text.inputEl.style.width = '100%';
                });
        }

        new Setting(containerEl)
            .setName('模型名称')
            .setDesc('指定使用的模型')
            .addText(text => {
                text.setPlaceholder('deepseek-chat / gpt-3.5-turbo / llama2')
                    .setValue(this.plugin.settings.modelName)
                    .onChange(async (value) => {
                        this.plugin.settings.modelName = value;
                        await this.plugin.saveSettings();
                    });
                text.inputEl.style.width = '100%';
            });

        new Setting(containerEl)
            .setName('Temperature')
            .setDesc(`当前值: ${this.plugin.settings.temperature}`)
            .addSlider(slider => slider
                .setLimits(0, 1, 0.1)
                .setValue(this.plugin.settings.temperature)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.temperature = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(containerEl)
            .setName('Max Tokens')
            .setDesc(`当前值: ${this.plugin.settings.maxTokens}`)
            .addSlider(slider => slider
                .setLimits(256, 4096, 128)
                .setValue(this.plugin.settings.maxTokens)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxTokens = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(containerEl)
            .setName('测试连接')
            .setDesc('验证 API 配置是否正确')
            .addButton(button => button
                .setButtonText('测试连接')
                .onClick(async () => {
                    button.setButtonText('测试中...');
                    button.setDisabled(true);

                    const result = await this.plugin.testConnection();

                    button.setButtonText('测试连接');
                    button.setDisabled(false);

                    if (result.success) {
                        new Notice('连接成功！');
                    } else {
                        const errorMsg = result.error || '连接失败，请检查配置';
                        new Notice(`连接失败: ${errorMsg}`, 5000);
                    }
                }));

        containerEl.createEl('h3', { text: '关联设置' });

        new Setting(containerEl)
            .setName('每笔记最大关联数')
            .setDesc(`当前值: ${this.plugin.settings.maxRelationsPerNote}（范围：1-99999）`)
            .addSlider(slider => slider
                .setLimits(1, 99999, 1)
                .setValue(this.plugin.settings.maxRelationsPerNote)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxRelationsPerNote = value;
                    await this.plugin.saveSettings();
                    this.display();
                }))
            .addText(text => text
                .setPlaceholder('输入数字')
                .setValue(this.plugin.settings.maxRelationsPerNote.toString())
                .onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num >= 1 && num <= 99999) {
                        this.plugin.settings.maxRelationsPerNote = num;
                        await this.plugin.saveSettings();
                        this.display();
                    } else {
                        text.setValue(this.plugin.settings.maxRelationsPerNote.toString());
                    }
                })
                .inputEl.style.width = '80px');

        containerEl.createEl('h3', { text: 'AI 联网搜索设置' });

        if (this.plugin.settings.provider === 'deepseek') {
            containerEl.createEl('div', {
                text: '✅ 已启用联网搜索（通过 DeepSeek API 获取实时网络信息）',
                cls: 'setting-item-description'
            });
        }

        new Setting(containerEl)
            .setName('启用 AI 联网创建关联笔记')
            .setDesc('启用后，AI 将通过互联网搜索生成关联笔记')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableWebSearch)
                .onChange(async (value) => {
                    this.plugin.settings.enableWebSearch = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(containerEl)
            .setName('每篇笔记最大生成笔记数')
            .setDesc(`当前值: ${this.plugin.settings.maxGeneratedNotesPerNote}（范围：1-10）`)
            .addSlider(slider => slider
                .setLimits(1, 10, 1)
                .setValue(this.plugin.settings.maxGeneratedNotesPerNote)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxGeneratedNotesPerNote = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        containerEl.createEl('h3', { text: '自动处理设置' });

        new Setting(containerEl)
            .setName('首次启动时执行完整初始化')
            .setDesc('插件首次启动时自动分析所有笔记并建立关系')
            .addToggle(toggle => toggle
                .setValue(true)
                .setDisabled(true)
                .onChange(async () => {}));

        new Setting(containerEl)
            .setName('启动时自动初始化')
            .setDesc('Obsidian 启动时自动执行完整初始化流程（分析笔记 + 关系扫描）')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoOrganizeOnStartup)
                .onChange(async (value) => {
                    this.plugin.settings.autoOrganizeOnStartup = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('创建笔记时自动分析')
            .setDesc('创建新笔记时自动调用 AI 分析内容')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoOrganizeOnCreate)
                .onChange(async (value) => {
                    this.plugin.settings.autoOrganizeOnCreate = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('修改笔记时自动分析')
            .setDesc('修改笔记内容后自动重新调用 AI 分析')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoOrganizeOnModify)
                .onChange(async (value) => {
                    this.plugin.settings.autoOrganizeOnModify = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('分析后自动建立关系')
            .setDesc('批量分析笔记完成后自动执行全局关系扫描')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoRelationScanAfterOrganize)
                .onChange(async (value) => {
                    this.plugin.settings.autoRelationScanAfterOrganize = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: '扫描设置' });

        new Setting(containerEl)
            .setName('全局关联分析')
            .setDesc('重新扫描所有笔记，建立语义关联关系')
            .addButton(button => button
                .setButtonText('执行全局扫描')
                .onClick(async () => {
                    button.setButtonText('扫描中...');
                    button.setDisabled(true);
                    await this.plugin.globalRelationScan();
                    button.setButtonText('执行全局扫描');
                    button.setDisabled(false);
                }));

        new Setting(containerEl)
            .setName('启动时仅执行关系扫描')
            .setDesc('Obsidian 启动时仅执行全局关系扫描（不分析笔记内容）')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoScanOnStartup)
                .onChange(async (value) => {
                    this.plugin.settings.autoScanOnStartup = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('批处理大小')
            .setDesc(`每次处理的笔记数量: ${this.plugin.settings.batchSize}`)
            .addSlider(slider => slider
                .setLimits(1, 50, 1)
                .setValue(this.plugin.settings.batchSize)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.batchSize = value;
                    await this.plugin.saveSettings();
                    this.display();
                }))
            .addText(text => text
                .setPlaceholder('输入数字')
                .setValue(this.plugin.settings.batchSize.toString())
                .onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num >= 1 && num <= 50) {
                        this.plugin.settings.batchSize = num;
                        await this.plugin.saveSettings();
                        this.display();
                    } else {
                        text.setValue(this.plugin.settings.batchSize.toString());
                    }
                })
                .inputEl.style.width = '80px');

        new Setting(containerEl)
            .setName('排除文件夹')
            .setDesc('扫描时排除的文件夹（逗号分隔）')
            .addText(text => text
                .setPlaceholder('templates, archive')
                .setValue(this.plugin.settings.excludeFolders.join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.excludeFolders = value.split(',').map(s => s.trim()).filter(s => s);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('插入摘要')
            .setDesc('AI 整理时自动插入摘要区块')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.insertSummary)
                .onChange(async (value) => {
                    this.plugin.settings.insertSummary = value;
                    await this.plugin.saveSettings();
                }));
    }
}