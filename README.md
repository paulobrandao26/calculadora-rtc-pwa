# Calculadora RTC

App (PWA, instala no celular e no PC) com 3 calculadoras da Reforma Tributária do Consumo (LC 214/2025):

1. **Regime normal** — CBS, IBS e Imposto Seletivo de uma operação, item a item. Consulta NCM/NBS, alíquotas da União, UF e município e o cClassTrib.
2. **Simples Nacional** — CBS e IBS de quem está no Simples, a partir da atividade e das alíquotas efetivas do PGDAS. Mostra a lista de atividades.
3. **PDF da NFS-e (DANFSe)** — envia o XML da nota e baixa o PDF.

Tem histórico (fica no aparelho) e exportação em PDF e planilha (.csv, abre no Excel).

## Como rodar

Precisa do Docker Desktop ligado. Na primeira vez, baixe os 3 programas da Receita para `servicos/`:

```powershell
foreach ($r in 'calculadora-rtc-regime-regular','calculadora-rtc-simples-nacional','calculadora-rtc-gerador-danfse') { git clone --depth 1 "https://github.com/ReceitaFederal/$r.git" "servicos/$r" }
```

Depois:

```powershell
docker compose up -d --build
```

Abra http://localhost:8090. Na primeira vez o build demora (baixa Java, Maven e Go).

## Assistente de IA (grátis)

Nas telas de Regime normal e Simples Nacional tem um **assistente**: você descreve com suas palavras o que vendeu e ele preenche os campos para você conferir. Todo campo também tem um botão **?** com a explicação, e esse funciona mesmo sem IA.

O assistente não calcula imposto: ele só preenche. Quem calcula é a calculadora oficial. Os códigos que a IA sugere (NCM, NBS, cClassTrib, município, atividade) são conferidos nas tabelas oficiais, e o que não existir é apagado com aviso.

Para ligar (sem pagar nada):

1. Crie uma chave grátis no Gemini: https://aistudio.google.com/apikey (ou no Groq: https://console.groq.com/keys).
2. Na pasta do projeto, crie um arquivo chamado `.env` com:

   ```
   IA_PROVEDOR=gemini
   IA_CHAVE=sua-chave-aqui
   ```

   Para Groq, use `IA_PROVEDOR=groq`. Se quiser forçar um modelo, acrescente `IA_MODELO=nome-do-modelo`; sem isso, o assistente escolhe sozinho.
3. Reinicie o assistente:

   ```powershell
   docker compose up -d assistente
   ```

No plano grátis do Gemini cada resposta leva de 10 a 40 segundos (o assistente usa primeiro os modelos "lite", que são os mais rápidos, e troca sozinho se um estiver cheio).

O `.env` está no `.gitignore`, então a chave não vai para o GitHub. No plano grátis, o Google pode usar as conversas para melhorar os produtos dele; não coloque dados sigilosos de clientes.

## Como funciona

| Serviço | O que é | Onde |
|---|---|---|
| `web` | nginx com o app e o repasse para os programas | porta 8090 |
| `regime-regular` | [calculadora-rtc-regime-regular](https://github.com/ReceitaFederal/calculadora-rtc-regime-regular) (Java 25) | `/svc/regime/` → `:8080/api/` |
| `simples-nacional` | [calculadora-rtc-simples-nacional](https://github.com/ReceitaFederal/calculadora-rtc-simples-nacional) (Java 25) | `/svc/simples/` → `:8082/api/` |
| `assistente` | servidor do assistente (Node, sem dependências), em `assistente/server.mjs` | `/svc/assistente/` → `:3000/` |
| `danfse` | [calculadora-rtc-gerador-danfse](https://github.com/ReceitaFederal/calculadora-rtc-gerador-danfse) (Go) | `/svc/danfse/` → `:8080/` |

Os três programas são da Receita Federal, com licença MIT, e ficam sem alteração em `servicos/`.
O banco SQLite de cada calculadora Java é gerado no build com os scripts Flyway do repositório do regime regular (como mandam os READMEs).

Pastas:

- `web/` — o app (HTML, CSS e JS puros, sem build)
- `docker/` — Dockerfiles das calculadoras Java e config do nginx
- `tools/testar.cjs` — teste de ponta a ponta com Playwright (PC 1280x800 e celular 390x844), salva fotos em `fotos/`
- `tools/gerar-icones.cjs` — gera os ícones PNG

## Testar

```powershell
node tools/testar.cjs
```

Assistente, com uma IA de teste de roteiro fixo (não gasta chave; testa o caminho todo, não a inteligência da IA):

```powershell
$env:IA_CHAVE='teste'; $env:IA_URL='http://ia-falsa:4000/v1'; docker compose --profile teste up -d ia-falsa assistente; node tools/testar-assistente.cjs
```

Com a IA de verdade (usa a sua chave; os textos mudam a cada vez, então confere só o essencial):

```powershell
node tools/testar-assistente.cjs real
```

Depois do teste com a IA de roteiro fixo, volte ao normal com `Remove-Item Env:IA_CHAVE, Env:IA_URL; docker compose up -d assistente`.

## Observações

- Em 2026 a calculadora do regime normal usa as alíquotas de teste oficiais. De 2027 em diante, o programa da Receita exige que as alíquotas sejam informadas (o app já preenche os valores de teste do exemplo oficial).
- Os valores são simulações para planejamento. Não é site oficial do governo.
