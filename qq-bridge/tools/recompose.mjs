import fs from 'node:fs';
import { composePresetText } from '../src/lib/preset-compose.js';

const agentFile = 'dsh/agent-presets/qq-chat/agent.cordis.yml';
const cur = fs.readFileSync(agentFile, 'utf8');
const persona = fs.readFileSync('persona.md', 'utf8');
const speechRules = fs.readFileSync('speech-rules.md', 'utf8');

const next = composePresetText(cur, { persona, speechRules });
fs.writeFileSync(agentFile, next, 'utf8');
console.log('Composed agent.cordis.yml successfully. Total lines:', next.split('\n').length);
