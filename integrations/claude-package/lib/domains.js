export const DOMAIN_KEYWORDS = {
  backend_systems: [
    'backend', 'database', 'sql', 'sqlite', 'postgres', 'mysql', 'redis', 'orm',
    'prisma', 'server', 'api', 'graphql', 'grpc', 'microservice', 'rust', 'golang',
    'controller', 'protocol', 'storage', 'daemon', 'socket', 'pipe', 'mutex', 'thread',
    '后端', '数据库', '接口', '服务端', '底层', '存储', '内核', '协议'
  ],
  frontend_ui: [
    'frontend', 'react', 'vue', 'svelte', 'html', 'css', 'tailwind', 'ui', 'ux',
    'component', 'page', 'layout', 'canvas', 'dom', 'web', 'vite', 'webpack',
    'svg', 'chart', 'style', 'button', 'modal', 'theme',
    '前端', '界面', '组件', '样式', '页面', '画布', '按钮', '弹窗'
  ],
  devops_infra: [
    'docker', 'container', 'kubernetes', 'k8s', 'terraform', 'ci', 'cd', 'pipeline',
    'github actions', 'nginx', 'deploy', 'deployment', 'cluster', 'aws', 'azure',
    'linux', 'bash', 'systemd', 'ansible', 'helm', 'cloud',
    '运维', '部署', '容器', '集群', '流水线', '服务器环境'
  ],
  testing_qa: [
    'test', 'testing', 'unit test', 'integration test', 'e2e', 'assertion', 'mock',
    'jest', 'vitest', 'playwright', 'coverage', 'benchmark', 'qa',
    '测试', '单测', '集成测试', '断言', '覆盖率', '压测'
  ],
  documentation_pr: [
    'document', 'documentation', 'markdown', 'doc', 'readme', 'spec', 'rfc',
    'changelog', 'report', 'paper', 'presentation', 'ppt', 'docx', 'copywrite',
    'marketing', 'article', 'blog', 'release notes', 'lesson plan', 'syllabus',
    '文档', '报告', '说明文档', '文案', '宣传', '文章', '汇报', '教案', '教学设计',
    '课程', '课件', '讲义', '实验报告', '物理', '牛顿', '化学', '生物', '历史',
    '地理', '论文', '演讲稿', '策划案', '通稿', '公文', '总结'
  ],
  data_ai: [
    'ml', 'machine learning', 'deep learning', 'model', 'training', 'inference',
    'python', 'pytorch', 'tensorflow', 'pandas', 'numpy', 'dataset', 'embedding',
    'llm', 'prompt', 'rag', 'analytics', 'vector',
    '模型', '训练', '推理', '数据分析', '数据集', '向量'
  ],
  mobile_app: [
    'android', 'ios', 'flutter', 'react native', 'swift', 'swiftui', 'kotlin',
    'apk', 'ipa', 'xcode', 'mobile',
    '移动端', '安卓', '苹果', '手机端'
  ],
  creative_writing: [
    'story', 'fiction', 'novel', 'sci-fi', 'fantasy', 'poem', 'poetry', 'script',
    'screenplay', 'creative writing', 'character', 'plot', 'chapter', 'lore',
    '故事', '小说', '科幻', '剧本', '散文', '诗歌', '诗', '绝句', '律诗', '词',
    '创作', '短篇', '长篇', '章节', '恋爱', '校园', '武侠', '仙侠', '玄幻',
    '奇幻', '悬疑', '推理', '童话', '寓言', '随笔', '作文', '游记'
  ]
};

export function classifyDomain(text) {
  if (!text || typeof text !== 'string') return { primaryDomain: 'general', confidence: 0, matchedKeywords: [] };
  const lower = text.toLowerCase();
  let bestDomain = 'general';
  let maxMatches = 0;
  let bestMatches = [];
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const matched = keywords.filter((k) => {
      // Short English terms such as ui, cd and doc must be whole tokens.
      // ASCII boundaries still allow mixed text such as 打开html页面.
      if (/^[a-z0-9 -]+$/i.test(k)) {
        const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`, 'i').test(lower);
      }
      return lower.includes(k.toLowerCase());
    });
    if (matched.length > maxMatches) {
      maxMatches = matched.length;
      bestDomain = domain;
      bestMatches = matched;
    }
  }
  return {
    primaryDomain: bestDomain,
    confidence: maxMatches > 0 ? Math.min(1.0, maxMatches * 0.25) : 0,
    matchedKeywords: bestMatches
  };
}

export function detectDomainShift(currentContextOrDomain, incomingInstruction) {
  if (!incomingInstruction || typeof incomingInstruction !== 'string') {
    return { isShift: false, previousDomain: 'general', detectedDomain: 'general' };
  }
  const incomingCls = classifyDomain(incomingInstruction);
  if (incomingCls.primaryDomain === 'general' || incomingCls.confidence < 0.25) {
    return { isShift: false, previousDomain: currentContextOrDomain || 'general', detectedDomain: 'general' };
  }
  let prevDomain = currentContextOrDomain;
  if (!DOMAIN_KEYWORDS[prevDomain]) {
    const prevCls = classifyDomain(currentContextOrDomain);
    prevDomain = prevCls.primaryDomain;
  }
  if (prevDomain !== 'general' && prevDomain !== incomingCls.primaryDomain) {
    return {
      isShift: true,
      previousDomain: prevDomain,
      detectedDomain: incomingCls.primaryDomain,
      reason: `跨领域指令触发：当前领域为 [${prevDomain}]，新指令领域为 [${incomingCls.primaryDomain}] (关键词: ${incomingCls.matchedKeywords.join(', ')})`
    };
  }
  return { isShift: false, previousDomain: prevDomain, detectedDomain: incomingCls.primaryDomain };
}
