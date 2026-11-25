/* Calculadora RTC — app PWA que conversa com os programas abertos da Receita Federal.
 * Rotas: #/ (início), #/regime, #/simples, #/danfse, #/historico
 * As chamadas passam pelo nginx do docker-compose: /svc/regime, /svc/simples, /svc/danfse.
 */
'use strict';

/** Endereços dos programas da Receita (mesma origem, via proxy). */
const API = {
  regime: '/svc/regime/calculadora',
  simples: '/svc/simples/calculadora',
  danfse: '/svc/danfse/api/danfse',
};

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const main = $('#main');

/* ---------- utilidades ---------- */

/** Escapa texto para HTML. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
/** Formata número (ou texto numérico) como R$. */
function money(v) { const n = Number(v); return Number.isFinite(n) ? brl.format(n) : '—'; }
/** Formata percentual em pt-BR. */
function pct(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('pt-BR', { maximumFractionDigits: 4 }) + '%' : '—'; }
/** Converte "1.234,56" ou "1234.56" em número. */
function parseNum(s) {
  if (s == null) return NaN;
  let t = String(s).trim().replace(/[R$\s%]/g, '');
  if (!t) return NaN;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  return Number(t);
}
/** Converte número digitado em texto "1234.56" (formato que as APIs aceitam). */
function numStr(s, casas = 2) { const n = parseNum(s); return Number.isFinite(n) ? n.toFixed(casas) : ''; }
function hoje() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }
function uid() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/-/g, ''); }
function fmtData(iso) { const [y, m, d] = String(iso).slice(0, 10).split('-'); return d ? `${d}/${m}/${y}` : iso; }
function fmtQuando(ts) { return new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); }

let toastTimer;
/** Mostra aviso rápido no rodapé. */
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

/** Chamada HTTP com tempo-limite e mensagem de erro em português. */
async function http(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 30000);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) {
      let detalhe = '';
      try {
        const txt = await res.text();
        try { const j = JSON.parse(txt); detalhe = j.detail || j.message || j.title || j.erro || (j.errors && j.errors.map(e => e.detail || e.title).join('; ')) || ''; }
        catch { detalhe = txt.slice(0, 300); }
      } catch { /* sem corpo */ }
      const err = new Error(detalhe || `O programa respondeu com erro ${res.status}.`);
      err.status = res.status; throw err;
    }
    return res;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('O programa demorou demais para responder. Tente de novo em alguns segundos.');
    if (e instanceof TypeError) throw new Error('Não foi possível falar com o programa de cálculo. Confira se o Docker está ligado.');
    throw e;
  } finally { clearTimeout(timer); }
}
const getJSON = async (url, opts) => (await http(url, opts)).json();
const postJSON = async (url, body, extra = {}) => (await http(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra })).json();

/** Cache simples em memória das consultas de tabela. */
const cache = new Map();
async function cached(url) {
  if (!cache.has(url)) cache.set(url, getJSON(url).catch(e => { cache.delete(url); throw e; }));
  return cache.get(url);
}

/* ---------- histórico (localStorage) ---------- */

const HIST_KEY = 'rtc.historico.v1';
const Hist = {
  /** Lista os cálculos salvos, do mais novo para o mais antigo. */
  all() { try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch { return []; } },
  save(list) { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, 300))); },
  /** Guarda um relatório e devolve o id. */
  add(report) { const list = this.all(); report.id = report.id || uid(); report.when = report.when || Date.now(); list.unshift(report); this.save(list); return report.id; },
  get(id) { return this.all().find(r => r.id === id); },
  remove(id) { this.save(this.all().filter(r => r.id !== id)); },
  clear() { localStorage.removeItem(HIST_KEY); },
};

/* ---------- exportação ---------- */

const KIND_LABEL = { regime: 'Regime normal', simples: 'Simples Nacional', danfse: 'PDF da NFS-e' };

/** Gera e baixa o PDF de um relatório. */
function exportPDF(r) {
  if (!window.jspdf) { toast('O gerador de PDF ainda está carregando. Tente de novo.'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: r.columns && r.columns.length > 7 ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  doc.setFillColor(15, 42, 68); doc.rect(0, 0, W, 64, 'F');
  doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text('Calculadora RTC', 40, 30);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  doc.text(`${KIND_LABEL[r.kind] || ''} — ${r.title}`, 40, 48);
  doc.text(fmtQuando(r.when), W - 40, 48, { align: 'right' });
  doc.setTextColor(22, 33, 46);
  let y = 88;
  if (r.meta && r.meta.length) {
    doc.autoTable({ startY: y, body: r.meta, theme: 'plain', styles: { fontSize: 9, cellPadding: 3 }, columnStyles: { 0: { fontStyle: 'bold', cellWidth: 150 } }, margin: { left: 40, right: 40 } });
    y = doc.lastAutoTable.finalY + 12;
  }
  if (r.tiles && r.tiles.length) {
    doc.autoTable({ startY: y, head: [r.tiles.map(t => t[0])], body: [r.tiles.map(t => t[1])], theme: 'grid', headStyles: { fillColor: [11, 122, 90] }, styles: { fontSize: 10, halign: 'center' }, margin: { left: 40, right: 40 } });
    y = doc.lastAutoTable.finalY + 14;
  }
  if (r.columns && r.rows && r.rows.length) {
    doc.autoTable({ startY: y, head: [r.columns], body: r.rows, theme: 'striped', headStyles: { fillColor: [15, 42, 68] }, styles: { fontSize: 8, cellPadding: 4 }, margin: { left: 40, right: 40 } });
    y = doc.lastAutoTable.finalY + 14;
  }
  if (r.notes && r.notes.length) {
    doc.setFontSize(9); doc.setTextColor(90, 107, 125);
    const lines = doc.splitTextToSize(r.notes.map(n => '• ' + n).join('\n'), W - 80);
    if (y + lines.length * 11 > doc.internal.pageSize.getHeight() - 50) { doc.addPage(); y = 50; }
    doc.text(lines, 40, y);
  }
  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120);
    doc.text('Cálculo feito com os programas abertos da Receita Federal (LC 214/2025). Não é documento oficial.', 40, doc.internal.pageSize.getHeight() - 24);
    doc.text(`${i}/${pages}`, W - 40, doc.internal.pageSize.getHeight() - 24, { align: 'right' });
  }
  download(`calculo-${r.kind}-${new Date(r.when).toISOString().slice(0, 10)}.pdf`, doc.output("blob"));
}

/** Monta CSV (separador ";" e BOM, abre direto no Excel em português). */
function toCSV(rows) {
  const cell = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n');
}
function download(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
/** Baixa a planilha de um relatório. */
function exportCSV(r) {
  const out = [[`Calculadora RTC — ${KIND_LABEL[r.kind]}`], [r.title], ['Data do cálculo', fmtQuando(r.when)], []];
  (r.meta || []).forEach(m => out.push(m));
  if (r.tiles && r.tiles.length) { out.push([]); r.tiles.forEach(t => out.push([t[0], t[2] ?? t[1]])); }
  if (r.columns) { out.push([]); out.push(r.columns); (r.rowsRaw || r.rows || []).forEach(x => out.push(x)); }
  if (r.notes && r.notes.length) { out.push([]); r.notes.forEach(n => out.push([n])); }
  download(`calculo-${r.kind}-${new Date(r.when).toISOString().slice(0, 10)}.csv`, toCSV(out), 'text/csv;charset=utf-8');
}
/** Planilha com todo o histórico (uma linha por cálculo). */
function exportHistCSV(list) {
  const out = [['Data', 'Tipo', 'Descrição', 'Situação', 'Valor principal']];
  list.forEach(r => out.push([fmtQuando(r.when), KIND_LABEL[r.kind], r.title, r.statusText || '', r.headline ? String(r.headline.raw ?? '').replace('.', ',') : '']));
  download(`historico-calculos-${hoje()}.csv`, toCSV(out), 'text/csv;charset=utf-8');
}

/* ---------- componentes de tela ---------- */

const ICONS = {
  regime: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h2M12 11h2M8 15h2M12 15h2M16 11v6"/></svg>',
  simples: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  danfse: '<svg viewBox="0 0 24 24"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h6"/></svg>',
  pdf: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
};

/** Bloco de resultado padrão (usado no cálculo e no histórico). */
function resultHTML(r, { fromHistory = false } = {}) {
  const badge = r.status === 'ok' ? 'ok' : r.status === 'warn' ? 'warn' : 'err';
  return `
  <section class="card result" id="resultado" aria-labelledby="res-t" tabindex="-1">
    <div class="result-head">
      <div>
        <h2 id="res-t">${esc(r.resultTitle || 'Resultado')}</h2>
        <span class="badge ${badge}">${esc(r.statusText || '')}</span>
        <span class="crumb" style="margin-left:8px">${fmtQuando(r.when)}${fromHistory ? '' : ' · salvo no histórico'}</span>
      </div>
      <div class="actions" style="margin:0">
        ${r.kind === 'danfse' ? '' : `<button class="btn btn-ghost" data-act="pdf">${ICONS.pdf} Baixar PDF</button>
        <button class="btn btn-ghost" data-act="csv">${ICONS.pdf} Baixar planilha</button>`}
      </div>
    </div>
    ${r.tiles && r.tiles.length ? `<div class="tiles">${r.tiles.map((t, i) => `<div class="tile ${i === r.tiles.length - 1 ? 'main' : ''}"><span>${esc(t[0])}</span><strong>${esc(t[1])}</strong></div>`).join('')}</div>` : ''}
    ${(r.alerts || []).map(a => `<div class="notice ${a.type}"><div><b>${esc(a.title)}</b>${esc(a.text)}</div></div>`).join('')}
    ${r.columns && r.rows && r.rows.length ? `<div class="table-wrap"><table><thead><tr>${r.columns.map((c, i) => `<th class="${r.numCols && r.numCols.includes(i) ? 'n' : ''}">${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${r.rows.map(row => `<tr>${row.map((v, i) => `<td class="${r.numCols && r.numCols.includes(i) ? 'n' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}
    ${r.memo ? `<details class="more memo"><summary>Ver memória de cálculo da Receita</summary><pre>${esc(r.memo)}</pre></details>` : ''}
    ${r.notes && r.notes.length ? `<ul class="crumb" style="margin-top:12px">${r.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
  </section>`;
}
function bindResult(el, r) {
  el.querySelector('[data-act=pdf]')?.addEventListener('click', () => exportPDF(r));
  el.querySelector('[data-act=csv]')?.addEventListener('click', () => exportCSV(r));
}
/** Mostra o resultado embaixo do formulário e rola até ele. */
function showResult(host, r) {
  $('#toast').classList.remove('show');
  host.innerHTML = resultHTML(r);
  bindResult(host, r);
  const sec = host.querySelector('#resultado');
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  sec.focus({ preventScroll: true });
}
function showError(host, msg, retry) {
  host.innerHTML = `<div class="notice err result" role="alert"><div><b>Não deu para calcular</b>${esc(msg)}
    <div class="actions"><button class="btn btn-ghost" data-retry>Tentar de novo</button><a class="btn-link" href="#/">Voltar ao início</a></div></div></div>`;
  host.querySelector('[data-retry]').addEventListener('click', retry);
  host.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
/** Coloca o botão em estado "calculando". */
function busy(btn, on, label) {
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin"></span> ${label || 'Calculando…'}`; }
  else { btn.disabled = false; btn.innerHTML = btn.dataset.label; }
}

/* ---------- tela inicial ---------- */

function viewHome() {
  const hist = Hist.all();
  main.innerHTML = `
  <section class="hero">
    <div>
      <h1>Calcule CBS, IBS e Imposto Seletivo sem planilha e sem susto</h1>
      <p class="lead">Três ferramentas da reforma tributária num só lugar, com as regras e tabelas oficiais da Receita Federal. Escolha abaixo o que você precisa fazer.</p>
      ${hist.length ? `<p class="crumb">Você já fez ${hist.length} cálculo${hist.length > 1 ? 's' : ''}. <a href="#/historico">Ver histórico</a></p>` : ''}
    </div>
    <div class="hero-box">
      <h3>Por que usar</h3>
      <ul>
        <li><span class="tick">✓</span><span><b>Regras oficiais.</b> O cálculo é feito pelos programas abertos da Receita.</span></li>
        <li><span class="tick">✓</span><span><b>Tabelas já dentro.</b> NCM, NBS, cClassTrib e alíquotas de cada UF e município.</span></li>
        <li><span class="tick">✓</span><span><b>Pronto para o cliente.</b> Histórico, PDF e planilha em um toque.</span></li>
      </ul>
    </div>
  </section>
  <section class="cards" aria-label="Calculadoras">
    ${homeCard('regime', 'Regime normal', 'Calcula CBS, IBS e Imposto Seletivo de uma venda ou serviço, item a item, com as alíquotas da União, do estado e do município.', 'Empresas do lucro real ou presumido e escritórios de contabilidade.', 'Venda de 20 kg de arroz em Porto Alegre/RS por R$ 100,00: mostra a redução da cesta básica e quanto vai para CBS e IBS.')}
    ${homeCard('simples', 'Simples Nacional', 'Calcula CBS e IBS de quem está no Simples, a partir da atividade e das alíquotas efetivas do PGDAS.', 'MEIs que cresceram, micro e pequenas empresas e seus contadores.', 'Comércio (Anexo I) vendendo R$ 950,00 em mercadorias: separa a parte da CBS e a do IBS.')}
    ${homeCard('danfse', 'PDF da nota de serviço', 'Transforma o XML de uma NFS-e no PDF oficial (DANFSe), pronto para mandar ao cliente.', 'Prestadores de serviço e quem cuida das notas da empresa.', 'Arraste o arquivo .xml que o emissor nacional gerou e baixe o PDF com QR Code.')}
  </section>`;
}
function homeCard(k, title, what, who, ex) {
  return `<article class="card calc-card">
    <div class="ico">${ICONS[k]}</div>
    <h2>${title}</h2>
    <dl>
      <div><dt>O que faz</dt><dd>${what}</dd></div>
      <div><dt>Para quem</dt><dd>${who}</dd></div>
      <div><dt>Exemplo</dt><dd class="ex">${ex}</dd></div>
    </dl>
    <a class="btn btn-primary" href="#/${k}">Abrir calculadora</a>
  </article>`;
}

/* ---------- Regime normal ---------- */

const RG = { items: [] };
/** Sobe a cada tela desenhada; cargas antigas que voltarem depois são ignoradas. */
let VIEW = 0;

/** Lista de UFs. */
async function loadUFs() { return cached(`${API.regime}/dados-abertos/ufs`); }
/** Municípios de uma UF. */
async function loadMunicipios(uf) { return cached(`${API.regime}/dados-abertos/ufs/municipios?siglaUf=${encodeURIComponent(uf)}`); }
/** CSTs com as classificações (cClassTrib) vigentes na data. */
async function loadClassTrib(data, dfe) {
  return cached(`${API.regime}/dados-abertos/situacoes-tributarias/cbs-ibs?data=${data}${dfe ? `&siglaDfe=${dfe}` : ''}`);
}
async function loadClassTribIS(data) { return cached(`${API.regime}/dados-abertos/situacoes-tributarias/is?data=${data}`); }

/** Achata a resposta CST → classificações em opções de <select>. */
function classTribOptions(lista, selected) {
  const grupos = (lista || []).map(cst => {
    const codCst = cst.codigo ?? cst.cst ?? cst.CST;
    const desc = cst.descricao ?? cst.descricaoSituacao ?? '';
    const cls = cst.classificacoesTributarias || cst.classificacoes || [];
    const opts = cls.map(c => {
      const cod = c.codigo ?? c.cClassTrib ?? c.codigoClassificacao;
      const d = c.descricao ?? c.nome ?? '';
      const v = `${codCst}|${cod}`;
      return `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(cod)} — ${esc(String(d).slice(0, 90))}</option>`;
    }).join('');
    return opts ? `<optgroup label="CST ${esc(codCst)} — ${esc(String(desc).slice(0, 60))}">${opts}</optgroup>` : '';
  }).join('');
  return grupos;
}

function novoItemRG(over = {}) {
  return { tipo: 'ncm', codigo: '', classe: '000|000001', valor: '', quantidade: '', unidade: '', temIS: false, isClasse: '', isValor: '', ...over };
}

function viewRegime() {
  VIEW++;
  if (!RG.items.length) RG.items = [novoItemRG()];
  RG.data = RG.data || hoje();
  RG.uf = RG.uf || 'SP';
  main.innerHTML = `
  <div class="page-head">
    <div><div class="crumb"><a href="#/">Início</a> › Regime normal</div>
    <h1>Regime normal</h1>
    <p>Informe onde e quando a operação aconteceu e o que foi vendido. O programa busca as alíquotas e aplica as reduções sozinho.</p></div>
    <button class="btn-link" id="rg-ex" type="button">Preencher com exemplo</button>
  </div>
  <div class="layout">
    <div>
      ${assistenteHTML('regime')}
      <form class="card" id="rg-form" novalidate>
        <ol class="steps" aria-label="Etapas"><li class="on" id="st1"><b>1</b>Operação</li><li id="st2"><b>2</b>Itens</li><li id="st3"><b>3</b>Resultado</li></ol>
        <fieldset>
          <legend>Onde e quando</legend>
          <p class="legend-help">A data define quais regras e alíquotas valem.</p>
          <div class="grid">
            <div class="field"><label for="rg-data">Data da venda (fato gerador)</label><input type="date" id="rg-data" value="${RG.data}" required min="2026-01-01"><span class="hint" id="rg-data-h"></span></div>
            <div class="field"><label for="rg-uf">Estado</label><select id="rg-uf" required><option>Carregando…</option></select></div>
            <div class="field"><label for="rg-mun">Município</label><select id="rg-mun" required><option>Escolha o estado</option></select></div>
          </div>
        </fieldset>
        <fieldset id="rg-aliq" hidden>
          <legend>Alíquotas da operação</legend>
          <p class="legend-help">A partir de 2027 o programa da Receita pede as alíquotas. Já deixamos os valores de teste oficiais; troque se tiver outros.</p>
          <div class="grid">
            <div class="field"><label for="rg-pcbs">CBS</label><div class="pct"><input id="rg-pcbs" inputmode="decimal" value="${virgula(RG.aliqIA?.cbs ?? 8.8)}"></div></div>
            <div class="field"><label for="rg-puf">IBS estadual</label><div class="pct"><input id="rg-puf" inputmode="decimal" value="${virgula(RG.aliqIA?.ibsEstadual ?? 0.05)}"></div></div>
            <div class="field"><label for="rg-pmun">IBS municipal</label><div class="pct"><input id="rg-pmun" inputmode="decimal" value="${virgula(RG.aliqIA?.ibsMunicipal ?? 0.05)}"></div></div>
          </div>
        </fieldset>
        <fieldset>
          <legend>Itens da nota</legend>
          <p class="legend-help">Um item para cada produto ou serviço.</p>
          <div id="rg-items"></div>
          <button type="button" class="btn btn-ghost" id="rg-add">+ Adicionar item</button>
        </fieldset>
        <div class="sticky-cta"><button class="btn btn-primary" id="rg-go" type="submit">Calcular tributos</button></div>
      </form>
      <div id="rg-res"></div>
    </div>
    <aside class="aside">
      <div class="card"><h3>Como preencher</h3><ul>
        <li><b>NCM</b> é o código do produto (8 números). <b>NBS</b> é o do serviço (9 números).</li>
        <li><b>cClassTrib</b> diz como o item é tributado: integral, com redução, isento…</li>
        <li>Na dúvida, comece com <b>000001 — tributação integral</b>.</li>
      </ul></div>
      <div class="card"><h3>Alíquotas de referência</h3><div id="rg-ref"><div class="skel"></div><div class="skel"></div></div></div>
    </aside>
  </div>`;
  bindRegime();
  ligarAssistente('regime');
}

async function bindRegime() {
  const v = VIEW;
  const form = $('#rg-form');
  const dataEl = $('#rg-data'), ufEl = $('#rg-uf'), munEl = $('#rg-mun');

  const onData = () => {
    RG.data = dataEl.value;
    const ano = Number(RG.data.slice(0, 4));
    $('#rg-aliq').hidden = !(ano >= 2027);
    $('#rg-data-h').textContent = ano >= 2027 ? 'De 2027 em diante: informe as alíquotas abaixo.' : 'Em 2026 o programa usa as alíquotas de teste oficiais (CBS 0,9% e IBS 0,1%).';
    syncItemsRG(); renderItemsRG(); refreshRef();
  };
  dataEl.addEventListener('change', onData);

  try {
    const ufsRaw = await loadUFs(); if (v !== VIEW) return;
    const ufs = ufsRaw.slice().sort((a, b) => String(a.sigla).localeCompare(b.sigla));
    ufEl.innerHTML = ufs.map(u => `<option value="${esc(u.sigla)}" data-cod="${esc(u.codigo)}" ${u.sigla === RG.uf ? 'selected' : ''}>${esc(u.sigla)} — ${esc(u.nome)}</option>`).join('');
  } catch (e) { ufEl.innerHTML = '<option value="">Não carregou</option>'; showError($('#rg-res'), e.message, viewRegime); }

  const loadMun = async () => {
    RG.uf = ufEl.value; munEl.innerHTML = '<option>Carregando…</option>';
    try {
      const munsRaw = await loadMunicipios(RG.uf); if (v !== VIEW) return;
      const muns = munsRaw.slice().sort((a, b) => String(a.nome).localeCompare(b.nome, 'pt-BR'));
      munEl.innerHTML = muns.map(m => `<option value="${esc(m.codigo)}" ${String(m.codigo) === String(RG.mun) ? 'selected' : ''}>${esc(m.nome)}</option>`).join('');
      if (!muns.some(m => String(m.codigo) === String(RG.mun))) {
        const cap = muns.find(m => /^(São Paulo|Porto Alegre|Rio de Janeiro|Belo Horizonte|Curitiba|Salvador|Brasília|Recife|Fortaleza|Goiânia|Manaus|Belém|Florianópolis|Vitória|Natal|João Pessoa|Maceió|Aracaju|Teresina|São Luís|Cuiabá|Campo Grande|Palmas|Porto Velho|Rio Branco|Macapá|Boa Vista)$/.test(m.nome));
        if (cap) munEl.value = cap.codigo;
      }
      RG.mun = munEl.value; refreshRef();
    } catch (e) { munEl.innerHTML = '<option value="">Não carregou</option>'; }
  };
  ufEl.addEventListener('change', loadMun);
  munEl.addEventListener('change', () => { RG.mun = munEl.value; refreshRef(); });
  await loadMun(); if (v !== VIEW) return;
  onData();

  $('#rg-add').addEventListener('click', () => { syncItemsRG(); RG.items.push(novoItemRG()); renderItemsRG(); });
  $('#rg-ex').addEventListener('click', () => {
    RG.data = '2026-11-25'; RG.uf = 'RS'; RG.mun = '4314902';
    RG.items = [
      novoItemRG({ tipo: 'ncm', codigo: '10063021', classe: '200|200003', valor: '100,00', quantidade: '20', unidade: 'KG' }),
      novoItemRG({ tipo: 'nbs', codigo: '122011200', classe: '200|200028', valor: '1.200,00' }),
      novoItemRG({ tipo: 'ncm', codigo: '84713012', classe: '000|000001', valor: '3.500,00', quantidade: '1', unidade: 'UN' }),
    ];
    viewRegime(); toast('Exemplo preenchido: arroz, pré-escola e notebook em Porto Alegre/RS.');
  });

  form.addEventListener('submit', e => { e.preventDefault(); calcRegime(); });
}

/** Mostra as alíquotas de referência do local escolhido (2026). */
async function refreshRef() {
  const box = $('#rg-ref'); if (!box) return;
  const ufOpt = $('#rg-uf')?.selectedOptions[0];
  const codUf = ufOpt?.dataset.cod, mun = $('#rg-mun')?.value, data = RG.data;
  if (!codUf || !mun) return;
  box.innerHTML = '<div class="skel"></div><div class="skel"></div>';
  const pega = u => getJSON(u).then(j => j.aliquotaReferencia ?? j.aliquota ?? j.valor ?? j.aliquotaPadrao).catch(() => null);
  const [u, e, m] = await Promise.all([
    pega(`${API.regime}/dados-abertos/aliquota-uniao?data=${data}`),
    pega(`${API.regime}/dados-abertos/aliquota-uf?codigoUf=${codUf}&data=${data}`),
    pega(`${API.regime}/dados-abertos/aliquota-municipio?codigoMunicipio=${mun}&data=${data}`),
  ]);
  if (!box.isConnected) return;
  if (u == null && e == null && m == null) {
    box.innerHTML = '<p class="crumb" style="margin:0">A Receita só publicou alíquotas de referência para 2026. Para outros anos, informe as alíquotas no formulário.</p>';
    return;
  }
  box.innerHTML = `<table><tbody>
    <tr><td>CBS (União)</td><td class="n">${pct(u)}</td></tr>
    <tr><td>IBS estadual (${esc(RG.uf)})</td><td class="n">${pct(e)}</td></tr>
    <tr><td>IBS municipal</td><td class="n">${pct(m)}</td></tr></tbody></table>`;
}

function syncItemsRG() {
  $$('#rg-items .item').forEach((el, i) => {
    const it = RG.items[i]; if (!it) return;
    it.codigo = $('[name=codigo]', el).value.trim();
    const cl = $('[name=classe]', el).value; if (cl.includes('|')) it.classe = cl;
    it.valor = $('[name=valor]', el).value;
    it.quantidade = $('[name=quantidade]', el).value;
    it.unidade = $('[name=unidade]', el).value;
    it.temIS = $('[name=temIS]', el).checked;
    const ic = $('[name=isClasse]', el)?.value || ''; if (ic.includes('|')) it.isClasse = ic;
    it.isValor = $('[name=isValor]', el)?.value || '';
    it.isAliq = $('[name=isAliq]', el)?.value || '';
  });
}

async function renderItemsRG() {
  const host = $('#rg-items'); if (!host) return;
  const gen = host.dataset.gen = String(Number(host.dataset.gen || 0) + 1);
  const stale = () => !host.isConnected || host.dataset.gen !== gen;
  const ano = Number(RG.data.slice(0, 4));
  host.innerHTML = RG.items.map((it, i) => `
    <div class="item" data-i="${i}">
      <div class="item-head"><h3>Item ${i + 1}</h3>${RG.items.length > 1 ? `<button type="button" class="btn-link btn-danger" data-rm="${i}">Remover</button>` : ''}</div>
      <div class="grid">
        <div class="field"><label>É produto ou serviço?</label>
          <div class="seg" role="group" aria-label="Tipo do item ${i + 1}">
            <button type="button" data-tipo="ncm" class="${it.tipo === 'ncm' ? 'on' : ''}" aria-pressed="${it.tipo === 'ncm'}">Produto (NCM)</button>
            <button type="button" data-tipo="nbs" class="${it.tipo === 'nbs' ? 'on' : ''}" aria-pressed="${it.tipo === 'nbs'}">Serviço (NBS)</button>
          </div></div>
        <div class="field"><label for="cod-${i}">${it.tipo === 'ncm' ? 'Código NCM' : 'Código NBS'}</label>
          <input id="cod-${i}" name="codigo" inputmode="numeric" maxlength="${it.tipo === 'ncm' ? 8 : 9}" placeholder="${it.tipo === 'ncm' ? '8 números' : '9 números'}" value="${esc(it.codigo)}" required>
          <span class="hint" data-desc>${it.tipo === 'ncm' ? 'Ex.: 10063021 (arroz)' : 'Ex.: 122011200 (ensino)'}</span></div>
        <div class="field"><label for="val-${i}">Valor do item</label><div class="money"><input id="val-${i}" name="valor" inputmode="decimal" placeholder="0,00" value="${esc(it.valor)}" required></div></div>
      </div>
      <div class="field" style="margin-top:12px"><label for="cls-${i}">Como é tributado (CST e cClassTrib)</label>
        <select id="cls-${i}" name="classe" required><option>Carregando tabela…</option></select></div>
      <details class="more" ${it.quantidade || it.temIS ? 'open' : ''}><summary>Mais opções (quantidade, Imposto Seletivo)</summary>
        <div class="grid" style="margin-top:8px">
          <div class="field"><label for="qtd-${i}">Quantidade</label><input id="qtd-${i}" name="quantidade" inputmode="decimal" value="${esc(it.quantidade)}"></div>
          <div class="field"><label for="un-${i}">Unidade</label><input id="un-${i}" name="unidade" maxlength="6" placeholder="UN, KG, LT…" value="${esc(it.unidade)}"></div>
        </div>
        <label style="display:flex;gap:10px;align-items:center;margin-top:12px;min-height:44px"><input type="checkbox" name="temIS" style="width:22px;min-height:22px" ${it.temIS && ano >= 2027 ? 'checked' : ''} ${ano >= 2027 ? '' : 'disabled'}> Este item paga Imposto Seletivo (bebida, cigarro, veículo…)</label>
        ${ano >= 2027 ? '' : '<p class="hint">O Imposto Seletivo começa em 2027. Mude a data para usar.</p>'}
        <div class="grid" data-is ${it.temIS ? '' : 'hidden'}>
          <div class="field"><label for="iscls-${i}">Classificação do Imposto Seletivo</label><select id="iscls-${i}" name="isClasse"><option>Carregando…</option></select></div>
          <div class="field"><label for="isv-${i}">Base do Imposto Seletivo</label><div class="money"><input id="isv-${i}" name="isValor" inputmode="decimal" value="${esc(it.isValor)}"></div></div>
          ${ano >= 2027 ? `<div class="field"><label for="isa-${i}">Alíquota do Imposto Seletivo</label><div class="pct"><input id="isa-${i}" name="isAliq" inputmode="decimal" value="${esc(it.isAliq || '10')}"></div></div>` : ''}
        </div>
      </details>
    </div>`).join('');

  host.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { syncItemsRG(); RG.items.splice(Number(b.dataset.rm), 1); renderItemsRG(); }));
  host.querySelectorAll('.item').forEach(el => {
    const i = Number(el.dataset.i);
    el.querySelectorAll('[data-tipo]').forEach(b => b.addEventListener('click', () => { syncItemsRG(); RG.items[i].tipo = b.dataset.tipo; RG.items[i].codigo = ''; renderItemsRG(); }));
    const cod = $('[name=codigo]', el);
    cod.addEventListener('input', () => { cod.value = cod.value.replace(/\D/g, ''); cod.removeAttribute('aria-invalid'); if (cod.value.length === Number(cod.maxLength)) lookupCodigo(el, RG.items[i].tipo, cod.value); });
    if (cod.value.length === Number(cod.maxLength)) lookupCodigo(el, RG.items[i].tipo, cod.value);
    $('[name=valor]', el).addEventListener('input', e => e.target.removeAttribute('aria-invalid'));
    $('[name=temIS]', el).addEventListener('change', e => { $('[data-is]', el).hidden = !e.target.checked; });
  });

  try {
    const [lista, listaIS] = await Promise.all([loadClassTrib(RG.data), loadClassTribIS(RG.data).catch(() => [])]);
    if (stale()) return;
    host.querySelectorAll('.item').forEach(el => {
      const it = RG.items[Number(el.dataset.i)];
      $('[name=classe]', el).innerHTML = classTribOptions(lista, it.classe) || '<option value="">Nenhuma classificação para esta data</option>';
      $('[name=isClasse]', el).innerHTML = classTribOptions(listaIS, it.isClasse) || '<option value="">Sem tabela</option>';
    });
    marcarPreenchidos('regime');
  } catch (e) {
    host.querySelectorAll('[name=classe]').forEach(s => { s.innerHTML = '<option value="">Tabela não carregou</option>'; });
  }
}

/** Busca a descrição do NCM/NBS e mostra embaixo do campo. */
async function lookupCodigo(el, tipo, codigo) {
  const hint = $('[data-desc]', el);
  hint.className = 'hint'; hint.textContent = 'Procurando…';
  try {
    const j = await cached(`${API.regime}/dados-abertos/${tipo}?${tipo}=${codigo}&data=${RG.data}`);
    const partes = [j.posicao, j.subposicao && j.subposicao !== j.posicao ? j.subposicao : null, j.item, j.subitem].filter(Boolean).map(s => String(s).replace(/<[^>]+>/g, '').replace(/\.$/, ''));
    const desc = j.descricao || j.nome || partes.slice(-2).join(' › ') || j.capitulo || 'Código encontrado';
    hint.textContent = '✓ ' + desc + (j.tributadoPeloImpostoSeletivo ? ' · sujeito ao Imposto Seletivo' : ''); hint.className = 'hint ok';
  } catch (e) {
    hint.textContent = e.status === 404 ? `Código não encontrado na tabela ${tipo.toUpperCase()}. Confira os números.` : 'Não deu para conferir agora.';
    hint.className = 'hint bad';
  }
}

/** Valida o formulário, monta o JSON oficial e chama a calculadora. */
async function calcRegime() {
  syncItemsRG();
  const btn = $('#rg-go'), res = $('#rg-res');
  const ano = Number(RG.data.slice(0, 4));
  let erro = null;
  RG.items.forEach((it, i) => {
    const el = $$('#rg-items .item')[i];
    const tam = it.tipo === 'ncm' ? 8 : 9;
    if (it.codigo.length !== tam) { $('[name=codigo]', el).setAttribute('aria-invalid', 'true'); erro = erro || `Item ${i + 1}: o código ${it.tipo.toUpperCase()} precisa ter ${tam} números.`; }
    if (!(parseNum(it.valor) > 0)) { $('[name=valor]', el).setAttribute('aria-invalid', 'true'); erro = erro || `Item ${i + 1}: informe o valor.`; }
  });
  if (!$('#rg-mun').value) erro = erro || 'Escolha o município.';
  if (erro) { toast(erro); return; }

  const aliq = ano >= 2027 ? { cbs: parseNum($('#rg-pcbs').value), ibsEstadual: parseNum($('#rg-puf').value), ibsMunicipal: parseNum($('#rg-pmun').value) } : null;
  const body = {
    id: uid(), versao: '1.0.0',
    dhFatoGerador: `${RG.data}T12:00:00-03:00`,
    municipio: Number($('#rg-mun').value), uf: $('#rg-uf').value,
    itens: RG.items.map((it, i) => {
      const [cst, cClassTrib] = it.classe.split('|');
      const o = { numero: i + 1, [it.tipo]: it.codigo, cst, cClassTrib, baseCalculo: Number(numStr(it.valor)) };
      if (it.quantidade) { o.quantidade = parseNum(it.quantidade); o.unidade = (it.unidade || 'UN').toUpperCase(); }
      if (aliq) o.aliquotasNominais = { ...aliq };
      if (it.temIS && it.isClasse && ano >= 2027) {
        const [iscst, iscls] = it.isClasse.split('|');
        o.impostoSeletivo = { cst: iscst, cClassTrib: iscls, baseCalculo: Number(numStr(it.isValor || it.valor)), quantidade: parseNum(it.quantidade) || 1, unidade: (it.unidade || 'UN').toUpperCase() };
        if (aliq) o.aliquotasNominais.impostoSeletivo = { adValorem: parseNum(it.isAliq || '10') };
        delete o.baseCalculo; // com IS, a base de CBS/IBS é derivada da base do IS + IS
      }
      return o;
    }),
  };

  busy(btn, true); $('#st2').classList.add('on');
  res.innerHTML = '<div class="card result"><div class="skel"></div><div class="skel" style="width:70%"></div><div class="skel" style="width:40%"></div></div>';
  try {
    const out = await postJSON(`${API.regime}/observabilidade/regime-geral`, body);
    RG.munNome = $('#rg-mun').selectedOptions[0]?.text || String(body.municipio);
    const r = reportRegime(body, out);
    Hist.add(r); $('#st3').classList.add('on');
    showResult(res, r);
  } catch (e) { showError(res, e.message, calcRegime); }
  finally { busy(btn, false); }
}

/** A memória de cálculo vem como texto ou como {cbs, ibsUF, ibsMun}. */
function memoTxt(m, rotulo) {
  if (!m) return '';
  if (typeof m === 'string') return `  ${rotulo ? rotulo + ': ' : ''}${m}`;
  const nomes = { cbs: 'CBS', ibs: 'IBS', ibsUF: 'IBS estadual', ibsMun: 'IBS municipal' };
  return Object.entries(m).map(([k, v]) => `  ${nomes[k] || k}: ${v}`).join('\n');
}

const ESTADO = {
  CALCULADO: 'Calculado', CALCULO_SIMULADO: 'Calculado (simulação)', INCONSISTENCIA_ENTRADA: 'Dado errado',
  NAO_IMPLEMENTADO: 'Ainda não calculado pela Receita', FALHA_TECNICA: 'Falha técnica', NAO_CALCULADO: 'Não calculado',
};

/** Transforma a resposta da Receita num relatório legível. */
function reportRegime(body, out) {
  const objs = out.objetos || [];
  const tot = out.total?.tribCalc || {};
  const vCBS = Number(tot.IBSCBSTot?.gCBS?.vCBS ?? 0);
  const vIBS = Number(tot.IBSCBSTot?.gIBS?.vIBS ?? 0);
  const vIS = Number(tot.ISTot?.vIS ?? 0);
  const vBC = Number(tot.IBSCBSTot?.vBCIBSCBS ?? 0);
  const rows = [], raw = [], memos = [], alerts = [];
  let comErro = 0;
  objs.forEach(o => {
    const it = body.itens[(o.nObj || 1) - 1] || {};
    const g = o.tribCalc?.IBSCBS?.gIBSCBS || {};
    const isg = o.tribCalc?.IS || {};
    const cod = it.ncm ? `NCM ${it.ncm}` : `NBS ${it.nbs}`;
    if (o.erros?.length) { comErro++; o.erros.forEach(er => alerts.push({ type: 'err', title: `Item ${o.nObj}: ${er.title || er.code}`, text: ' ' + (er.detail || '') })); }
    const red = g.gCBS?.gRed?.pRedAliq;
    const line = [o.nObj, cod, `${it.cst}/${it.cClassTrib}`, ESTADO[o.estadoItem] || o.estadoItem, g.vBC, g.gCBS?.pCBS, red, g.gCBS?.vCBS, g.vIBS, isg.vIS];
    raw.push(line.map(v => v == null ? '' : String(v).replace('.', ',')));
    rows.push([line[0], line[1], line[2], line[3], g.vBC != null ? money(g.vBC) : '—', g.gCBS?.gRed?.pAliqEfet != null ? pct(g.gCBS.gRed.pAliqEfet) : g.gCBS?.pCBS != null ? pct(g.gCBS.pCBS) : '—', red != null ? pct(red) : '—', g.gCBS?.vCBS != null ? money(g.gCBS.vCBS) : '—', g.vIBS != null ? money(g.vIBS) : '—', isg.vIS != null ? money(isg.vIS) : '—']);
    const memo = [memoTxt(o.tribCalc?.IBSCBS?.memoriaCalculo), memoTxt(isg.memoriaCalculo, 'IS')].filter(Boolean).join('\n');
    if (memo) memos.push(`Item ${o.nObj}\n${memo}`);
  });
  if (objs.some(o => o.estadoItem === 'CALCULO_SIMULADO')) alerts.unshift({ type: 'info', title: 'Cálculo de simulação', text: ' Os valores usam alíquotas de teste ou informadas por você. Servem para planejar, não para recolher.' });
  const total = vCBS + vIBS + vIS;
  return {
    kind: 'regime', when: Date.now(),
    title: `${body.itens.length} item(ns) · ${RG.munNome || ''}/${body.uf} · ${fmtData(body.dhFatoGerador)}`,
    resultTitle: 'Tributos da operação',
    status: comErro === objs.length && objs.length ? 'err' : comErro ? 'warn' : 'ok',
    statusText: comErro ? `${comErro} item(ns) com erro` : 'Todos os itens calculados',
    meta: [['Data do fato gerador', fmtData(body.dhFatoGerador)], ['Local', `${RG.munNome || body.municipio}/${body.uf} (IBGE ${body.municipio})`], ['Itens', String(body.itens.length)]],
    tiles: [['Base de cálculo', money(vBC), vBC], ['CBS', money(vCBS), vCBS], ['IBS', money(vIBS), vIBS], ['Imposto Seletivo', money(vIS), vIS], ['Total de tributos', money(total), total]],
    headline: { label: 'Total', raw: total.toFixed(2) },
    columns: ['Item', 'Código', 'CST/cClassTrib', 'Situação', 'Base', 'Alíq. efetiva CBS', 'Redução', 'CBS', 'IBS', 'IS'],
    numCols: [4, 5, 6, 7, 8, 9],
    rows, rowsRaw: raw, alerts,
    memo: memos.join('\n\n'),
    notes: ['Totais somam só os itens calculados.', 'Cálculo feito pela calculadora oficial da Receita Federal (regime regular).'],
    input: body,
  };
}

/* ---------- Simples Nacional ---------- */

const SN = { items: [] };
const ANEXO_NOME = { 1: 'Anexo I (comércio)', 2: 'Anexo II (indústria)', 3: 'Anexo III (serviços)', 4: 'Anexo IV (serviços)', 5: 'Anexo V (serviços)' };

/** Atividades do Simples vigentes na data. */
async function loadAtividades(data) { return cached(`${API.simples}/simples-nacional/atividades?data=${data}`); }
function ativCodigo(a) { return a.codigo; }
function ativDesc(a) { return a.descricao ?? ''; }
/** Anexos (1 a 5) ligados à atividade: sem e com fator "r". */
function ativAnexos(a) {
  const n = { I: 1, II: 2, III: 3, IV: 4, V: 5 };
  return [...new Set([a.anexoSemFatorR, a.anexoComFatorR].map(x => n[x]).filter(Boolean))];
}
/** Atividade pode ser usada neste tipo de nota? */
function ativServe(a, doc) { return !a.tpDocsAdmissiveis || a.tpDocsAdmissiveis.includes(doc); }
const SN_INICIO = '2027-01-01'; // o Simples entra no cálculo de CBS/IBS em 2027

function novoItemSN(over = {}) { return { atividade: '', classe: '000001', tipo: 'ncm', codigo: '', valor: '', vis: '', ...over }; }

function viewSimples() {
  VIEW++;
  if (!SN.items.length) SN.items = [novoItemSN()];
  SN.data = SN.data || (hoje() < SN_INICIO ? SN_INICIO : hoje());
  SN.doc = SN.doc || '55';
  main.innerHTML = `
  <div class="page-head">
    <div><div class="crumb"><a href="#/">Início</a> › Simples Nacional</div>
    <h1>Simples Nacional</h1>
    <p>Escolha a atividade e informe as alíquotas efetivas que aparecem no PGDAS. O programa separa a CBS e o IBS de cada item.</p></div>
    <button class="btn-link" id="sn-ex" type="button">Preencher com exemplo</button>
  </div>
  <div class="layout">
    <div>
      ${assistenteHTML('simples')}
      <form class="card" id="sn-form" novalidate>
        <ol class="steps" aria-label="Etapas"><li class="on" id="sst1"><b>1</b>Empresa</li><li id="sst2"><b>2</b>Itens</li><li id="sst3"><b>3</b>Resultado</li></ol>
        <fieldset>
          <legend>Sobre a empresa e a nota</legend>
          <div class="grid">
            <div class="field"><label for="sn-data">Data da venda</label><input type="date" id="sn-data" value="${SN.data}" min="${SN_INICIO}"><span class="hint">O Simples passa a destacar CBS e IBS a partir de 2027.</span></div>
            <div class="field"><label for="sn-doc">Tipo de nota</label><select id="sn-doc">
              <option value="55" ${SN.doc === '55' ? 'selected' : ''}>NF-e (venda de produto)</option>
              <option value="65" ${SN.doc === '65' ? 'selected' : ''}>NFC-e (cupom ao consumidor)</option>
              <option value="91" ${SN.doc === '91' ? 'selected' : ''}>NFS-e (serviço)</option></select></div>
            <div class="field"><label for="sn-crt">Situação no Simples</label><select id="sn-crt">
              <option value="1">Optante do Simples (ME/EPP)</option>
              <option value="2">Passou do sublimite de receita</option></select></div>
          </div>
        </fieldset>
        <fieldset>
          <legend>Alíquotas efetivas do PGDAS</legend>
          <p class="legend-help">Copie do extrato do PGDAS a linha de CBS e IBS do anexo da sua atividade. Use vírgula ou ponto.</p>
          <div class="grid">
            <div class="field"><label for="sn-pcbs">Alíquota efetiva CBS</label><div class="pct"><input id="sn-pcbs" inputmode="decimal" placeholder="Ex.: 1,1612" value="${esc(SN.pcbs || '')}"></div></div>
            <div class="field"><label for="sn-pibs">Alíquota efetiva IBS</label><div class="pct"><input id="sn-pibs" inputmode="decimal" placeholder="Ex.: 0,0129" value="${esc(SN.pibs || '')}"></div></div>
          </div>
          <details class="more"><summary>Mais opções (fator "r", sublimite, compra pública)</summary>
            <div class="grid" style="margin-top:8px">
              <div class="field"><label for="sn-fr">Fator "r" (só atividade 09)</label><select id="sn-fr"><option value="false">Menor que 28% (Anexo V)</option><option value="true">28% ou mais (Anexo III)</option></select></div>
              <div class="field"><label for="sn-gov">Venda para governo?</label><select id="sn-gov"><option value="">Não</option><option value="1">União</option><option value="2">Estado</option><option value="3">Distrito Federal</option><option value="4">Município</option></select></div>
            </div>
          </details>
        </fieldset>
        <fieldset>
          <legend>Itens</legend>
          <p class="legend-help" id="sn-items-help"></p>
          <div id="sn-items"></div>
          <button type="button" class="btn btn-ghost" id="sn-add">+ Adicionar item</button>
        </fieldset>
        <div class="sticky-cta"><button class="btn btn-primary" id="sn-go" type="submit">Calcular CBS e IBS</button></div>
      </form>
      <div id="sn-res"></div>
    </div>
    <aside class="aside">
      <div class="card"><h3>Atividades do Simples</h3><p class="crumb">Lista oficial vigente na data escolhida.</p><div id="sn-ativ"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div></div>
    </aside>
  </div>`;
  bindSimples();
  ligarAssistente('simples');
}

async function bindSimples() {
  const v = VIEW;
  const dataEl = $('#sn-data'), docEl = $('#sn-doc');
  const reload = async () => {
    if (dataEl.value < SN_INICIO) { dataEl.value = SN_INICIO; toast('O Simples só entra no cálculo em 2027. Usamos 01/01/2027.'); }
    syncItemsSN();
    SN.data = dataEl.value; SN.doc = docEl.value;
    if (SN.doc === '91' && SN.items.length > 1) { SN.items = SN.items.slice(0, 1); toast('A NFS-e aceita só 1 item.'); }
    if (SN.doc === '91') SN.items.forEach(i => { i.tipo = 'nbs'; });
    $('#sn-add').hidden = SN.doc === '91';
    $('#sn-crt').closest('.field').hidden = SN.doc === '91';
    $('#sn-items-help').textContent = SN.doc === '91' ? 'Na NFS-e vai 1 serviço por nota.' : 'Um item para cada produto ou serviço.';
    await renderItemsSN(); renderAtivList();
  };
  dataEl.addEventListener('change', reload);
  docEl.addEventListener('change', reload);
  $('#sn-add').addEventListener('click', () => { syncItemsSN(); SN.items.push(novoItemSN()); renderItemsSN(); });
  $('#sn-ex').addEventListener('click', () => {
    SN.data = '2027-03-15'; SN.doc = '55'; SN.pcbs = '1,1612'; SN.pibs = '0,0129';
    SN.items = [novoItemSN({ atividade: '01', classe: '000001', tipo: 'ncm', codigo: '22030000', valor: '950,00', vis: '50,00' })];
    viewSimples(); toast('Exemplo preenchido: comércio vendendo R$ 950,00.');
  });
  $('#sn-form').addEventListener('submit', e => { e.preventDefault(); calcSimples(); });
  if (v === VIEW) await reload();
}

async function renderAtivList() {
  const box = $('#sn-ativ'); if (!box) return;
  try {
    const lista = await loadAtividades(SN.data);
    box.innerHTML = `<div class="table-wrap" style="max-height:460px;overflow:auto"><table><thead><tr><th>Cód.</th><th>Atividade</th><th>Anexo</th></tr></thead><tbody>
      ${lista.map(a => `<tr style="${ativServe(a, SN.doc) ? '' : 'opacity:.45'}"><td>${esc(ativCodigo(a))}</td><td style="white-space:normal;min-width:150px">${esc(ativDesc(a))}</td><td>${esc(a.rotuloAnexo || '—')}</td></tr>`).join('')}
    </tbody></table></div><p class="hint" style="margin-top:8px">Em cinza: atividades que não cabem no tipo de nota escolhido.</p>`;
  } catch (e) { box.innerHTML = `<p class="hint bad">Não carregou a lista: ${esc(e.message)}</p>`; }
}

function syncItemsSN() {
  SN.pcbs = $('#sn-pcbs')?.value; SN.pibs = $('#sn-pibs')?.value;
  $$('#sn-items .item').forEach((el, i) => {
    const it = SN.items[i]; if (!it) return;
    const at = $('[name=atividade]', el).value, cl = $('[name=classe]', el).value;
    if (/^\d+$/.test(at)) it.atividade = at;
    if (/^\d{6}$/.test(cl)) it.classe = cl;
    it.codigo = $('[name=codigo]', el).value.trim(); it.valor = $('[name=valor]', el).value; it.vis = $('[name=vis]', el)?.value || '';
  });
}

async function renderItemsSN() {
  const host = $('#sn-items'); if (!host) return;
  const gen = host.dataset.gen = String(Number(host.dataset.gen || 0) + 1);
  const stale = () => !host.isConnected || host.dataset.gen !== gen;
  const nfse = SN.doc === '91';
  host.innerHTML = SN.items.map((it, i) => `
    <div class="item" data-i="${i}">
      <div class="item-head"><h3>Item ${i + 1}</h3>${SN.items.length > 1 ? `<button type="button" class="btn-link btn-danger" data-rm="${i}">Remover</button>` : ''}</div>
      <div class="field"><label for="sat-${i}">Atividade no Simples</label><select id="sat-${i}" name="atividade"><option>Carregando…</option></select><span class="hint" data-anexo></span></div>
      <div class="grid" style="margin-top:12px">
        ${nfse ? '' : `<div class="field"><label>É produto ou serviço?</label><div class="seg" role="group" aria-label="Tipo do item ${i + 1}">
          <button type="button" data-tipo="ncm" class="${it.tipo === 'ncm' ? 'on' : ''}" aria-pressed="${it.tipo === 'ncm'}">Produto (NCM)</button>
          <button type="button" data-tipo="nbs" class="${it.tipo === 'nbs' ? 'on' : ''}" aria-pressed="${it.tipo === 'nbs'}">Serviço (NBS)</button></div></div>`}
        <div class="field"><label for="scod-${i}">${it.tipo === 'ncm' ? 'Código NCM' : 'Código NBS'} <span class="hint">(opcional em alguns casos)</span></label>
          <input id="scod-${i}" name="codigo" inputmode="numeric" maxlength="${it.tipo === 'ncm' ? 8 : 9}" value="${esc(it.codigo)}"></div>
        <div class="field"><label for="sval-${i}">Valor do item</label><div class="money"><input id="sval-${i}" name="valor" inputmode="decimal" placeholder="0,00" value="${esc(it.valor)}"></div><span class="hint">Produto + frete + seguro + outros − desconto</span></div>
      </div>
      <div class="field" style="margin-top:12px"><label for="scls-${i}">Como é tributado (cClassTrib)</label><select id="scls-${i}" name="classe"><option>Carregando tabela…</option></select></div>
      ${nfse ? '' : `<details class="more" ${parseNum(it.vis) > 0 ? 'open' : ''}><summary>Mais opções (Imposto Seletivo)</summary>
        <div class="grid" style="margin-top:8px"><div class="field"><label for="svis-${i}">Imposto Seletivo já calculado</label><div class="money"><input id="svis-${i}" name="vis" inputmode="decimal" placeholder="0,00" value="${esc(it.vis)}"></div></div></div></details>`}
    </div>`).join('');

  host.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { syncItemsSN(); SN.items.splice(Number(b.dataset.rm), 1); renderItemsSN(); }));
  host.querySelectorAll('.item').forEach(el => {
    const i = Number(el.dataset.i);
    el.querySelectorAll('[data-tipo]').forEach(b => b.addEventListener('click', () => { syncItemsSN(); SN.items[i].tipo = b.dataset.tipo; SN.items[i].codigo = ''; renderItemsSN(); }));
    const cod = $('[name=codigo]', el); cod.addEventListener('input', () => { cod.value = cod.value.replace(/\D/g, ''); });
    $('[name=valor]', el).addEventListener('input', e => e.target.removeAttribute('aria-invalid'));
  });

  try {
    const [ativs, classes] = await Promise.all([loadAtividades(SN.data), loadClassTrib(SN.data, nfse ? 'NFSe' : 'NFe')]);
    if (stale()) return;
    SN.ativs = ativs;
    host.querySelectorAll('.item').forEach(el => {
      const it = SN.items[Number(el.dataset.i)];
      const sel = $('[name=atividade]', el);
      const validas = ativs.filter(a => ativServe(a, SN.doc));
      if (!validas.some(a => ativCodigo(a) === it.atividade)) it.atividade = ativCodigo(validas[0] || {});
      sel.innerHTML = validas.map(a => `<option value="${esc(ativCodigo(a))}" ${ativCodigo(a) === it.atividade ? 'selected' : ''}>${esc(ativCodigo(a))} — ${esc(String(ativDesc(a)).slice(0, 100))}</option>`).join('');
      const showAnexo = () => {
        const a = ativs.find(x => ativCodigo(x) === sel.value); const ax = a ? ativAnexos(a) : [];
        $('[data-anexo]', el).textContent = !ax.length ? 'Operação não tributada pelo Simples.' : a.sujeitaFatorR ? `Anexo V, ou Anexo III se o fator "r" for 28% ou mais (veja Mais opções).` : 'Tributada no ' + ax.map(n => ANEXO_NOME[n]).join(' ou ') + '.';
      };
      sel.addEventListener('change', showAnexo); showAnexo();
      const opts = (classes || []).flatMap(c => (c.classificacoesTributarias || c.classificacoes || []).map(x => [x.codigo ?? x.cClassTrib, x.descricao ?? '']));
      $('[name=classe]', el).innerHTML = opts.map(([c, d]) => `<option value="${esc(c)}" ${c === it.classe ? 'selected' : ''}>${esc(c)} — ${esc(String(d).slice(0, 90))}</option>`).join('');
    });
    marcarPreenchidos('simples');
  } catch (e) { showError($('#sn-res'), e.message, viewSimples); }
}

/** Monta a linha de alíquotas efetivas para os anexos usados. */
function aliquotasEfetivasSN(anexos) {
  const par = { pCBSSN: numStr(SN.pcbs, 4), pIBSSN: numStr(SN.pibs, 4) };
  const nome = { 1: 'anexoI', 2: 'anexoII', 3: 'anexoIII', 4: 'anexoIV', 5: 'anexoV' };
  const o = { fatorR: $('#sn-fr').value === 'true', impedimentoSublimite: $('#sn-crt').value === '2' && SN.doc !== '91' };
  (anexos.length ? anexos : [1, 2, 3, 4, 5]).forEach(n => { o[nome[n]] = { ...par }; });
  return o;
}

async function calcSimples() {
  syncItemsSN();
  const btn = $('#sn-go'), res = $('#sn-res');
  let erro = null;
  if (!(parseNum(SN.pcbs) >= 0) || SN.pcbs === '') { $('#sn-pcbs').setAttribute('aria-invalid', 'true'); erro = 'Informe a alíquota efetiva da CBS (está no PGDAS).'; }
  if (SN.pibs === '' || !(parseNum(SN.pibs) >= 0)) { $('#sn-pibs').setAttribute('aria-invalid', 'true'); erro = erro || 'Informe a alíquota efetiva do IBS (está no PGDAS).'; }
  SN.items.forEach((it, i) => { if (!(parseNum(it.valor) > 0)) { $$('#sn-items [name=valor]')[i].setAttribute('aria-invalid', 'true'); erro = erro || `Item ${i + 1}: informe o valor.`; } });
  if (erro) { toast(erro); return; }

  const anexos = [...new Set(SN.items.flatMap(it => { const a = (SN.ativs || []).find(x => ativCodigo(x) === it.atividade); return a ? ativAnexos(a) : []; }))];
  const nfse = SN.doc === '91';
  const body = {
    id: uid(), versao: '3.0.0', data: SN.data, tpDoc: SN.doc,
    ...(nfse ? { opSimpNac: '3', regApIBSCBSSN: '1', regApTribSN: '1' } : { CRT: $('#sn-crt').value }),
    ...($('#sn-gov').value ? { tpEnteGov: $('#sn-gov').value } : {}),
    aliquotasEfetivas: aliquotasEfetivasSN(anexos),
    itens: SN.items.map((it, i) => {
      const o = { numero: i + 1, cAtivSN: it.atividade, cClassTrib: it.classe, baseCalculo: numStr(it.valor) };
      if (it.codigo) o[it.tipo] = it.codigo;
      if (nfse) { o.tribISSQN = '1'; o.tpRetISSQN = '1'; } else o.valorImpostoSeletivo = numStr(it.vis || '0') || '0.00';
      return o;
    }),
  };

  busy(btn, true); $('#sst2').classList.add('on');
  res.innerHTML = '<div class="card result"><div class="skel"></div><div class="skel" style="width:70%"></div></div>';
  try {
    const out = await postJSON(`${API.simples}/observabilidade/simples-nacional/nao-assistido`, body);
    const r = reportSimples(body, out);
    Hist.add(r); $('#sst3').classList.add('on');
    showResult(res, r);
  } catch (e) { showError(res, e.message, calcSimples); }
  finally { busy(btn, false); }
}

function reportSimples(body, out) {
  const objs = out.objetos || [];
  const alerts = [], rows = [], raw = [], memos = [];
  let comErro = 0;
  const errList = e => (Array.isArray(e) ? e : []);
  errList(out.erros).forEach(er => alerts.push({ type: 'err', title: er.title || er.code || 'Erro', text: ' ' + (er.detail || '') }));
  const resol = out.resolucaoAliquotas || {};
  [...(resol.avisos || []), ...(resol.itens || []).flatMap(i => i.avisos || [])].forEach(a => alerts.push({ type: 'warn', title: 'Aviso', text: ' ' + (a.detail || a.mensagem || a.title || a) }));
  objs.forEach((o, idx) => {
    const n = o.nObj ?? idx + 1;
    const it = body.itens[n - 1] || {};
    const tc = o.tribCalc || {};
    const ax = (resol.itens || []).find(i => i.numero === n)?.anexoAplicado;
    if (errList(o.erros).length) { comErro++; o.erros.forEach(er => alerts.push({ type: 'err', title: `Item ${n}: ${er.title || er.code}`, text: ' ' + (er.detail || '') })); }
    const line = [n, it.cAtivSN, ax ? `Anexo ${ax}` : '', it.cClassTrib, ESTADO[o.estadoItem] || o.estadoItem || '', tc.vRBSNitem, tc.pCBSSN, tc.vCBSSN, tc.pIBSSN, tc.vIBSSN, tc.IS?.valor];
    raw.push(line.map(v => v == null ? '' : String(v).replace('.', ',')));
    rows.push([n, it.cAtivSN, line[2] || '—', it.cClassTrib, line[4], tc.vRBSNitem != null ? money(tc.vRBSNitem) : '—', tc.pCBSSN != null ? pct(tc.pCBSSN) : '—', tc.vCBSSN != null ? money(tc.vCBSSN) : '—', tc.pIBSSN != null ? pct(tc.pIBSSN) : '—', tc.vIBSSN != null ? money(tc.vIBSSN) : '—', tc.IS?.valor != null ? money(tc.IS.valor) : '—']);
    if (tc.memoriaCalculo) memos.push(`Item ${n}\n${memoTxt(tc.memoriaCalculo)}`);
  });
  const t = out.total || {};
  const tBase = Number(t.vRBSNtot ?? 0), tCBS = Number(t.vCBSSNtot ?? 0), tIBS = Number(t.vIBSSNtot ?? 0), tIS = Number(t.totalIs ?? 0);
  const total = tCBS + tIBS;
  return {
    kind: 'simples', when: Date.now(),
    title: `${body.itens.length} item(ns) · ${{ 55: 'NF-e', 65: 'NFC-e', 91: 'NFS-e' }[body.tpDoc]} · ${fmtData(body.data)}`,
    resultTitle: 'CBS e IBS no Simples Nacional',
    status: (errList(out.erros).length || (comErro && comErro === objs.length)) ? 'err' : comErro ? 'warn' : 'ok',
    statusText: errList(out.erros).length ? 'Operação com erro' : comErro ? `${comErro} item(ns) com erro` : 'Todos os itens calculados',
    meta: [['Data', fmtData(body.data)], ['Documento', { 55: 'NF-e', 65: 'NFC-e', 91: 'NFS-e' }[body.tpDoc]], ['Alíquota efetiva CBS', pct(parseNum(SN.pcbs))], ['Alíquota efetiva IBS', pct(parseNum(SN.pibs))]],
    tiles: [['Receita bruta', money(tBase), tBase], ['CBS', money(tCBS), tCBS], ['IBS', money(tIBS), tIBS], ...(tIS ? [['Imposto Seletivo', money(tIS), tIS]] : []), ['Total CBS + IBS', money(total), total]],
    headline: { label: 'Total', raw: total.toFixed(2) },
    columns: ['Item', 'Atividade', 'Anexo', 'cClassTrib', 'Situação', 'Receita', 'Alíq. CBS', 'CBS', 'Alíq. IBS', 'IBS', 'IS'],
    numCols: [5, 6, 7, 8, 9, 10], rows, rowsRaw: raw, alerts, memo: memos.join('\n\n'),
    notes: ['Cálculo feito pela calculadora oficial da Receita Federal (Simples Nacional, cálculo não assistido).'],
    input: body, raw: out,
  };
}

/* ---------- DANFSe ---------- */

function viewDanfse() {
  main.innerHTML = `
  <div class="page-head">
    <div><div class="crumb"><a href="#/">Início</a> › PDF da NFS-e</div>
    <h1>PDF da nota de serviço (DANFSe)</h1>
    <p>Envie o XML da NFS-e e baixe o PDF no modelo oficial, com QR Code de consulta.</p></div>
    <button class="btn-link" id="df-ex" type="button">Usar XML de exemplo</button>
  </div>
  <div class="layout">
    <div>
      <form class="card" id="df-form" novalidate>
        <ol class="steps" aria-label="Etapas"><li class="on"><b>1</b>Enviar XML</li><li id="dst2"><b>2</b>Baixar PDF</li></ol>
        <label class="drop" id="df-drop" for="df-file">
          <strong>Arraste o arquivo .xml aqui</strong>
          <small>ou toque para escolher no aparelho · até 5 MB</small>
          <input type="file" id="df-file" accept=".xml,text/xml,application/xml" hidden>
        </label>
        <div id="df-pill"></div>
        <details class="more"><summary>Opções do PDF</summary>
          <div class="grid" style="margin-top:8px">
            <div class="field"><label for="df-stc">Situação da nota</label><select id="df-stc"><option value="0">Válida</option><option value="1">Substituída</option><option value="2">Cancelada</option></select></div>
            <div class="field"><label for="df-can">Canhoto de recebimento</label><select id="df-can"><option value="true">Mostrar</option><option value="false">Esconder</option></select></div>
          </div>
          <div class="field" style="margin-top:12px"><label for="df-xml">Ou cole o XML aqui</label><textarea id="df-xml" spellcheck="false" placeholder="&lt;NFSe ..."></textarea></div>
        </details>
        <div class="sticky-cta"><button class="btn btn-primary" id="df-go" type="submit" disabled>Gerar PDF</button></div>
      </form>
      <div id="df-res"></div>
    </div>
    <aside class="aside"><div class="card"><h3>Dicas</h3><ul>
      <li>Use o XML da <b>nota autorizada</b> (o que começa com &lt;NFSe&gt;), não o da DPS.</li>
      <li>Nada é guardado no servidor: o arquivo só é lido para montar o PDF.</li>
      <li>Nota cancelada? Escolha “Cancelada” em Opções do PDF para sair a tarja.</li>
    </ul></div></aside>
  </div>`;
  const state = { xml: '', nome: '' };
  const go = $('#df-go'), drop = $('#df-drop'), file = $('#df-file'), ta = $('#df-xml');
  const setXML = (xml, nome) => {
    state.xml = xml; state.nome = nome;
    const okXml = /<NFSe[\s>]/.test(xml);
    $('#df-pill').innerHTML = xml ? `<span class="filepill">${okXml ? '✓' : '!'} ${esc(nome)} · ${(xml.length / 1024).toFixed(1)} KB</span>${okXml ? '' : '<p class="hint bad">Este arquivo não parece uma NFS-e (falta a tag &lt;NFSe&gt;).</p>'}` : '';
    go.disabled = !okXml;
  };
  const readFile = f => {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast('Arquivo maior que 5 MB.'); return; }
    f.text().then(t => setXML(t, f.name));
  };
  file.addEventListener('change', () => readFile(file.files[0]));
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => readFile(e.dataTransfer.files[0]));
  ta.addEventListener('input', () => setXML(ta.value.trim(), 'XML colado'));
  $('#df-ex').addEventListener('click', async () => { const t = await (await fetch('sample-nfse.xml')).text(); setXML(t, 'nfse-exemplo.xml'); toast('XML de exemplo carregado. Toque em Gerar PDF.'); });

  $('#df-form').addEventListener('submit', async e => {
    e.preventDefault(); if (!state.xml) return;
    const res = $('#df-res'); busy(go, true, 'Gerando PDF…');
    try {
      const url = `${API.danfse}?stc=${$('#df-stc').value}&canhoto=${$('#df-can').value}`;
      const r = await http(url, { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: state.xml, timeout: 45000 });
      const blob = await r.blob();
      const nNota = (state.xml.match(/<nNFSe>(\d+)<\/nNFSe>/) || [])[1] || '';
      const emit = (state.xml.match(/<emit>[\s\S]*?<xNome>([^<]+)<\/xNome>/) || [])[1] || '';
      const vliq = (state.xml.match(/<vLiq>([\d.]+)<\/vLiq>/) || [])[1];
      const nome = `DANFSe-${nNota || 'nota'}.pdf`;
      const href = URL.createObjectURL(blob);
      download(nome, blob);
      const rep = { kind: 'danfse', when: Date.now(), title: `NFS-e ${nNota || ''} · ${emit}`.trim(), status: 'ok', statusText: 'PDF gerado', headline: vliq ? { raw: Number(vliq).toFixed(2) } : null, meta: [['Arquivo', state.nome], ['Nota', nNota], ['Prestador', emit], ['Valor líquido', vliq ? money(vliq) : '—']] };
      Hist.add(rep);
      $('#dst2').classList.add('on');
      res.innerHTML = `<section class="card result" id="resultado" tabindex="-1">
        <div class="notice ok"><div><b>Pronto! O PDF foi baixado.</b> Se o download não começou, use o botão abaixo.</div></div>
        <div class="tiles"><div class="tile"><span>Nota</span><strong>${esc(nNota || '—')}</strong></div><div class="tile"><span>Prestador</span><strong style="font-size:1rem">${esc(emit || '—')}</strong></div><div class="tile main"><span>Valor líquido</span><strong>${vliq ? money(vliq) : '—'}</strong></div></div>
        <div class="actions"><a class="btn btn-primary" href="${href}" download="${esc(nome)}">${ICONS.pdf} Baixar de novo</a><a class="btn btn-ghost" href="${href}" target="_blank" rel="noopener">Abrir PDF</a><button class="btn-link" type="button" id="df-new">Gerar outro</button></div>
      </section>`;
      $('#toast').classList.remove('show');
      $('#df-new').addEventListener('click', viewDanfse);
      $('#resultado').scrollIntoView({ behavior: 'smooth' });
    } catch (err) { showError(res, err.message, () => $('#df-form').requestSubmit()); }
    finally { busy(go, false); }
  });
}

/* ---------- Histórico ---------- */

function viewHistorico() {
  const filtro = sessionStorage.getItem('rtc.filtro') || '';
  const all = Hist.all();
  const list = filtro ? all.filter(r => r.kind === filtro) : all;
  main.innerHTML = `
  <div class="page-head"><div><div class="crumb"><a href="#/">Início</a> › Histórico</div>
    <h1>Histórico de cálculos</h1><p>Fica guardado só neste aparelho. Toque num cálculo para ver de novo, baixar o PDF ou a planilha.</p></div></div>
  <div class="hist-tools">
    <label for="h-f" class="crumb" style="margin:0">Mostrar</label>
    <select id="h-f"><option value="">Todos (${all.length})</option>
      ${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}" ${filtro === k ? 'selected' : ''}>${v} (${all.filter(r => r.kind === k).length})</option>`).join('')}</select>
    ${list.length ? `<button class="btn btn-ghost" id="h-csv">${ICONS.pdf} Baixar planilha do histórico</button>` : ''}
    ${all.length ? `<button class="btn-link btn-danger" id="h-clear" style="margin-left:auto">Apagar histórico</button>` : ''}
  </div>
  <div id="h-detail"></div>
  ${list.length ? `<div class="hist-list">${list.map(r => `
    <div class="hist-row">
      <span class="kind ${r.kind}">${KIND_LABEL[r.kind]}</span>
      <div><div>${esc(r.title)}</div><div class="when">${fmtQuando(r.when)} · ${esc(r.statusText || '')}</div></div>
      <span class="val">${r.headline && r.headline.raw != null ? money(r.headline.raw) : ''}</span>
      <div class="actions" style="margin:0">${r.kind === 'danfse' ? '' : `<button class="btn btn-ghost" data-open="${r.id}">Ver</button>`}<button class="btn-link btn-danger" data-del="${r.id}" aria-label="Apagar este cálculo">Apagar</button></div>
    </div>`).join('')}</div>`
    : `<div class="card empty"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><h2>Nenhum cálculo ainda</h2><p>Quando você calcular algo, ele aparece aqui.</p><a class="btn btn-primary" href="#/">Fazer o primeiro cálculo</a></div>`}`;
  $('#h-f').addEventListener('change', e => { sessionStorage.setItem('rtc.filtro', e.target.value); viewHistorico(); });
  $('#h-csv')?.addEventListener('click', () => exportHistCSV(list));
  $('#h-clear')?.addEventListener('click', () => { if (confirm('Apagar todos os cálculos deste aparelho? Não dá para desfazer.')) { Hist.clear(); viewHistorico(); toast('Histórico apagado.'); } });
  $$('[data-del]').forEach(b => b.addEventListener('click', () => { Hist.remove(b.dataset.del); viewHistorico(); toast('Cálculo apagado.'); }));
  $$('[data-open]').forEach(b => b.addEventListener('click', () => {
    const r = Hist.get(b.dataset.open); const host = $('#h-detail');
    host.innerHTML = resultHTML(r, { fromHistory: true }); bindResult(host, r);
    host.querySelector('#resultado').scrollIntoView({ behavior: 'smooth' });
  }));
}

/* ---------- ajuda "?" em cada campo (funciona sem IA) ---------- */

/** Explicação simples de cada campo, ligada pelo id do campo. */
const AJUDA = {
  'rg-data': ['Data da venda', 'É o dia em que a venda ou o serviço aconteceu (o "fato gerador"). Normalmente é a data de emissão da nota. A data decide quais regras e alíquotas valem.'],
  'rg-uf': ['Estado', 'O estado onde a operação acontece para fins de IBS. Na venda de produto, em geral é o estado de quem compra (destino).'],
  'rg-mun': ['Município', 'A cidade de destino da operação. Ela define a parte municipal do IBS, que substitui o ISS.'],
  'rg-pcbs': ['Alíquota da CBS', 'CBS é a contribuição federal que substitui PIS e Cofins. De 2027 em diante a calculadora pede a alíquota. Deixamos o valor de teste oficial.'],
  'rg-puf': ['IBS estadual', 'Parte do IBS que fica com o estado. Substitui o ICMS aos poucos. Use o valor que o estado publicar.'],
  'rg-pmun': ['IBS municipal', 'Parte do IBS que fica com o município. Substitui o ISS aos poucos.'],
  'tipo': ['Produto ou serviço?', 'Produto (mercadoria física) usa o código NCM. Serviço usa o código NBS. Se a nota é de serviço (NFS-e), quase sempre é NBS.'],
  'ncm': ['Código NCM', 'NCM é o código do produto, com 8 números. Está na nota de compra do fornecedor, no cadastro do produto no seu sistema ou no XML da NF-e (campo NCM). Ex.: arroz branco 10063021.'],
  'nbs': ['Código NBS', 'NBS é o código do serviço, com 9 números. Ex.: pré-escola 122011200. Se não souber, descreva o serviço para o assistente.'],
  'valor': ['Valor do item', 'Quanto custou o item na nota: preço × quantidade, mais frete, seguro e outras despesas, menos descontos.'],
  'classe': ['CST e cClassTrib', 'Dizem como o item é tributado. CST 000 = paga o imposto inteiro. CST 200 = tem redução (ex.: cesta básica, saúde, educação). O cClassTrib (6 números) diz qual é o caso exato. Na dúvida: 000001.'],
  'quantidade': ['Quantidade', 'Quantas unidades foram vendidas. Opcional, mas ajuda no Imposto Seletivo.'],
  'unidade': ['Unidade', 'A unidade de medida: UN (unidade), KG (quilo), LT (litro), M (metro)…'],
  'iscls': ['Classificação do Imposto Seletivo', 'O Imposto Seletivo cobra a mais de produtos que fazem mal à saúde ou ao meio ambiente (bebida, cigarro, veículos…). Começa em 2027. 000001 = primeira venda do bem.'],
  'isv': ['Base do Imposto Seletivo', 'Normalmente é o valor do item na nota.'],
  'isa': ['Alíquota do Imposto Seletivo', 'Percentual do Imposto Seletivo para este produto. Depende da lei de cada produto.'],
  'sn-data': ['Data da venda', 'Dia da venda ou do serviço. No Simples, CBS e IBS aparecem na nota a partir de 2027.'],
  'sn-doc': ['Tipo de nota', 'NF-e: venda de produto. NFC-e: cupom para o consumidor no caixa. NFS-e: nota de serviço.'],
  'sn-crt': ['Situação no Simples', 'Escolha "passou do sublimite" só se a receita do ano passou do limite do seu estado e você recolhe ICMS/ISS fora do Simples. Na dúvida, deixe "Optante".'],
  'sn-pcbs': ['Alíquota efetiva da CBS', 'Está no extrato do PGDAS-D do mês, na linha do anexo da sua atividade. É um percentual pequeno, como 1,1612.'],
  'sn-pibs': ['Alíquota efetiva do IBS', 'Também está no extrato do PGDAS-D, ao lado da CBS. Costuma ser bem pequena, como 0,0129.'],
  'sn-fr': ['Fator "r"', 'Só para a atividade 09. É a folha de salários dividida pela receita dos últimos 12 meses. Se der 28% ou mais, a empresa vai para o Anexo III (paga menos).'],
  'sn-gov': ['Venda para o governo', 'Marque se quem compra é a União, um estado, o DF ou um município. Nesse caso a lei muda a divisão das alíquotas.'],
  'atividade': ['Atividade no Simples', 'É a mesma atividade que você escolhe no PGDAS. Comércio costuma ser 01. Serviços aparecem só na NFS-e.'],
  'vis': ['Imposto Seletivo já calculado', 'Se o produto paga Imposto Seletivo, informe o valor já calculado. Se não paga, deixe vazio.'],
  'df-stc': ['Situação da nota', 'Válida: nota normal. Substituída ou Cancelada: o PDF sai com uma tarja avisando.'],
  'df-can': ['Canhoto', 'É a tira no pé da página para o cliente assinar quando recebe. Pode esconder se não usa.'],
  'df-xml': ['XML da nota', 'Arquivo que o Emissor Nacional da NFS-e gera depois que a nota é autorizada. Começa com <NFSe>.'],
};
/** Descobre qual ajuda vale para um rótulo. */
function chaveAjuda(label) {
  const id = label.htmlFor || '';
  if (AJUDA[id]) return id;
  if (!id && /produto ou servi/i.test(label.textContent)) return 'tipo';
  const m = id.match(/^(cod|scod|val|sval|cls|scls|qtd|un|iscls|isv|isa|sat|svis)-/);
  if (!m) return null;
  if (m[1] === 'cod' || m[1] === 'scod') return /NBS/.test(label.textContent) ? 'nbs' : 'ncm';
  return { val: 'valor', sval: 'valor', cls: 'classe', scls: 'classe', qtd: 'quantidade', un: 'unidade', sat: 'atividade', svis: 'vis' }[m[1]] || m[1];
}
/** Coloca o botão "?" ao lado de cada rótulo conhecido. */
function colocarAjudas(root = main) {
  root.querySelectorAll('.field > label').forEach(label => {
    if (label.querySelector('.q')) return;
    const k = chaveAjuda(label); if (!k) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'q'; b.dataset.ajuda = k; b.textContent = '?';
    b.setAttribute('aria-label', `O que é: ${AJUDA[k][0]}`); b.setAttribute('aria-expanded', 'false');
    label.appendChild(b);
  });
}
main.addEventListener('click', e => {
  const b = e.target.closest('button.q'); if (!b) return;
  e.preventDefault();
  const field = b.closest('.field');
  const aberto = field.querySelector(':scope > .ajuda-box');
  if (aberto) { aberto.remove(); b.setAttribute('aria-expanded', 'false'); return; }
  const [titulo, texto] = AJUDA[b.dataset.ajuda];
  const box = document.createElement('div');
  box.className = 'ajuda-box'; box.setAttribute('role', 'note');
  box.innerHTML = `<b>${esc(titulo)}.</b> ${esc(texto)}${$('#assist-txt') && ASSIST.ligado ? ' <button type="button" class="btn-link" data-perguntar>Perguntar mais ao assistente</button>' : ''}`;
  b.closest('label').after(box); b.setAttribute('aria-expanded', 'true');
  box.querySelector('[data-perguntar]')?.addEventListener('click', () => {
    const t = $('#assist-txt'); t.value = `O que eu coloco no campo "${titulo}"?`; t.focus(); t.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
});
new MutationObserver(() => colocarAjudas()).observe(main, { childList: true, subtree: true });

/* ---------- assistente de IA ---------- */

/** Estado do assistente: se está ligado e a conversa de cada calculadora. */
const ASSIST = { ligado: null, conversa: { regime: [], simples: [] }, ocupado: false };

async function statusAssistente() {
  if (ASSIST.ligado !== null) return ASSIST.ligado;
  try { ASSIST.ligado = !!(await getJSON('/svc/assistente/status')).ligado; } catch { ASSIST.ligado = false; }
  return ASSIST.ligado;
}

/** Bloco do assistente que fica no topo das calculadoras. */
function assistenteHTML(calc) {
  const ex = calc === 'simples' ? 'Ex.: sou comércio do Simples e vendi R$ 950 de cerveja numa NF-e em março de 2027. No PGDAS a CBS é 1,1612% e o IBS 0,0129%.' : 'Ex.: vendi 20 kg de arroz para um mercado de Porto Alegre por R$ 100.';
  return `<section class="assist" id="assist" aria-labelledby="assist-t">
    <div class="assist-head"><span class="assist-ico" aria-hidden="true">✦</span><div><h2 id="assist-t">Assistente</h2><p>Conte com suas palavras o que quer calcular. Eu preencho os campos e você confere.</p></div></div>
    <div class="assist-log" id="assist-log" aria-live="polite" hidden></div>
    <div class="assist-off" id="assist-off" hidden><b>Assistente desligado.</b> Dá para ligar de graça com uma chave do Gemini (Google) ou do Groq. Veja o passo a passo no README. Enquanto isso, toque no <span class="q" aria-hidden="true">?</span> ao lado de cada campo para ver a explicação.</div>
    <form class="assist-form" id="assist-form" hidden>
      <label for="assist-txt" class="sr">Descreva o que quer calcular</label>
      <textarea id="assist-txt" rows="2" maxlength="1500" placeholder="${esc(ex)}"></textarea>
      <button class="btn btn-assist" id="assist-go" type="submit">Preencher para mim</button>
    </form>
  </section>`;
}

function desenharConversa(calc) {
  const log = $('#assist-log'); if (!log) return;
  log.innerHTML = ASSIST.conversa[calc].map(m => `<div class="msg ${m.role === 'user' ? 'eu' : 'ia'}">${m.html || esc(m.content)}</div>`).join('');
  log.hidden = !ASSIST.conversa[calc].length;
  log.scrollTop = log.scrollHeight;
}

async function ligarAssistente(calc) {
  desenharConversa(calc);
  const ligado = await statusAssistente();
  if (!$('#assist')) return;
  $('#assist-off').hidden = ligado;
  $('#assist-form').hidden = !ligado;
  $('#assist-form').addEventListener('submit', e => { e.preventDefault(); perguntar(calc); });
  $('#assist-txt').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); perguntar(calc); } });
}

/** O que já está na tela, para o assistente saber o contexto. */
function fotoFormulario(calc) {
  if (calc === 'regime') { syncItemsRG(); return { data: RG.data, uf: RG.uf, municipio: RG.mun, itens: RG.items.map(i => ({ tipo: i.tipo, codigo: i.codigo, classe: i.classe, valor: i.valor })) }; }
  syncItemsSN(); return { data: SN.data, tpDoc: SN.doc, pcbs: SN.pcbs, pibs: SN.pibs, itens: SN.items.map(i => ({ atividade: i.atividade, classe: i.classe, codigo: i.codigo, valor: i.valor })) };
}
const reais = n => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const virgula = n => String(n).replace('.', ',');

async function perguntar(calc) {
  const txt = $('#assist-txt'), btn = $('#assist-go');
  const texto = txt.value.trim();
  if (!texto || ASSIST.ocupado) return;
  ASSIST.ocupado = true;
  const conversa = ASSIST.conversa[calc];
  conversa.push({ role: 'user', content: texto });
  txt.value = ''; desenharConversa(calc);
  $('#assist-log').insertAdjacentHTML('beforeend', '<div class="msg ia pensando" aria-label="Pensando"><span></span><span></span><span></span></div>');
  busy(btn, true, 'Pensando…');
  try {
    const r = await postJSON('/svc/assistente/chat', { calc, mensagens: conversa.filter(m => !m.local).map(m => ({ role: m.role, content: m.content })), formulario: fotoFormulario(calc) }, { timeout: 240000 });
    conversa.push({ role: 'assistant', content: r.texto || 'Pronto.' });
    if (r.preencher) {
      const resumo = calc === 'regime' ? aplicarRegime(r.preencher) : aplicarSimples(r.preencher);
      conversa.push({ role: 'assistant', local: true, content: '', html: resumo + (r.avisos || []).map(a => `<p class="aviso">⚠ ${esc(a)}</p>`).join('') });
      ASSIST.ocupado = false;
      (calc === 'regime' ? viewRegime : viewSimples)();
      requestAnimationFrame(() => $('#assist')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      toast('Campos preenchidos. Confira e toque em Calcular.');
      return;
    }
    desenharConversa(calc);
  } catch (e) {
    conversa.push({ role: 'assistant', local: true, content: '', html: `<p class="aviso">⚠ ${esc(e.message)}</p>` });
    desenharConversa(calc);
  } finally {
    ASSIST.ocupado = false;
    const b = $('#assist-go'); if (b === btn && b.disabled) busy(b, false);
  }
}

/** Joga o preenchimento do assistente no formulário do regime normal. */
function aplicarRegime(p) {
  if (p.data) RG.data = p.data;
  if (p.uf) RG.uf = p.uf;
  if (p.municipio) RG.mun = String(p.municipio);
  if (p.aliquotas) RG.aliqIA = p.aliquotas;
  const itens = (p.itens || []).filter(i => i && (i.codigo || i.valor));
  if (itens.length) RG.items = itens.map(i => novoItemRG({ tipo: i.tipo === 'nbs' ? 'nbs' : 'ncm', codigo: i.codigo || '', classe: `${i.cst || '000'}|${i.cClassTrib || '000001'}`, valor: i.valor ? reais(i.valor) : '', quantidade: i.quantidade ? virgula(i.quantidade) : '', unidade: i.unidade || '' }));
  RG.iaMarcar = true;
  return `<p><b>O que eu preenchi:</b></p><ul>${[
    p.municipioNome ? `<li>Local: ${esc(p.municipioNome)}/${esc(p.uf)}</li>` : '',
    p.data ? `<li>Data: ${fmtData(p.data)}</li>` : '',
    ...itens.map((i, n) => `<li>Item ${n + 1}: ${i.codigo ? `${(i.tipo || 'ncm').toUpperCase()} ${esc(i.codigo)}${i.descricaoCodigo ? ` (${esc(i.descricaoCodigo.split(' > ').slice(-1)[0])})` : ''} · ` : 'código em branco · '}${esc(i.cClassTrib || '')} · R$ ${reais(i.valor || 0)}${i.motivo ? `<br><small>${esc(i.motivo)}</small>` : ''}</li>`),
  ].join('')}</ul>`;
}

/** Joga o preenchimento do assistente no formulário do Simples. */
function aplicarSimples(p) {
  if (p.data) SN.data = p.data < SN_INICIO ? SN_INICIO : p.data;
  if (p.tpDoc) SN.doc = String(p.tpDoc);
  if (p.pcbs != null) SN.pcbs = virgula(p.pcbs);
  if (p.pibs != null) SN.pibs = virgula(p.pibs);
  const itens = (p.itens || []).filter(Boolean);
  if (itens.length) SN.items = itens.map(i => novoItemSN({ atividade: i.atividade || '', classe: i.cClassTrib || '000001', tipo: i.tipo === 'nbs' || SN.doc === '91' ? 'nbs' : 'ncm', codigo: i.codigo || '', valor: i.valor ? reais(i.valor) : '', vis: i.vis ? reais(i.vis) : '' }));
  SN.iaMarcar = true;
  const falta = [SN.pcbs ? '' : 'a alíquota efetiva da CBS', SN.pibs ? '' : 'a do IBS'].filter(Boolean);
  return `<p><b>O que eu preenchi:</b></p><ul>${[
    `<li>Nota: ${{ 55: 'NF-e', 65: 'NFC-e', 91: 'NFS-e' }[SN.doc]} · ${fmtData(SN.data)}</li>`,
    ...itens.map((i, n) => `<li>Item ${n + 1}: atividade ${esc(i.atividade)} · ${esc(i.cClassTrib || '')}${i.codigo ? ` · ${esc(i.codigo)}` : ''} · R$ ${reais(i.valor || 0)}${i.motivo ? `<br><small>${esc(i.motivo)}</small>` : ''}</li>`),
  ].join('')}</ul>${falta.length ? `<p class="aviso">Falta ${falta.join(' e ')} do PGDAS. Toque no ? ao lado do campo para saber onde achar.</p>` : ''}`;
}

/** Destaca os campos que o assistente preencheu; o destaque some quando a pessoa mexe. */
function marcarPreenchidos(calc) {
  const st = calc === 'regime' ? RG : SN; if (!st.iaMarcar) return;
  st.iaMarcar = false;
  const alvo = calc === 'regime' ? ['#rg-data', '#rg-uf', '#rg-mun', '#rg-items .item'] : ['#sn-data', '#sn-doc', '#sn-pcbs', '#sn-pibs', '#sn-items .item'];
  alvo.forEach(sel => $$(sel).forEach(el => { if (el.classList.contains('item') || el.value !== '') el.classList.add('ia-ok'); }));
}
main.addEventListener('input', e => { e.target.classList.remove('ia-ok'); e.target.closest('.item')?.classList.remove('ia-ok'); });
main.addEventListener('change', e => { e.target.classList.remove('ia-ok'); });

/* ---------- roteador, status e PWA ---------- */

const ROUTES = { '': viewHome, regime: viewRegime, simples: viewSimples, danfse: viewDanfse, historico: viewHistorico };
function route() {
  const key = (location.hash.replace(/^#\/?/, '').split('?')[0]) || '';
  const view = ROUTES[key] || viewHome;
  $$('[data-nav]').forEach(a => a.classList.toggle('on', (a.dataset.nav === 'home' ? '' : a.dataset.nav) === key));
  view();
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
  document.title = (key ? ({ regime: 'Regime normal', simples: 'Simples Nacional', danfse: 'PDF da NFS-e', historico: 'Histórico' }[key] + ' · ') : '') + 'Calculadora RTC';
}
window.addEventListener('hashchange', route);

/** Confere se os 3 programas estão respondendo. */
async function checkStatus() {
  const el = $('#status');
  const ping = u => fetch(u, { cache: 'no-store' }).then(r => r.ok).catch(() => false);
  const ok = await Promise.all([
    ping(`${API.regime}/dados-abertos/versao`),
    ping('/svc/simples/versao'),
    ping('/svc/danfse/health/ready'),
  ]);
  const n = ok.filter(Boolean).length;
  el.className = 'status ' + (n === 3 ? 'ok' : 'bad');
  el.querySelector('span').textContent = n === 3 ? 'Cálculo online' : `${n} de 3 programas online`;
  el.title = ['Regime normal', 'Simples Nacional', 'PDF da NFS-e'].map((s, i) => `${s}: ${ok[i] ? 'ok' : 'fora do ar'}`).join('\n');
}

route();
checkStatus(); setInterval(checkStatus, 60000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
