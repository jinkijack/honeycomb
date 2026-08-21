import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * The QA stage.
 *
 * Cross-validation answers "is this code correct as written". It does not answer
 * "does the thing actually work when you run it" — the reviewer reads a diff and
 * runs typecheck/lint/tests, which is a different question from booting the
 * application and exercising the flow the change touched.
 *
 * This stage closes that gap: a QA specialist writes a test plan derived from
 * what changed, starts the project, and executes the plan — HTTP calls for new
 * endpoints, real messages for new consumers, a browser for front-end changes —
 * plus the regression surface around it. Its verdict feeds the same correction
 * loop the reviewer uses, so a defect found in testing goes back to the
 * implementer, gets re-reviewed and gets re-tested.
 */

/**
 * Browser automation available to the tester.
 *
 * Each preset can reach the agent two ways, and which one is real depends on
 * what is installed:
 *
 *   `mcp` — the server is injected into the agent's CLI (see the adapters). Only
 *   Claude Code and Codex take MCP configuration on the command line; Kiro
 *   configures MCP through agent files we do not own.
 *
 *   `cli` — the same capability as a shell command, which works on every tool.
 *
 * `resolveBrowser` picks between them by probing, instead of declaring one and
 * hoping. That matters because a browser MCP server that fails to start is
 * invisible from inside the prompt: the tester just never sees the tools, and
 * reports the screen as untestable — or worse, does not mention it at all.
 */
const PRESETS = {
  none: {
    label: 'sem navegador',
    hint:
      'Nao ha automacao de navegador disponivel: teste as camadas de API/servico e\n' +
      'diga explicitamente o que da UI ficou sem cobertura.',
  },

  'chrome-devtools': {
    label: 'Chrome DevTools MCP',
    mcp: {
      'chrome-devtools': {
        command: 'npx',
        args: ['-y', 'chrome-devtools-mcp@latest', '--headless', '--isolated'],
      },
    },
    mcpHint: [
      'Voce tem as ferramentas MCP do Chrome DevTools (prefixo `chrome-devtools`):',
      'navegue, tire snapshot de acessibilidade, clique, preencha, leia o console e',
      'as requisicoes de rede. Use `take_snapshot` para obter os refs dos elementos',
      'antes de interagir; `list_console_messages` e `list_network_requests` sao',
      'evidencia de defeito, nao decoracao.',
    ].join('\n'),
  },

  /**
   * Driven through its shell CLI, not its MCP server.
   *
   * The MCP server exists in recent versions, but the CLI has full parity and
   * costs nothing to support: no server process to start, no version to match,
   * no injection step — and it is the one path that works on all three tools,
   * Kiro included, since Kiro takes no MCP configuration on the command line.
   */
  'agent-browser': {
    label: 'agent-browser (CLI)',
    bin: 'agent-browser',
    cliHint: [
      'Voce tem o `agent-browser` no shell. Comandos principais:',
      '',
      '    agent-browser open <url>',
      '    agent-browser snapshot          # arvore de acessibilidade com refs @eN',
      '    agent-browser click @e2',
      '    agent-browser fill @e3 "texto"',
      '    agent-browser console           # erros de console = evidencia de defeito',
      '    agent-browser screenshot arquivo.png',
      '    agent-browser close',
      '',
      'Rode `agent-browser skills get core --full` uma vez antes de comecar: o guia',
      'vem com a versao instalada e evita que voce adivinhe flags que nao existem.',
      'O daemon persiste entre comandos, entao `open` e `snapshot` compartilham a',
      'mesma pagina.',
    ].join('\n'),
  },
};

/** Public shape, for the UI's selector. */
export const BROWSER_PRESETS = PRESETS;

/**
 * The default is the CLI one: it needs no server started, no download on first
 * use, and it is the only choice that works on all three tools.
 */
export const DEFAULT_BROWSER = 'agent-browser';

/**
 * Whether `agent-browser` is on PATH.
 *
 * Cached because this runs once per task creation and the answer does not change
 * while the daemon is up — installing it under a running daemon needs a restart
 * to be noticed.
 */
let agentBrowserProbe = null;

export async function probeAgentBrowser({ force = false } = {}) {
  if (agentBrowserProbe && !force) return agentBrowserProbe;

  try {
    const { stdout } = await exec('agent-browser', ['--version'], { timeout: 10000 });
    agentBrowserProbe = {
      installed: true,
      version: stdout.trim().replace(/^agent-browser\s*/, '') || null,
    };
  } catch {
    agentBrowserProbe = { installed: false, version: null };
  }
  return agentBrowserProbe;
}

/**
 * Turns a browser choice into what will actually be available to the tester.
 *
 * Returns the MCP servers to inject (or none), the prompt fragment describing
 * the real capability, and a `note` for the operator when the choice had to be
 * downgraded — silence there would leave someone believing they configured a
 * browser they did not get.
 */
export async function resolveBrowser(name, { tool = null } = {}) {
  const id = PRESETS[name] ? name : DEFAULT_BROWSER;
  const preset = PRESETS[id];

  if (id === 'none') {
    return { id, label: preset.label, mcpServers: null, transport: 'none', hint: preset.hint, note: null };
  }

  // driven through the shell, so it needs no MCP and works on every tool —
  // the only question is whether the binary is there
  if (id === 'agent-browser') {
    const probe = await probeAgentBrowser();
    return probe.installed
      ? { id, label: preset.label, mcpServers: null, transport: 'cli', hint: preset.cliHint, note: null }
      : {
          id,
          label: preset.label,
          mcpServers: null,
          transport: 'none',
          hint: PRESETS.none.hint,
          note: 'agent-browser nao esta instalado (`npm i -g agent-browser`) — o testador vai ficar sem navegador',
        };
  }

  // chrome-devtools: runs through npx, which installs on first use, so there is
  // nothing local to probe — but it has no CLI, so an agent that cannot receive
  // MCP gets no browser at all
  if (tool === 'kiro') {
    return {
      id, label: preset.label, mcpServers: null, transport: 'none',
      hint: PRESETS.none.hint,
      note: 'kiro nao aceita MCP por linha de comando e o chrome-devtools nao tem CLI — escolha agent-browser, ou outro testador',
    };
  }
  return {
    id, label: preset.label, mcpServers: preset.mcp, transport: 'mcp',
    hint: preset.mcpHint, note: null,
  };
}

/**
 * Reserves free TCP ports for the tester to boot the project on.
 *
 * Two QA steps running in parallel on different worktrees would both try to bind
 * the project's default port, and the second one fails in a way that looks like a
 * defect in the code under test. Handing each run its own ports removes that
 * false negative.
 *
 * There is an unavoidable race between closing the probe socket and the agent
 * binding it. It is tolerable here because the alternative — a fixed port — fails
 * every single time instead of rarely.
 */
export function reservePorts(count = 2) {
  return Promise.all(
    Array.from({ length: count }, () =>
      new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
          const { port } = srv.address();
          srv.close(() => resolve(port));
        });
      })
    )
  );
}

/** Where the tester leaves its artefacts, inside the worktree it tests. */
export const QA_DIR = '.honeycomb/qa';

/**
 * The tester's prompt.
 *
 * It is long on purpose, and the length is doing three specific jobs:
 *
 *   1. forcing an impact analysis BEFORE the plan, so the tests come from what
 *      changed rather than from what is easy to test;
 *   2. naming the concrete technique per kind of change (endpoint, consumer,
 *      screen, migration), because "test it" produces a smoke test and nothing
 *      more;
 *   3. making "I could not run it" a first-class outcome that is reported, never
 *      quietly upgraded to a pass.
 */
export function qaPrompt({
  spec,
  browser,
  startCommand = null,
  baseUrl = null,
  notes = null,
  regressionCommands = null,
}) {
  // `browser` is a resolved plan from `resolveBrowser`, not a preset name: what
  // goes in the prompt has to be what the tester will really find, not what was
  // asked for
  const hint = browser?.hint || PRESETS.none.hint;

  return [
    'Voce e um QA especialista. Outro agente implementou uma alteracao e um revisor',
    'ja aprovou o codigo. Seu trabalho e diferente do dele: o revisor leu o diff,',
    'voce vai SUBIR O PROJETO E EXERCITAR O QUE MUDOU. Codigo que compila e passa no',
    'lint pode nao funcionar.',
    '',
    'Voce esta dentro do worktree isolado que contem a alteracao. As dependencias do',
    'projeto estao instaladas aqui.',
    '',
    '## Tarefa que foi implementada',
    spec,
    '',
    '## Relato do implementador',
    '{{steps.impl.output}}',
    '',
    '## Parecer do revisor',
    '{{steps.review.output}}',
    '',
    '## Arquivos alterados',
    '{{steps.impl.diff}}',
    '',
    '## Parte 1 — analise de impacto (faca isto antes de qualquer teste)',
    '',
    'Leia o diff de verdade e responda, com nomes concretos de arquivo, rota, fila,',
    'tela ou tabela:',
    '',
    '1. Que fluxos de ponta a ponta esta alteracao muda? Comece pelo ponto de entrada',
    '   (requisicao HTTP, mensagem consumida, job agendado, acao na tela) e siga ate o',
    '   efeito final (resposta, escrita no banco, mensagem publicada, render).',
    '2. Que fluxos ela NAO muda mas passa perto — mesmo controller, mesmo servico,',
    '   mesma tabela, mesmo componente? Esses sao a sua superficie de regressao.',
    '3. Que mudancas de contrato existem (payload, status code, schema de evento,',
    '   coluna nova, props de componente)? Contrato quebrado e defeito mesmo quando',
    '   todos os testes existentes passam.',
    '',
    '## Parte 2 — plano de testes',
    '',
    `Escreva o plano em \`${QA_DIR}/plano.md\` no worktree, e so depois execute.`,
    'Cada caso precisa de: id, tipo (api | ui | fila | dados | regressao),',
    'pre-condicoes, passos, resultado esperado e como voce vai observar o resultado.',
    '',
    'O plano tem que cobrir, quando aplicavel: caminho feliz, pelo menos um caso de',
    'erro/borda por fluxo alterado, autorizacao (o endpoint novo esta protegido?),',
    'e os fluxos de regressao que voce listou na Parte 1. Nao invente casos para',
    'fluxos que a alteracao nao toca.',
    '',
    '## Parte 3 — subir o projeto',
    '',
    startCommand
      ? `O comando para subir e: \`${startCommand}\``
      : 'Descubra como subir o projeto lendo o repo (scripts do package.json, Makefile,\ndocker-compose, README, configuracao do framework). Suba as dependencias de\ninfraestrutura que o fluxo exigir (banco, broker, cache) — normalmente ha um\ndocker-compose para isso.',
    '',
    'PORTAS: use as portas reservadas para este run, disponiveis nas variaveis de',
    'ambiente `PORT` e `HONEYCOMB_QA_PORTS` (tambem interpoladas aqui: {{ports}}).',
    'Nao use a porta padrao do projeto — pode haver outro agente rodando em paralelo,',
    'e a colisao apareceria como se fosse defeito da alteracao.',
    '',
    baseUrl
      ? `A aplicacao deve responder em: ${baseUrl}`
      : 'Aguarde o servico ficar realmente pronto (health check, log de "listening",\npolling no endpoint) antes de comecar. Um teste que roda contra um servico ainda\nsubindo produz falha falsa.',
    '',
    `Mande os logs do que voce subir para \`${QA_DIR}/\` — eles sao a evidencia de que`,
    'o servico estava de pe e de que erro apareceu durante o teste.',
    '',
    '## Parte 4 — executar o plano',
    '',
    'Escolha a tecnica pelo tipo de mudanca:',
    '',
    '**Endpoints HTTP.** Chame de verdade. Use `curl` (ou o `bru`/Bruno se o repo ja',
    'tiver uma colecao — nesse caso adicione as requisicoes novas a colecao, para o',
    'trabalho sobreviver a este run). Verifique status code, corpo, headers e efeito',
    'colateral no banco. Teste tambem sem credencial e com credencial de outro',
    'usuario quando fizer sentido.',
    '',
    '**Filas e consumidores.** Nao basta ver o processo subir. Publique uma mensagem',
    'real no broker do projeto e comprove o efeito: registro gravado, mensagem de',
    'saida publicada, log de processamento. Teste tambem mensagem malformada e, se',
    'houver DLQ ou retry, comprove o comportamento.',
    '',
    '**Jobs e schedulers.** Dispare o job manualmente pelo caminho que o codigo expoe',
    'em vez de esperar o cron.',
    '',
    '**Front-end.** Abra a tela no navegador e execute o fluxo como um usuario.',
    hint,
    'Erro no console, requisicao 4xx/5xx disparada pela tela e estado que nao',
    'atualiza contam como defeito. Guarde screenshot dos pontos relevantes em',
    `\`${QA_DIR}/\`.`,
    '',
    '**Banco de dados / migrations.** Rode a migration, confirme o schema resultante',
    'e, se houver caminho de volta, confirme que o rollback funciona.',
    '',
    '**Regressao automatizada.** Rode a suite existente do projeto:',
    ...(regressionCommands?.length
      ? regressionCommands.map((c) => `    ${c}`)
      : ['    (descubra os comandos de teste do repo e rode todos os que existirem)']),
    '',
    'Se um teste ja falhava antes da alteracao, comprove isso comparando com a branch',
    'base antes de classificar como pre-existente. Pre-existente comprovado nao',
    'reprova; pre-existente presumido nao existe.',
    '',
    '## Parte 5 — limpar',
    '',
    'Derrube tudo que voce subiu: servidores, containers, navegador. Nada pode ficar',
    'segurando porta depois que voce terminar.',
    '',
    '## Regras',
    '',
    '- Voce NAO conserta o codigo de producao. Se achar defeito, descreva-o bem o',
    '  suficiente para outro agente corrigir. Voce so escreve artefatos de teste',
    `  (\`${QA_DIR}/\`, colecoes Bruno, testes automatizados novos).`,
    '- Nao aprove o que voce nao executou. "Nao consegui subir o projeto" e um',
    '  resultado legitimo e leva a REPROVADO com o motivo — nunca a um caso marcado',
    '  como passou.',
    '',
    '## Commit',
    '',
    'Ao terminar, commite seus artefatos de teste nesta branch de worktree:',
    '',
    '    git add -A && git commit -m "qa: plano e artefatos de teste"',
    '',
    'Nunca rode `git checkout`, `git switch`, `git push` nem mude de branch: voce esta',
    'numa branch isolada e o commit tem que ficar nela. Nao inclua na mensagem de',
    'commit nenhum trailer de co-autoria, atribuicao a IA ou "Generated with" —',
    'mensagem limpa, so o que foi feito.',
    '',
    '## Formato da resposta',
    '',
    '1. **Fluxos impactados** — o resultado da Parte 1, curto.',
    `2. **Plano** — caminho do arquivo e quantos casos ele tem.`,
    '3. **Execucao** — uma linha por caso: `id | tipo | PASSOU / FALHOU / NAO EXECUTADO`',
    '   e, quando nao passou, o motivo em uma frase.',
    '4. **Defeitos** — para cada um: como reproduzir, o que era esperado, o que',
    '   aconteceu, evidencia (log, status, screenshot) e o arquivo suspeito.',
    '5. **Cobertura que ficou de fora** — o que voce nao conseguiu testar e por que.',
    '',
    'Termine com a linha exata:',
    '',
    'VEREDITO: APROVADO   (ou)   VEREDITO: REPROVADO',
    '',
    'REPROVADO se houver qualquer defeito causado por esta alteracao, ou se voce nao',
    'conseguiu exercitar os fluxos principais que ela toca.',
    ...(notes ? ['', '## Observacoes de quem pediu a tarefa', notes] : []),
  ].join('\n');
}
