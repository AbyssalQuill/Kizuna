import { renderMarkdownToImage } from '../src/lib/render-markdown.js';

const testMd = `
化成二重积分：

$$ I^2 = \\left( \\int_{-\\infty}^\\infty e^{-x^2} dx \\right) \\left( \\int_{-\\infty}^\\infty e^{-y^2} dy \\right) = \\int_{-\\infty}^\\infty \\int_{-\\infty}^\\infty e^{-(x^2+y^2)} dx dy $$

用极坐标：$x = r \\cos\\theta, \\quad y = r \\sin\\theta, \\quad dx dy = r dr d\\theta$

于是：

$$ I^2 = \\int_0^{2\\pi} \\int_0^\\infty e^{-r^2} r dr d\\theta $$

先算径向积分：

$$ \\int_0^\\infty e^{-r^2} r dr = \\frac{1}{2} \\int_0^\\infty e^{-u} du = \\frac{1}{2} $$

最终结论：

$$ \\boxed{\\int_{-\\infty}^\\infty e^{-x^2} dx = \\sqrt{\\pi}} $$

---

## 斐波那契数列 C++ 函数定义

定义：$F(0) = 0, F(1) = 1, F(n) = F(n-1) + F(n-2)$

### 一、迭代版（最常用，O(n) 时间 O(1) 空间）

\`\`\`cpp
// 返回第 n 项斐波那契数，n >= 0
long long fib(int n) {
    long long a = 0, b = 1;
    for (int i = 0; i < n; ++i) {
        long long c = a + b;
        a = b;
        b = c;
    }
    return a;
}
\`\`\`

适用：$n \\le 92$（\`long long\` 上限）。超过会溢出，见高精度版。
`;

async function main() {
  console.log('Rendering markdown image...');
  const res = await renderMarkdownToImage(testMd, { title: '高斯积分与斐波那契数列推导' });
  console.log('Result:', res);
}

main().catch(console.error);
