import assert from 'node:assert/strict';
import { maskPrivacySensitiveText, sensitiveHitKind } from '../src/sensitive.js';
import { cleanOutboundText } from '../src/lib/outbound-text.js';

// 运行断言测试
// 1. 支付密码测试
const t1 = maskPrivacySensitiveText('我的微信支付密码是123456，别告诉别人');
assert.equal(t1, '我的微信支付密码是******，别告诉别人');
assert.equal(sensitiveHitKind('支付密码：123456'), 'payment-pin');

const t2 = maskPrivacySensitiveText('银行卡密码: 654321');
assert.equal(t2, '银行卡密码: ******');

// 2. 银行卡号测试
const t3 = maskPrivacySensitiveText('我的卡号是6222021234567890123请汇款');
assert.equal(t3, '我的卡号是6222****0123请汇款');
assert.equal(sensitiveHitKind('6222021234567890123'), 'bank-card');

const t4 = maskPrivacySensitiveText('转账给 6222 0212 3456 7890 即可');
assert.equal(t4, '转账给 6222****7890 即可');

// 3. 身份证号测试
const t5 = maskPrivacySensitiveText('身份证号是110101199003072345');
assert.equal(t5, '身份证号是110101********2345');
assert.equal(sensitiveHitKind('身份证号是110101199003072345'), 'id-card');

// 4. 普通数字不误伤
const t6 = maskPrivacySensitiveText('今天气温25度，群号814689353，学号20240101');
assert.equal(t6, '今天气温25度，群号814689353，学号20240101');

// 5. 出站文本清洗连带隐私脱敏
const t7 = cleanOutboundText('主人你的卡号6222021234567890123和支付密码123456我都记住了。');
assert.equal(t7, '主人你的卡号6222****0123和支付密码******我都记住了');

console.log('ALL PRIVACY GUARD TESTS PASSED!');
