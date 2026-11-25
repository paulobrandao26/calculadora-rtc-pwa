// Gera os PNGs do app a partir do icons/icon.svg (usa o Playwright já instalado em career-ops, sem alterar nada lá).
const { chromium } = require('C:/dev/career-ops/node_modules/playwright');
const fs = require('fs'); const path = require('path');
(async () => {
  const dir = path.join(__dirname, '..', 'web', 'icons');
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
  const b = await chromium.launch(); const p = await b.newPage();
  for (const [nome, tam, pad] of [['icon-192.png', 192, 0], ['icon-512.png', 512, 0], ['icon-maskable-512.png', 512, 0.12]]) {
    await p.setViewportSize({ width: tam, height: tam });
    const inner = Math.round(tam * (1 - pad * 2));
    await p.setContent(`<body style="margin:0;background:#0f2a44;display:grid;place-items:center;width:${tam}px;height:${tam}px">
      <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body>`);
    await p.screenshot({ path: path.join(dir, nome), omitBackground: false });
  }
  await b.close(); console.log('ícones ok');
})();
