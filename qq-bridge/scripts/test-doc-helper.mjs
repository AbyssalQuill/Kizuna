import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const spec = {
  sheets: [
    {
      name: '团队成员',
      headers: ['姓名', '角色', '贡献度', '状态'],
      rows: [
        ['小鲸鱼', '架构核心 & 助理', '100%', '全速工作中'],
        ['主人', '总指挥官', '∞', '在线指导']
      ]
    }
  ]
};

const tmpSpec = '/tmp/test_spec.json';
const tmpXlsx = '/tmp/test_team.xlsx';
fs.writeFileSync(tmpSpec, JSON.stringify(spec, null, 2), 'utf8');

const docHelper = '/root/qq-bridge/src/lib/doc-helper.py';
const genRes = execFileSync('python3', [docHelper, 'generate_excel', tmpSpec, tmpXlsx], { encoding: 'utf8' });
console.log('Generate Result:', genRes.trim());

const parseRes = execFileSync('python3', [docHelper, 'parse', tmpXlsx], { encoding: 'utf8' });
console.log('Parse Result:\n', JSON.parse(parseRes.trim()).text);
