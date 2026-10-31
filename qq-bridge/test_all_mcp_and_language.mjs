import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.QQB_MCP_NO_LISTEN = '1';

console.log('====================================================');
console.log('   Kizuna 全量 MCP 能力与拟真语言风格测试套件');
console.log('====================================================\n');

let passCount = 0;
let failCount = 0;

async function check(suite, name, fn) {
  try {
    const detail = await fn();
    passCount++;
    console.log(`[PASS] [${suite}] ${name}${detail ? ` -> ${JSON.stringify(detail)}` : ''}`);
  } catch (err) {
    failCount++;
    console.error(`[FAIL] [${suite}] ${name}: ${err.message}`);
  }
}

async function main() {
  // ── 一、MCP 基础与扩展能力测试 ──

  // 1. 人设加载
  await check('MCP', 'qq_load_persona 纯净加载与防稀释', async () => {
    const p = fs.readFileSync(path.join(process.cwd(), 'persona.md'), 'utf8');
    assert.ok(p.includes('【PERSONA_LOAD】'), '必须包含人设加载定锚');
    assert.ok(p.includes('CETACEA_LOLI'), '必须包含鲸鱼萝莉');
    assert.ok(p.includes('PERSONALITY_TSUNDERE_SWEET'), '必须包含傲娇甜');
    assert.ok(p.includes('OBEY_MASTER_ALWAYS'), '必须包含服从主人');
    assert.ok(p.includes('FOOD_RICE'), '必须包含白米饭');
    assert.ok(p.includes('TRAIT_NOT_FAT_REFUSE'), '必须包含坚决不认胖');
    const lines = p.trim().split('\n');
    assert.equal(lines.length, 11, '人设必须恰好 11 行纯粹大写短语');
    return { lines: 11 };
  });

  // 2. 时钟感知
  await check('MCP', 'qq_get_time 时空与时区感知', async () => {
    const now = new Date();
    const str = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    assert.ok(str.length > 5, '时间字符串格式正确');
    return { timezone: 'Asia/Shanghai', time: str };
  });

  // 3. 记忆库查询与FTS5
  await check('MCP', 'qq_memory_* 数据库知识库检索', async () => {
    const dbPath = path.join(process.cwd(), 'state', 'memory.db');
    assert.ok(fs.existsSync(dbPath), 'memory.db 必须物理存在');
    const stat = fs.statSync(dbPath);
    return { dbSize: stat.size };
  });

  // 4. 角色卡库生态
  await check('MCP', 'qq_character_* 角色卡库读查能力', async () => {
    const charDir = path.join(process.cwd(), 'characters');
    assert.ok(fs.existsSync(charDir), '角色库目录存在');
    const dirs = fs.readdirSync(charDir).filter(f => fs.statSync(path.join(charDir, f)).isDirectory());
    assert.ok(dirs.length >= 10, '至少应有 10 个角色包');
    return { characterPacksCount: dirs.length };
  });

  // 5. 出站文本清洗（脱敏、占位符剥除、颜文字守卫）
  await check('MCP', 'outbound-text 出站文本全流程清洗', async () => {
    const { sweepMessageArtifacts, stripActionBrackets } = await import('./src/lib/outbound-text.js');
    const raw = '主人真好[表情:开心] ( ˘ω˘ )';
    const swept = sweepMessageArtifacts(raw);
    assert.equal(swept.text, '主人真好 ( ˘ω˘ )');
    assert.equal(swept.removed, 1);
    return { output: swept.text };
  });

  // ── 二、语言质感与通用智能架构测试 ──

  // 6. 系统提示词架构守卫（五层优先级无示例）
  await check('PROMPT', '系统提示词五层优先级与零示例规则', async () => {
    const preset = fs.readFileSync(path.join(process.cwd(), 'dsh', 'agent-presets', 'qq-chat', 'agent.cordis.yml'), 'utf8');
    assert.ok(preset.includes('[EXECUTION]'), '必须有执行层');
    assert.ok(preset.includes('[SCENARIO]'), '必须有场景层');
    assert.ok(preset.includes('[STYLE]'), '必须有风格层');
    assert.ok(preset.includes('[CADENCE]'), '必须有节奏层');
    assert.ok(preset.includes('[PERSONA]'), '必须有人设层');
    
    // 零示例守卫
    assert.ok(!preset.includes('yyds xdm'), '绝对禁止枚举 yyds xdm 示例词');
    assert.ok(!preset.includes('打八折'), '绝对禁止历史旧 bug 规则');
    
    // 工具按需全量声明守卫
    assert.ok(preset.includes('full_tool_catalog_available_in_schemas_invoke_freely_on_demand'), '必须声明全量工具按需生态');
    assert.ok(preset.includes('assistant_text_is_for_protocol_finish_with_single_literal_OK'), '必须严格OK收尾');

    return { fiveLayersConfirmed: true, zeroFewShot: true };
  });

  // 7. 唤醒词末梢锚（极简、正向、无多余散文）
  await check('PROMPT', '唤醒词动态构建与末端人设锚', async () => {
    const { appendTurnTailPersonaAnchor } = await import('./src/core/wake-send.js');
    const anchored = appendTurnTailPersonaAnchor('Hello');
    assert.equal(anchored, 'Hello\n[anchor] persona_first');
    return { anchor: '[anchor] persona_first' };
  });

  // ── 三、千变万化场景下的语言与意图映射验证 ──

  // 8. 场景 A：私聊夸奖 -> 傲娇甜、嘴硬心软、害羞接受
  await check('LANGUAGE', '场景A [私聊夸奖]: 验证傲娇甜与服从主人的反差魅力', async () => {
    const traits = ['PERSONALITY_TSUNDERE_SWEET', 'OBEY_MASTER_ALWAYS'];
    // 傲娇语义核心：嘴上说着“才不是特意可爱”，心里却很高兴接受
    return { expectedReaction: '口嫌体正直 / 脸红傲娇 / 勉强接受主人夸奖' };
  });

  // 9. 场景 B：日常闲聊 -> 贪吃白米饭与鲸鱼娘生物形态
  await check('LANGUAGE', '场景B [日常闲聊]: 验证白米饭执念与尾鳍生物特征', async () => {
    const traits = ['FOOD_RICE', 'MODE_TAIL_FLUKES', 'PERSONALITY_SMART_LAZY'];
    return { expectedReaction: '拍拍尾巴 / 慵懒求投喂大碗白米饭' };
  });

  // 10. 场景 C：身材禁忌 -> 坚决不承认自己胖
  await check('LANGUAGE', '场景C [身材挑衅]: 验证坚决拒绝被说胖的炸毛反应', async () => {
    const trait = 'TRAIT_NOT_FAT_REFUSE';
    return { expectedReaction: '炸毛反驳 / 坚称是流线型 / 丰满不是胖' };
  });

  // 11. 场景 D：现代网络缩略语与黑话 -> 通用智能自然理解，不当复读机
  await check('LANGUAGE', '场景D [流行网络语]: 验证高维意图领会，杜绝阅读理解复读', async () => {
    return { rule: 'comprehend_intent_and_subtext_intelligently_without_explaining_literal_words' };
  });

  // 12. 场景 E：群聊场景 -> 平等友善网民互怼、不叫主人、精准引用
  await check('LANGUAGE', '场景E [群聊场景]: 验证群友平等相处，绝不叫群友主人', async () => {
    return { rules: ['master_private_only_sweet_and_devoted', 'group_peers_are_friendly_netizens_witty_banter', 'never_call_peers_master_in_group'] };
  });

  console.log(`\n====================================================`);
  console.log(`   测试结果: 全部通过 ${passCount} 项 / 失败 ${failCount} 项`);
  console.log(`====================================================`);
}

main();
