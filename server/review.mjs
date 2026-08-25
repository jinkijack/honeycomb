/**
 * The reviewer's prompt.
 *
 * It lived inline in `crossValidationTemplate` until the standalone validator
 * run needed the same text. Two callers with two copies of a prompt is how a
 * flow starts drifting from itself — the review that runs inside a `cross` and
 * the review you fire by hand at the same worktree have to ask for exactly the
 * same thing, or their verdicts are not comparable.
 *
 * The `implOutput`/`implDiff` defaults are the orchestrator's interpolation
 * tokens: inside a task the orchestrator fills them from the step results, and a
 * standalone run passes the real values in, because there are no steps to
 * interpolate from.
 */

/** What the reviewer is told when nobody named the verification commands. */
export const DISCOVER_VERIFICATION = [
  'Ninguem informou os comandos de verificacao deste projeto, entao descubra-os',
  'antes de revisar. Este repo pode ser de qualquer stack — nao presuma nenhuma.',
  '',
  'Em ordem de confiabilidade:',
  '',
  '  1. `.github/workflows/*.yml` (ou outro CI): e a unica documentacao que nao',
  '     pode estar desatualizada, porque ela roda.',
  '  2. Os scripts do manifesto que existir: `package.json`, `pom.xml`,',
  '     `build.gradle`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `*.csproj`,',
  '     `Gemfile`, `composer.json`.',
  '  3. `Makefile` / `Taskfile.yml` / `justfile`, e o README.',
  '',
  'Rode o que achar de build/compilacao, checagem estatica e testes. Se o projeto',
  'nao tiver alguma dessas coisas, isso e um fato sobre o projeto e nao reprova —',
  'diga que nao existe, nao invente um comando para poder dizer que falhou.',
];

export function reviewPrompt({
  spec,
  commands = null,
  implOutput = '{{steps.impl.output}}',
  implDiff = '{{steps.impl.diff}}',
}) {
  return [
    'Voce esta revisando o trabalho de outro agente, ja aplicado no worktree atual.',
    '',
    '## Tarefa original',
    spec,
    '',
    '## Relato do implementador',
    implOutput,
    '',
    '## Arquivos alterados',
    implDiff,
    '',
    '## Parte 1 — EXECUTE, nao apenas leia',
    '',
    'Os diretorios de dependencia do repo principal estao ligados por symlink',
    'neste worktree, entao normalmente nao ha o que instalar.',
    '',
    ...(commands?.length
      ? ['Rode, nesta ordem:', '', ...commands.map((cmd) => `    ${cmd}`)]
      : DISCOVER_VERIFICATION),
    '',
    'Se algum comando nao existir ou falhar por motivo pre-existente (quebrado',
    'tambem na branch base), verifique isso comparando com o repo original e',
    'diga explicitamente que e pre-existente. Se voce nao conseguir executar',
    'algum passo, diga qual e por que — nunca presuma que passou.',
    '',
    'Se o build, a checagem estatica ou os testes falharem POR CAUSA desta',
    'implementacao, o veredito e REPROVADO, independente da qualidade do codigo.',
    '',
    '## Parte 2 — revise o codigo',
    '',
    '1. A implementacao cumpre a tarefa?',
    '2. Ha bug, regressao ou caso de borda nao tratado?',
    '3. Segue os padroes do projeto? (verifique o padrao dominante no repo,',
    '   nao apenas o arquivo alterado)',
    '',
    '## Formato da resposta',
    '',
    'Comece com um bloco "Verificacao executada" listando cada comando que voce',
    'rodou e o resultado real (passou / falhou / nao consegui rodar e por que).',
    'Depois a revisao de codigo. Termine com a linha exata:',
    '',
    'VEREDITO: APROVADO   (ou)   VEREDITO: REPROVADO',
  ].join('\n');
}
