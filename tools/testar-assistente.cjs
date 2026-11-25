// Testa a ajuda "?" e o assistente (PC 1280x800 e celular 390x844).
// Uso:
//   node tools/testar-assistente.cjs desligado   -> assistente sem chave: confere o aviso e a ajuda "?"
//   node tools/testar-assistente.cjs             -> assistente ligado com a IA de teste: roteiro fixo, confere tudo exato
//   node tools/testar-assistente.cjs real        -> assistente ligado com a IA de verdade: confere o essencial
// Com a IA de teste (perfil "teste" do docker-compose) o roteiro é fixo; com IA real os textos variam.
const { chromium } = require('C:/dev/career-ops/node_modules/playwright');
const path = require('path'); const fs = require('fs');

const BASE = 'http://localhost:8090';
const MODO = process.argv[2] || 'ligado';
const REAL = MODO === 'real';
const OUT = path.join(__dirname, '..', 'fotos'); fs.mkdirSync(OUT, { recursive: true });
const telas = [
  { nome: 'pc', viewport: { width: 1280, height: 800 } },
  { nome: 'celular', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
];
let falhas = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) falhas++; };

(async () => {
  const browser = await chromium.launch();
  for (const t of telas) {
    console.log(`\n== ${t.nome} (${MODO})`);
    const ctx = await browser.newContext({ viewport: t.viewport, isMobile: t.isMobile, hasTouch: t.hasTouch, deviceScaleFactor: t.deviceScaleFactor || 1, locale: 'pt-BR' });
    const page = await ctx.newPage();
    const erros = []; page.on('pageerror', e => erros.push(e.message));
    const foto = (n, full = false) => page.screenshot({ path: path.join(OUT, `${t.nome}-assistente-${n}.png`), fullPage: full });

    await page.goto(BASE + '/#/regime');
    await page.waitForFunction(() => document.querySelectorAll('#rg-items [name=classe] option').length > 5, null, { timeout: 20000 });

    // ajuda "?"
    const qs = await page.locator('button.q').count();
    ok(qs >= 6, `botões "?" aparecem nos campos (${qs})`);
    await page.locator('label[for="cod-0"] button.q').click();
    const ajuda = await page.locator('.ajuda-box').first().textContent();
    ok(/8 números/.test(ajuda), 'ajuda do NCM explica o campo');

    if (MODO === 'desligado') {
      ok(await page.locator('#assist-off').isVisible(), 'aviso de assistente desligado aparece');
      await page.locator('#assist').scrollIntoViewIfNeeded();
      await page.evaluate(() => scrollTo(0, 0));
      await foto('desligado');
      await ctx.close(); continue;
    }

    // pergunta simples: só explica, não preenche
    await page.fill('#assist-txt', 'O que é NCM?');
    await page.click('#assist-go');
    await page.waitForSelector('#assist-log .msg.ia:not(.pensando)', { timeout: 240000 });
    ok(/NCM/.test(await page.textContent('#assist-log')), 'responde pergunta sobre o campo');

    // descrição -> preenche
    await page.fill('#assist-txt', 'Vendi 20 kg de arroz para um mercado de Porto Alegre por R$ 100.');
    await page.click('#assist-go');
    await page.waitForFunction(() => /O que eu preenchi/.test(document.querySelector('#assist-log')?.textContent || ''), null, { timeout: 240000 });
    await page.waitForFunction(() => document.querySelector('#rg-mun')?.value === '4314902' && document.querySelectorAll('#rg-items [name=classe] option').length > 5, null, { timeout: 20000 });
    const v = await page.evaluate(() => ({ cod: document.querySelector('#cod-0').value, cls: document.querySelector('#cls-0').value, val: document.querySelector('#val-0').value, mun: document.querySelector('#rg-mun').value, itens: document.querySelectorAll('#rg-items .item').length, marcado: document.querySelectorAll('.ia-ok').length }));
    ok((REAL ? /^1006/.test(v.cod) : v.cod === '10063021') && v.cls === '200|200003' && v.val === '100,00', `item preenchido: NCM ${v.cod}, ${v.cls}, R$ ${v.val}`);
    ok(v.mun === '4314902', 'município preenchido (Porto Alegre)');
    ok(v.marcado > 0, 'campos preenchidos ficam destacados');
    const log = await page.textContent('#assist-log');
    if (!REAL) ok(/não existe na tabela oficial/.test(log), 'código inventado foi barrado e avisado');
    await page.evaluate(() => document.querySelector('#assist').scrollIntoView());
    await page.waitForTimeout(500);
    await foto('regime-preenchido');

    // tira o item com código barrado e calcula
    if (v.itens > 1) await page.locator('#rg-items [data-rm="1"]').click();
    await page.waitForTimeout(600);
    await page.click('#rg-go');
    await page.waitForSelector('#rg-res #resultado', { timeout: 30000 });
    ok(/Todos os itens calculados/.test(await page.textContent('#rg-res')), 'cálculo oficial funciona com o que o assistente preencheu');

    // simples
    await page.goto(BASE + '/#/simples');
    await page.waitForSelector('#assist-form:not([hidden])');
    await page.fill('#assist-txt', 'Sou comércio do Simples, vendi R$ 950 de cerveja numa NF-e em março de 2027. PGDAS: CBS 1,1612% e IBS 0,0129%.');
    await page.click('#assist-go');
    await page.waitForFunction(() => /O que eu preenchi/.test(document.querySelector('#assist-log')?.textContent || ''), null, { timeout: 240000 });
    await page.waitForFunction(() => document.querySelectorAll('#sn-items [name=atividade] option').length > 1, null, { timeout: 20000 });
    const s = await page.evaluate(() => ({ at: document.querySelector('#sat-0').value, pc: document.querySelector('#sn-pcbs').value, val: document.querySelector('#sval-0').value }));
    ok(s.at === '01' && /^1,1612/.test(s.pc) && s.val === '950,00', `simples preenchido: atividade ${s.at}, CBS ${s.pc}, R$ ${s.val}`);
    await page.evaluate(() => document.querySelector('#assist').scrollIntoView());
    await page.waitForTimeout(500);
    await foto('simples-preenchido');
    await page.click('#sn-go');
    await page.waitForSelector('#sn-res #resultado', { timeout: 30000 });
    ok(/Todos os itens calculados/.test(await page.textContent('#sn-res')), 'simples calcula com o que o assistente preencheu');

    ok(erros.length === 0, 'sem erros no console' + (erros.length ? ': ' + erros.join(' | ') : ''));
    await ctx.close();
  }
  await browser.close();
  console.log(falhas ? `\n${falhas} falha(s).` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})();
