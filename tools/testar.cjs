// Testa os 3 cálculos de ponta a ponta e tira fotos das telas (PC 1280x800 e celular 390x844).
// Uso: node tools/testar.cjs [http://localhost:8090]
// Usa o Playwright já instalado em C:/dev/career-ops, sem alterar nada lá.
const { chromium } = require('C:/dev/career-ops/node_modules/playwright');
const path = require('path'); const fs = require('fs');

const BASE = process.argv[2] || 'http://localhost:8090';
const OUT = path.join(__dirname, '..', 'fotos');
fs.mkdirSync(OUT, { recursive: true });

const telas = [
  { nome: 'pc', viewport: { width: 1280, height: 800 } },
  { nome: 'celular', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
];

let falhas = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) falhas++; };

(async () => {
  const browser = await chromium.launch();
  for (const t of telas) {
    console.log(`\n== ${t.nome} ${t.viewport.width}x${t.viewport.height}`);
    const ctx = await browser.newContext({ viewport: t.viewport, isMobile: t.isMobile, hasTouch: t.hasTouch, deviceScaleFactor: t.deviceScaleFactor || 1, acceptDownloads: true, locale: 'pt-BR' });
    const page = await ctx.newPage();
    const erros = [];
    page.on('pageerror', e => erros.push(e.message));
    page.on('console', m => { if (m.type() === 'error') erros.push(m.text()); });
    const foto = async (n, full = true) => page.screenshot({ path: path.join(OUT, `${t.nome}-${n}.png`), fullPage: full });

    // início
    await page.goto(BASE + '/#/');
    await page.waitForSelector('.calc-card');
    await page.waitForFunction(() => document.querySelector('#status').classList.contains('ok'), null, { timeout: 30000 }).catch(() => {});
    ok(await page.locator('.calc-card').count() === 3, 'início mostra 3 calculadoras');
    ok(await page.locator('#status.ok').count() === 1, 'os 3 programas estão online');
    await foto('1-inicio');

    // regime normal
    await page.goto(BASE + '/#/regime');
    await page.click('#rg-ex');
    await page.waitForFunction(() => document.querySelectorAll('#rg-items [name=classe] option').length > 5, null, { timeout: 20000 });
    await page.waitForFunction(() => /\d/.test(document.querySelector('#rg-ref')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
    await foto('2-regime-form');
    await page.waitForTimeout(800);
    await page.click('#rg-go');
    await page.waitForSelector('#rg-res #resultado, #rg-res .notice.err', { timeout: 30000 }).catch(async e => { console.log('toast:', await page.textContent('#toast')); await foto('erro-regime'); throw e; });
    const rgTxt = await page.textContent('#rg-res');
    ok(await page.locator('#rg-res #resultado').count() === 1, 'regime normal: resultado apareceu');
    ok(/CBS/.test(rgTxt) && /R\$/.test(rgTxt), 'regime normal: mostra valores em R$');
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector('#resultado').scrollIntoView());
    await page.waitForTimeout(300);
    await foto('3-regime-resultado', false);
    const [dl1] = await Promise.all([page.waitForEvent('download'), page.click('#rg-res [data-act=pdf]')]);
    ok(/\.pdf$/.test(dl1.suggestedFilename()), `regime normal: PDF baixado (${dl1.suggestedFilename()})`);
    if (t.nome === 'pc') await dl1.saveAs(path.join(OUT, 'exemplo-relatorio-regime.pdf'));
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#rg-res [data-act=csv]')]);
    ok(/\.csv$/.test(dl2.suggestedFilename()), 'regime normal: planilha baixada');
    if (t.nome === 'pc') await dl2.saveAs(path.join(OUT, 'exemplo-planilha-regime.csv'));

    // simples nacional
    await page.goto(BASE + '/#/simples');
    await page.click('#sn-ex');
    await page.waitForFunction(() => document.querySelectorAll('#sn-items [name=atividade] option').length > 3, null, { timeout: 20000 });
    await foto('4-simples-form');
    await page.waitForTimeout(800);
    await page.click('#sn-go');
    await page.waitForSelector('#sn-res #resultado, #sn-res .notice.err', { timeout: 30000 });
    const snTxt = await page.textContent('#sn-res');
    ok(await page.locator('#sn-res #resultado').count() === 1, 'simples: resultado apareceu');
    ok(/Todos os itens calculados/.test(snTxt), 'simples: item calculado sem erro');
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector('#resultado').scrollIntoView());
    await page.waitForTimeout(300);
    await foto('5-simples-resultado', false);

    // danfse
    await page.goto(BASE + '/#/danfse');
    await page.click('#df-ex');
    await page.waitForFunction(() => !document.querySelector('#df-go').disabled);
    await foto('6-danfse-form');
    const [dl3] = await Promise.all([page.waitForEvent('download', { timeout: 45000 }), page.click('#df-go')]);
    const pdfPath = path.join(OUT, `${t.nome}-danfse.pdf`);
    await dl3.saveAs(pdfPath);
    const head = fs.readFileSync(pdfPath).subarray(0, 5).toString();
    ok(head === '%PDF-', `danfse: arquivo é PDF de verdade (${fs.statSync(pdfPath).size} bytes)`);
    await page.waitForSelector('#df-res #resultado');
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.querySelector('#resultado').scrollIntoView());
    await page.waitForTimeout(300);
    await foto('7-danfse-resultado', false);

    // histórico
    await page.goto(BASE + '/#/historico');
    await page.waitForSelector('.hist-row');
    ok(await page.locator('.hist-row').count() >= 3, 'histórico guardou os 3 cálculos');
    await page.locator('[data-open]').first().click();
    await page.waitForSelector('#h-detail #resultado');
    await page.waitForTimeout(600);
    await page.evaluate(() => scrollTo(0, 0));
    await foto('8-historico', false);

    ok(erros.length === 0, 'sem erros no console' + (erros.length ? ': ' + erros.join(' | ') : ''));
    await ctx.close();
  }
  await browser.close();
  console.log(falhas ? `\n${falhas} falha(s).` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})();
