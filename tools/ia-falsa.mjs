// IA de mentira, só para teste automático do assistente (perfil "teste" do docker-compose).
// Fala o mesmo protocolo da API compatível com OpenAI e segue um roteiro fixo:
// 1ª volta pede as ferramentas, 2ª volta preenche o formulário, 3ª volta responde em texto.
// Não prova que a IA de verdade acerta: prova que o caminho app → assistente → tabelas → app funciona.
import http from 'node:http';

const call = (name, args) => ({ id: 'c' + Math.random().toString(36).slice(2, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } });
const resposta = msg => ({ choices: [{ index: 0, message: { role: 'assistant', ...msg }, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }] });

function roteiro(messages) {
  const simples = /SIMPLES NACIONAL/.test(messages[0]?.content || '');
  const ultimaPessoa = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const tools = messages.filter(m => m.role === 'tool');
  const jaPreencheu = tools.some(m => m.name === 'preencher_formulario');
  if (/o que (e|é)|onde (acho|encontro)/i.test(ultimaPessoa) && !tools.length)
    return resposta({ content: 'NCM é o código do produto, com 8 números. Ele aparece na nota de compra ou no cadastro do produto.' });
  if (jaPreencheu) return resposta({ content: 'Preenchi a calculadora com o que você contou. Confira os campos destacados e toque em Calcular.' });
  if (!tools.length) {
    return resposta({ content: '', tool_calls: simples
      ? [call('listar_atividades_simples', { data: '2027-03-15' }), call('conferir_ncm', { codigo: '22030000', data: '2027-03-15' })]
      : [call('conferir_ncm', { codigo: '10063021', data: '2026-11-25' }), call('listar_classificacoes', { texto: 'alimentação humana', data: '2026-11-25' }), call('buscar_municipio', { nome: 'Porto Alegre', uf: 'RS' })] });
  }
  return resposta({ content: '', tool_calls: [simples
    ? call('preencher_formulario', { data: '2027-03-15', tpDoc: '55', pcbs: 1.1612, pibs: 0.0129, itens: [{ atividade: '01', cClassTrib: '000001', tipo: 'ncm', codigo: '22030000', valor: 950, motivo: 'Revenda de mercadoria é a atividade 01 (Anexo I).' }], explicacao: 'Venda de cerveja por comércio do Simples.' })
    : call('preencher_formulario', { data: '2026-11-25', uf: 'RS', municipio: 4314902, itens: [{ tipo: 'ncm', codigo: '10063021', cst: '200', cClassTrib: '200003', valor: 100, quantidade: 20, unidade: 'KG', motivo: 'Arroz é alimento da cesta básica (Anexo I), com redução de 100%.' }, { tipo: 'ncm', codigo: '99999999', cst: '000', cClassTrib: '000001', valor: 10, motivo: 'Código errado de propósito, para testar a conferência.' }], explicacao: 'Venda de arroz em Porto Alegre.' })] });
}

http.createServer(async (req, res) => {
  let corpo = ''; for await (const p of req) corpo += p;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'modelo-falso' }] }));
  res.end(JSON.stringify(roteiro(JSON.parse(corpo || '{}').messages || [])));
}).listen(4000, () => console.log('IA falsa na porta 4000'));
