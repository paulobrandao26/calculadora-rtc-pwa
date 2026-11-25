// Assistente da Calculadora RTC.
// Recebe o que a pessoa quer calcular, conversa com uma IA grátis (Gemini ou Groq, pela API
// compatível com OpenAI) e devolve os campos para preencher. Os códigos (NCM, NBS, cClassTrib,
// município, atividade do Simples) são sempre conferidos nas tabelas oficiais da Receita,
// que já rodam no docker-compose. A IA não calcula imposto: quem calcula é a calculadora oficial.
// Sem dependências: só Node 22+.
import http from 'node:http';

const PORTA = Number(process.env.PORTA || 3000);
const REGIME = process.env.REGIME_URL || 'http://regime-regular:8080/api/calculadora';
const SIMPLES = process.env.SIMPLES_URL || 'http://simples-nacional:8082/api/calculadora';

const PROVEDORES = {
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai', preferido: /gemini-[\d.]+-flash(-lite)?$/, evitar: /image|tts|audio|live|embedding|thinking|exp|preview/ },
  groq: { url: 'https://api.groq.com/openai/v1', modelo: 'openai/gpt-oss-120b' },
};
const PROVEDOR = (process.env.IA_PROVEDOR || 'gemini').toLowerCase();
const CHAVE = process.env.IA_CHAVE || '';
const BASE = process.env.IA_URL || PROVEDORES[PROVEDOR]?.url || PROVEDORES.gemini.url;
let MODELO = process.env.IA_MODELO || PROVEDORES[PROVEDOR]?.modelo || '';

/* ---------- consultas às tabelas oficiais ---------- */

const cache = new Map();
async function getJSON(url) {
  if (cache.has(url)) return cache.get(url);
  const p = fetch(url, { signal: AbortSignal.timeout(20000) }).then(async r => {
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`tabela respondeu ${r.status}`);
    return r.json();
  });
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}
const semAcento = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const limpa = s => String(s ?? '').replace(/<[^>]+>/g, '').trim();

/** Pontua um texto pelas palavras buscadas (quanto mais palavras achar, melhor). */
function pontua(texto, termos) {
  const t = semAcento(texto);
  return termos.reduce((n, w) => n + (t.includes(w) ? (w.length > 4 ? 2 : 1) : 0), 0);
}
const termosDe = q => semAcento(q).split(/[^a-z0-9]+/).filter(w => w.length > 2);

const FERRAMENTAS = {
  async conferir_ncm({ codigo, data }) {
    const c = String(codigo || '').replace(/\D/g, '');
    if (c.length !== 8) return { existe: false, erro: 'NCM precisa ter 8 números' };
    const j = await getJSON(`${REGIME}/dados-abertos/ncm?ncm=${c}&data=${data}`);
    if (!j) return { existe: false, codigo: c };
    return { existe: true, codigo: c, descricao: [j.capitulo, j.posicao, j.subposicao, j.item, j.subitem].filter(Boolean).map(limpa).join(' > '), impostoSeletivo: !!j.tributadoPeloImpostoSeletivo };
  },
  async conferir_nbs({ codigo, data }) {
    const c = String(codigo || '').replace(/\D/g, '');
    if (c.length !== 9) return { existe: false, erro: 'NBS precisa ter 9 números' };
    const j = await getJSON(`${REGIME}/dados-abertos/nbs?nbs=${c}&data=${data}`);
    if (!j) return { existe: false, codigo: c };
    return { existe: true, codigo: c, descricao: [j.capitulo, j.posicao, j.subposicao, j.item, j.subitem].filter(Boolean).map(limpa).join(' > ') };
  },
  async buscar_nbs({ texto, data }) {
    const lista = await getJSON(`${REGIME}/dados-abertos/nbs/lista?data=${data}`) || [];
    const termos = termosDe(texto);
    return lista.map(n => ({ codigo: n.codigo, descricao: limpa(n.descricao), p: pontua(n.descricao, termos) }))
      .filter(n => n.p > 0).sort((a, b) => b.p - a.p).slice(0, 12).map(({ p, ...n }) => n);
  },
  async buscar_ncm({ texto, data }) {
    const lista = await getJSON(`${REGIME}/dados-abertos/ncm/vigentes?data=${data}`) || [];
    const termos = termosDe(texto);
    return lista.map(n => ({ codigo: n.ncm, descricao: limpa(n.descricao).replace(/^[-\s]+/, ''), p: pontua(n.descricao, termos) }))
      .filter(n => n.p > 0 && !/^outr[oa]s$/i.test(n.descricao)).sort((a, b) => b.p - a.p).slice(0, 12).map(({ p, ...n }) => n);
  },
  async listar_classificacoes({ texto, data }) {
    const lista = await getJSON(`${REGIME}/dados-abertos/situacoes-tributarias/cbs-ibs?data=${data}`) || [];
    const termos = termosDe(texto || '');
    const todas = lista.flatMap(c => (c.classificacoesTributarias || []).map(x => ({ cst: c.codigo, cClassTrib: x.codigo, descricao: x.descricao, tipo: c.descricao })));
    if (!termos.length) return todas.filter(c => c.cClassTrib === '000001');
    const achadas = todas.map(c => ({ ...c, p: pontua(`${c.descricao} ${c.tipo}`, termos) })).filter(c => c.p > 0).sort((a, b) => b.p - a.p).slice(0, 15).map(({ p, ...c }) => c);
    return achadas.length ? achadas : todas.filter(c => c.cClassTrib === '000001');
  },
  async buscar_municipio({ nome, uf }) {
    const ufs = uf ? [{ sigla: String(uf).toUpperCase() }] : (await getJSON(`${REGIME}/dados-abertos/ufs`)) || [];
    const alvo = semAcento(nome);
    const achados = [];
    for (const u of ufs) {
      const muns = (await getJSON(`${REGIME}/dados-abertos/ufs/municipios?siglaUf=${u.sigla}`)) || [];
      for (const m of muns) {
        const n = semAcento(m.nome);
        if (n === alvo || n.includes(alvo)) achados.push({ codigo: m.codigo, nome: m.nome, uf: u.sigla, exato: n === alvo });
      }
    }
    return achados.sort((a, b) => b.exato - a.exato).slice(0, 8);
  },
  async listar_atividades_simples({ data }) {
    const lista = (await getJSON(`${SIMPLES}/simples-nacional/atividades?data=${data}`)) || [];
    return lista.map(a => ({ codigo: a.codigo, descricao: a.descricao, anexo: a.rotuloAnexo, fatorR: a.sujeitaFatorR, notas: a.tpDocsAdmissiveis }));
  },
};

/* ---------- descrição das ferramentas para a IA ---------- */

const fn = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const DATA = { type: 'string', description: 'Data da operação, AAAA-MM-DD' };
const TOOLS_BASE = [
  fn('conferir_ncm', 'Confere se um NCM (produto, 8 números) existe e devolve a descrição oficial. Use SEMPRE antes de sugerir um NCM.', { codigo: { type: 'string' }, data: DATA }, ['codigo', 'data']),
  fn('buscar_ncm', 'Procura NCM pela descrição curta da tabela oficial (ex.: "arroz", "notebook"). A descrição é curta; prefira propor o código e conferir com conferir_ncm.', { texto: { type: 'string' }, data: DATA }, ['texto', 'data']),
  fn('conferir_nbs', 'Confere se um NBS (serviço, 9 números) existe e devolve a descrição oficial.', { codigo: { type: 'string' }, data: DATA }, ['codigo', 'data']),
  fn('buscar_nbs', 'Procura códigos NBS de serviço por palavras (ex.: "desenvolvimento de software", "ensino infantil").', { texto: { type: 'string' }, data: DATA }, ['texto', 'data']),
  fn('listar_classificacoes', 'Lista CST e cClassTrib oficiais que combinam com as palavras (ex.: "alimentação humana", "educação", "saúde"). Sem palavra especial, use "tributação integral" (000001).', { texto: { type: 'string' }, data: DATA }, ['texto', 'data']),
  fn('buscar_municipio', 'Acha o código IBGE de um município pelo nome. Informe a UF quando souber.', { nome: { type: 'string' }, uf: { type: 'string', description: 'Sigla da UF, ex.: RS' } }, ['nome']),
];
const PREENCHER_REGIME = fn('preencher_formulario', 'Preenche a calculadora do REGIME NORMAL. Chame só com códigos conferidos. Campos que você não sabe, deixe de fora.', {
  data: DATA,
  uf: { type: 'string', description: 'Sigla da UF' },
  municipio: { type: 'integer', description: 'Código IBGE do município (7 números)' },
  aliquotas: { type: 'object', description: 'Só para 2027 em diante: cbs, ibsEstadual, ibsMunicipal em %', properties: { cbs: { type: 'number' }, ibsEstadual: { type: 'number' }, ibsMunicipal: { type: 'number' } } },
  itens: { type: 'array', items: { type: 'object', properties: {
    tipo: { type: 'string', enum: ['ncm', 'nbs'] }, codigo: { type: 'string' }, cst: { type: 'string' }, cClassTrib: { type: 'string' },
    valor: { type: 'number', description: 'Valor total do item em reais' }, quantidade: { type: 'number' }, unidade: { type: 'string' },
    motivo: { type: 'string', description: 'Uma frase simples dizendo por que escolheu esses códigos' },
  }, required: ['tipo', 'codigo', 'cst', 'cClassTrib', 'valor'] } },
  explicacao: { type: 'string', description: 'Resumo curto para a pessoa do que foi preenchido' },
}, ['itens', 'explicacao']);
const PREENCHER_SIMPLES = fn('preencher_formulario', 'Preenche a calculadora do SIMPLES NACIONAL. Chame só com códigos conferidos.', {
  data: DATA,
  tpDoc: { type: 'string', enum: ['55', '65', '91'], description: '55 NF-e (produto), 65 NFC-e (cupom), 91 NFS-e (serviço)' },
  pcbs: { type: 'number', description: 'Alíquota efetiva CBS do PGDAS, em %, se a pessoa informou' },
  pibs: { type: 'number', description: 'Alíquota efetiva IBS do PGDAS, em %, se a pessoa informou' },
  itens: { type: 'array', items: { type: 'object', properties: {
    atividade: { type: 'string', description: 'Código da atividade do Simples (ex.: "01")' }, cClassTrib: { type: 'string' },
    tipo: { type: 'string', enum: ['ncm', 'nbs'] }, codigo: { type: 'string' }, valor: { type: 'number' }, vis: { type: 'number', description: 'Imposto Seletivo já calculado, se houver' },
    motivo: { type: 'string' },
  }, required: ['atividade', 'cClassTrib', 'valor'] } },
  explicacao: { type: 'string' },
}, ['itens', 'explicacao']);

function sistema(calc, form) {
  const hoje = new Date().toISOString().slice(0, 10);
  const comum = `Você é o assistente da Calculadora RTC, um app para contadores e pequenas empresas calcularem CBS, IBS e Imposto Seletivo (reforma tributária, LC 214/2025).
Fale em português do Brasil simples, frases curtas, sem jargão. Quando usar uma sigla, explique em poucas palavras.
Seu papel: explicar os campos e preencher a calculadora a partir do que a pessoa descrever. Você NÃO calcula imposto e NÃO dá números de imposto: quem calcula é a calculadora oficial da Receita, depois que a pessoa conferir e clicar em Calcular.
Regras:
- Nunca invente código. Confira todo NCM, NBS, cClassTrib, município e atividade com as ferramentas antes de usar.
- Se faltar informação essencial (valor, cidade, o que foi vendido), pergunte de forma curta em vez de chutar.
- Se a pessoa só fizer uma pergunta sobre um campo, responda e NÃO preencha nada.
- Quando tiver tudo, chame preencher_formulario uma vez e depois responda em 2 a 4 frases dizendo o que preencheu e pedindo para conferir.
- Hoje é ${hoje}. O que a pessoa já tem na tela: ${JSON.stringify(form || {})}.`;
  if (calc === 'simples') return comum + `
Calculadora: SIMPLES NACIONAL. Só vale de 2027 em diante (use 2027-01-01 ou depois). A pessoa precisa das alíquotas efetivas de CBS e IBS do extrato do PGDAS; se ela não souber, explique onde achar e deixe em branco.
Escolha a atividade com listar_atividades_simples. Comércio costuma ser 01; serviços em NFS-e (91). NFS-e aceita 1 item. Na dúvida do cClassTrib, use 000001.`;
  return comum + `
Calculadora: REGIME NORMAL (lucro real ou presumido). Em 2026 não se informam alíquotas (o programa usa as de teste). De 2027 em diante as alíquotas são obrigatórias: se a pessoa não disser, deixe de fora que o app usa as de teste.
Produto usa NCM (8 números); serviço usa NBS (9 números).
Classificação (cClassTrib): antes de usar 000001 (tributação integral), SEMPRE chame listar_classificacoes com o tipo do produto ou serviço, porque muita coisa tem redução ou alíquota zero (CST 200). Exemplos de palavras: comida em geral (arroz, feijão, carne, leite, pão) -> "alimentação humana" (200003); verdura, fruta, ovo -> "hortícolas frutas ovos"; remédio -> "medicamentos"; material médico -> "dispositivos médicos"; escola -> "educação"; consulta -> "saúde". Se nada combinar, use 000001 e diga isso na resposta.`;
}

/* ---------- conversa com a IA ---------- */

/** Modelos para tentar, do preferido ao reserva. Se um estiver cheio ou lento, passa para o próximo. */
let CANDIDATOS = [];

async function escolherModelo() {
  if (CANDIDATOS.length || !CHAVE) return MODELO;
  if (MODELO) { CANDIDATOS = [MODELO]; return MODELO; }
  try {
    const r = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${CHAVE}` }, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const ids = (j.data || []).map(m => String(m.id).replace(/^models\//, ''));
    const p = PROVEDORES[PROVEDOR] || {};
    const bons = ids.filter(id => (!p.preferido || p.preferido.test(id)) && !(p.evitar && p.evitar.test(id)));
    // o "lite" responde bem mais rápido no plano grátis; vai na frente, o "flash" fica de reserva
    const lite = id => /lite/.test(id) ? 0 : 1;
    bons.sort((a, b) => lite(a) - lite(b) || b.localeCompare(a, 'en', { numeric: true }));
    // reservas estáveis do Gemini no fim da fila
    const reservas = ['gemini-flash-latest', 'gemini-2.5-flash'].filter(id => ids.includes(id) && !bons.includes(id));
    // 2 "lite" (rápidos) e 1 "flash" (mais lento) de reserva
    CANDIDATOS = [...bons.filter(id => /lite/.test(id)).slice(0, 2), ...[...bons.filter(id => !/lite/.test(id)), ...reservas].slice(0, 1)];
    if (!CANDIDATOS.length) CANDIDATOS = ids.slice(0, 1);
    MODELO = CANDIDATOS[0] || '';
    console.log(`modelos na fila: ${CANDIDATOS.join(', ')}`);
  } catch (e) { console.log('não deu para listar modelos:', e.message); }
  return MODELO;
}

async function chamarIA(messages, tools) {
  const fila = CANDIDATOS.length ? [MODELO, ...CANDIDATOS.filter(m => m !== MODELO)] : [MODELO];
  let ultimoErro;
  for (const modelo of fila) {
    let r;
    try {
      r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHAVE}` },
        body: JSON.stringify({ model: modelo, messages, tools, tool_choice: 'auto', temperature: 0.2 }),
        signal: AbortSignal.timeout(60000),
      });
    } catch (e) {
      ultimoErro = Object.assign(new Error('A IA demorou demais para responder. Tente de novo.'), { status: 504 });
      console.log(`${modelo}: sem resposta (${e.name}), tentando o próximo`);
      continue;
    }
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('A chave da IA não foi aceita. Confira o arquivo .env.'), { status: 502 });
    if (r.status === 429 || r.status >= 500 || r.status === 404) {
      ultimoErro = r.status === 429
        ? Object.assign(new Error('A IA grátis atingiu o limite de uso por agora. Espere um minuto e tente de novo.'), { status: 429 })
        : Object.assign(new Error('A IA grátis está sobrecarregada agora. Tente de novo em alguns segundos.'), { status: 503 });
      console.log(`${modelo}: erro ${r.status}, tentando o próximo`);
      continue;
    }
    if (!r.ok) throw Object.assign(new Error(`A IA respondeu com erro ${r.status}.`), { status: 502, detalhe: (await r.text()).slice(0, 300) });
    if (modelo !== MODELO) { console.log(`passando a usar ${modelo}`); MODELO = modelo; }
    const j = await r.json();
    return j.choices?.[0]?.message || {};
  }
  throw ultimoErro || new Error('A IA não respondeu.');
}

/** Confere o que a IA quer preencher e tira o que não existe nas tabelas. */
async function validarPreenchimento(calc, p) {
  const avisos = [];
  const data = p.data || new Date().toISOString().slice(0, 10);
  const itens = [];
  for (const [i, it] of (p.itens || []).entries()) {
    const n = i + 1;
    const out = { ...it };
    if (it.codigo) {
      const tipo = it.tipo || (String(it.codigo).replace(/\D/g, '').length === 9 ? 'nbs' : 'ncm');
      out.tipo = tipo;
      const c = await FERRAMENTAS[tipo === 'nbs' ? 'conferir_nbs' : 'conferir_ncm']({ codigo: it.codigo, data });
      if (!c.existe) { avisos.push(`Item ${n}: o código ${tipo.toUpperCase()} ${it.codigo} não existe na tabela oficial. Deixei em branco.`); out.codigo = ''; }
      else { out.codigo = c.codigo; out.descricaoCodigo = c.descricao; }
    }
    if (it.cClassTrib) {
      const lista = await getJSON(`${REGIME}/dados-abertos/situacoes-tributarias/cbs-ibs?data=${data}`) || [];
      const achou = lista.flatMap(c => (c.classificacoesTributarias || []).map(x => ({ cst: c.codigo, cClassTrib: x.codigo, descricao: x.descricao }))).find(x => x.cClassTrib === it.cClassTrib);
      if (!achou) { avisos.push(`Item ${n}: a classificação ${it.cClassTrib} não existe nesta data. Usei 000001 (tributação integral); confira.`); out.cst = '000'; out.cClassTrib = '000001'; }
      else { out.cst = achou.cst; out.descricaoClasse = achou.descricao; }
    }
    if (calc === 'simples' && it.atividade) {
      const ativs = await FERRAMENTAS.listar_atividades_simples({ data });
      const a = ativs.find(x => x.codigo === String(it.atividade).padStart(2, '0'));
      if (!a) { avisos.push(`Item ${n}: a atividade ${it.atividade} não existe. Escolha na lista.`); out.atividade = ''; }
      else out.atividade = a.codigo;
    }
    itens.push(out);
  }
  const res = { ...p, data, itens };
  if (calc === 'regime' && p.municipio) {
    const ufs = (await getJSON(`${REGIME}/dados-abertos/ufs`)) || [];
    const uf = p.uf || ufs.find(u => String(u.codigo) === String(p.municipio).slice(0, 2))?.sigla;
    const muns = uf ? (await getJSON(`${REGIME}/dados-abertos/ufs/municipios?siglaUf=${uf}`)) || [] : [];
    const m = muns.find(x => String(x.codigo) === String(p.municipio));
    if (!m) { avisos.push('Não achei o município informado. Escolha na lista.'); delete res.municipio; }
    else { res.uf = uf; res.municipioNome = m.nome; }
  }
  return { preencher: res, avisos };
}

async function conversar({ calc, mensagens, formulario }) {
  if (!CHAVE) throw Object.assign(new Error('O assistente está desligado: falta a chave da IA no arquivo .env.'), { status: 503 });
  await escolherModelo();
  const tools = [...TOOLS_BASE, ...(calc === 'simples' ? [fn('listar_atividades_simples', 'Lista as atividades oficiais do Simples Nacional com o anexo.', { data: DATA }, ['data'])] : []), calc === 'simples' ? PREENCHER_SIMPLES : PREENCHER_REGIME];
  const historico = (mensagens || []).slice(-12).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  const messages = [{ role: 'system', content: sistema(calc, formulario) }, ...historico];
  let preenchido = null;
  for (let volta = 0; volta < 8; volta++) {
    const msg = await chamarIA(messages, tools);
    const chamadas = msg.tool_calls || [];
    if (!chamadas.length) return { texto: msg.content || 'Pronto.', ...(preenchido || {}) };
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: chamadas });
    for (const tc of chamadas) {
      let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* argumento inválido */ }
      let resultado;
      try {
        if (tc.function.name === 'preencher_formulario') {
          preenchido = await validarPreenchimento(calc, args);
          resultado = { ok: true, avisos: preenchido.avisos, preenchido: preenchido.preencher };
        } else if (FERRAMENTAS[tc.function.name]) resultado = await FERRAMENTAS[tc.function.name](args);
        else resultado = { erro: 'ferramenta desconhecida' };
      } catch (e) { resultado = { erro: e.message }; }
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(resultado).slice(0, 12000) });
    }
  }
  return { texto: 'Não consegui terminar. Tente descrever de outro jeito.', ...(preenchido || {}) };
}

/* ---------- servidor HTTP ---------- */

const responder = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/status') return responder(res, 200, { ligado: !!CHAVE, provedor: PROVEDOR, modelo: CHAVE ? await escolherModelo() : null });
    if (req.method === 'POST' && req.url === '/chat') {
      let corpo = '';
      for await (const parte of req) { corpo += parte; if (corpo.length > 100000) return responder(res, 413, { erro: 'Mensagem grande demais.' }); }
      const entrada = JSON.parse(corpo || '{}');
      if (!['regime', 'simples'].includes(entrada.calc)) return responder(res, 400, { erro: 'Calculadora inválida.' });
      return responder(res, 200, await conversar(entrada));
    }
    responder(res, 404, { erro: 'Não encontrado.' });
  } catch (e) {
    console.error('erro:', e.message, e.detalhe || '');
    responder(res, e.status || 500, { erro: e.message || 'Erro no assistente.' });
  }
}).listen(PORTA, () => console.log(`assistente na porta ${PORTA} · provedor ${PROVEDOR} · ${CHAVE ? 'com chave' : 'SEM chave (desligado)'}`));
