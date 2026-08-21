import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Field, Input, Textarea, Select } from './ui.jsx';
import ModelPicker from './ModelPicker.jsx';

const MODES = [
  ['ro', 'somente leitura'],
  ['verify', 'leitura + shell'],
  ['rw', 'leitura + escrita'],
  ['full', 'total (escrita + shell)'],
];

export default function Composer({ repo, setRepo, tools, onCreated }) {
  const [kind, setKind] = useState('cross');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const [spec, setSpec] = useState('');
  const [title, setTitle] = useState('');
  const [implementer, setImplementer] = useState('kiro');
  const [validator, setValidator] = useState('claude');
  const [implModel, setImplModel] = useState('');
  const [valModel, setValModel] = useState('');

  // QA stage — off by default: it costs a third agent and the wall-clock time of
  // booting the project, which plenty of changes do not justify
  const [qa, setQa] = useState(false);
  const [tester, setTester] = useState('claude');
  const [testerModel, setTesterModel] = useState('');
  const [browsers, setBrowsers] = useState(null);
  const [browser, setBrowser] = useState('agent-browser');
  const [startCmd, setStartCmd] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [qaNotes, setQaNotes] = useState('');

  const [tool, setTool] = useState('kiro');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState('ro');
  const [isolation, setIsolation] = useState('worktree');
  const [model, setModel] = useState('');

  // switching tools invalidates the chosen model: the id does not exist on the other
  useEffect(() => setModel(''), [tool]);
  useEffect(() => setImplModel(''), [implementer]);
  useEffect(() => setValModel(''), [validator]);
  useEffect(() => setTesterModel(''), [tester]);

  /**
   * Re-resolved whenever the tester changes: what a browser choice actually
   * becomes depends on the tool (kiro takes no MCP on the command line) and on
   * what is installed. Showing the resolved answer here is what stops someone
   * configuring a browser the tester will never see.
   */
  useEffect(() => {
    let alive = true;
    api
      .browsers(tester)
      .then((r) => {
        if (!alive) return;
        setBrowsers(r);
        setBrowser((cur) => (r.browsers.some((b) => b.id === cur) ? cur : r.default));
      })
      .catch(() => alive && setBrowsers({ browsers: [] }));
    return () => {
      alive = false;
    };
  }, [tester]);

  const resolvedBrowser = browsers?.browsers?.find((b) => b.id === browser) || null;

  const available = tools.filter((t) => t.available).map((t) => t.name);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (kind === 'cross') {
        const task = await api.crossValidation({
          title: title || spec.slice(0, 60),
          repo,
          spec,
          implementer,
          validator,
          implementerModel: implModel || undefined,
          validatorModel: valModel || undefined,
          qa,
          tester,
          testerModel: testerModel || undefined,
          qaBrowser: browser,
          startCommand: startCmd || undefined,
          baseUrl: baseUrl || undefined,
          qaNotes: qaNotes || undefined,
          autoRun: true,
        });
        onCreated?.('task', task);
        setSpec('');
        setTitle('');
      } else {
        const { runId } = await api.startRun({
          tool, prompt, repo, mode, isolation,
          model: model || undefined,
          label: prompt.slice(0, 50),
        });
        onCreated?.('run', { id: runId });
        setPrompt('');
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = repo && (kind === 'cross' ? spec.trim() : prompt.trim()) && !busy;

  return (
    <Card className="p-5">
      <div className="mb-5 flex gap-1 rounded-lg bg-comb-950/60 p-1">
        {[
          ['cross', 'Validação cruzada'],
          ['single', 'Run único'],
        ].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setKind(id)}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              kind === id ? 'bg-wax-50/10 text-wax-100' : 'text-wax-700 hover:text-wax-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        <Field label="Repositório" hint="precisa ser um repo git">
          <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="/caminho/do/repo" />
        </Field>

        {kind === 'cross' ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Implementador" hint="escreve o código">
                <Select value={implementer} onChange={(e) => setImplementer(e.target.value)}>
                  {available.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Validador" hint="revisa e dá veredito">
                <Select value={validator} onChange={(e) => setValidator(e.target.value)}>
                  {available.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <ModelPicker tool={implementer} value={implModel} onChange={setImplModel} label="Modelo do implementador" />
              <ModelPicker tool={validator} value={valModel} onChange={setValModel} label="Modelo do validador" />
            </div>

            <Field label="Título" hint="opcional">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Exclusão em lote de documentos" />
            </Field>

            <Field label="Especificação da tarefa">
              <Textarea
                rows={8}
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
                placeholder={'Descreva a tarefa como descreveria para um dev.\n\nEx: implementar exclusão em lote na tela de documentos — seleção múltipla, confirmação, chamada ao endpoint de batch e atualização da lista.'}
              />
            </Field>

            <div className="rounded-lg ring-1 ring-comb-600 ring-inset">
              <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={qa}
                  onChange={(ev) => setQa(ev.target.checked)}
                  className="mt-0.5 accent-honey"
                />
                <span className="min-w-0">
                  <span className="text-xs font-medium text-wax-100">Etapa de QA</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-wax-700">
                    Depois da revisão, um agente testador sobe o projeto em portas reservadas, monta um
                    plano a partir do que mudou e executa: endpoints por HTTP, filas publicando mensagem
                    de verdade, telas no navegador — mais a regressão em volta.
                  </span>
                </span>
              </label>

              {qa && (
                <div className="space-y-3 border-t border-comb-600 px-3 py-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Testador" hint="executa o plano">
                      <Select value={tester} onChange={(ev) => setTester(ev.target.value)}>
                        {available.map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field
                      label="Navegador"
                      hint={
                        resolvedBrowser
                          ? { mcp: 'via MCP', cli: 'via CLI', none: 'indisponível' }[resolvedBrowser.transport]
                          : 'para mudanças de front'
                      }
                    >
                      <Select value={browser} onChange={(ev) => setBrowser(ev.target.value)}>
                        {(browsers?.browsers || []).map((b) => (
                          <option key={b.id} value={b.id}>{b.label}</option>
                        ))}
                      </Select>
                    </Field>
                  </div>

                  <ModelPicker tool={tester} value={testerModel} onChange={setTesterModel} label="Modelo do testador" />

                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Comando para subir" hint="opcional — senão ele descobre">
                      <Input value={startCmd} onChange={(ev) => setStartCmd(ev.target.value)} placeholder="npm run dev" />
                    </Field>
                    <Field label="URL base" hint="opcional">
                      <Input value={baseUrl} onChange={(ev) => setBaseUrl(ev.target.value)} placeholder="http://localhost:$PORT" />
                    </Field>
                  </div>

                  <Field label="O que testar com atenção" hint="opcional">
                    <Textarea
                      rows={3}
                      value={qaNotes}
                      onChange={(ev) => setQaNotes(ev.target.value)}
                      placeholder="Ex: o consumidor da fila de faturas precisa aguentar mensagem duplicada."
                    />
                  </Field>

                  {resolvedBrowser?.note && (
                    <p className="rounded-lg bg-peach/5 px-3 py-2 text-[11px] leading-relaxed text-peach ring-1 ring-peach/20 ring-inset">
                      {resolvedBrowser.note}
                    </p>
                  )}
                </div>
              )}
            </div>

            <p className="rounded-lg bg-azure/5 px-3 py-2 text-[11px] leading-relaxed text-wax-500 ring-1 ring-azure/10 ring-inset">
              O <strong className="text-wax-300">{implementer}</strong> implementa em modo total num worktree
              isolado. Depois o <strong className="text-wax-300">{validator}</strong> entra nesse mesmo worktree
              em modo somente leitura, revisa o diff e responde <span className="font-mono">APROVADO</span> ou{' '}
              <span className="font-mono">REPROVADO</span>.
              {qa && (
                <>
                  {' '}Aprovado, o <strong className="text-wax-300">{tester}</strong> testa rodando; defeito que
                  ele achar volta ao implementador e passa pela revisão de novo antes de ser retestado.
                </>
              )}{' '}
              Cada passo commita na branch do próprio worktree — seu working tree não é tocado.
            </p>
          </>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Ferramenta">
                <Select value={tool} onChange={(e) => setTool(e.target.value)}>
                  {available.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Permissão">
                <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                  {MODES.map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Isolamento">
                <Select value={isolation} onChange={(e) => setIsolation(e.target.value)}>
                  <option value="worktree">worktree isolado</option>
                  <option value="shared">direto no repo</option>
                </Select>
              </Field>
            </div>

            <ModelPicker tool={tool} value={model} onChange={setModel} />

            <Field label="Prompt">
              <Textarea rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="O que o agente deve fazer…" />
            </Field>

            {isolation === 'shared' && mode !== 'ro' && (
              <p className="rounded-lg bg-ember/5 px-3 py-2 text-[11px] text-ember/90 ring-1 ring-ember/20 ring-inset">
                Atenção: o agente vai escrever direto no seu working tree, misturando com alterações não commitadas.
              </p>
            )}
          </>
        )}

        {err && (
          <p className="rounded-lg bg-ember/10 px-3 py-2 font-mono text-[11px] text-ember">{err}</p>
        )}

        <Button variant="primary" className="w-full py-2" disabled={!canSubmit} onClick={submit}>
          {busy ? 'disparando…' : kind === 'cross' ? 'criar e executar task' : 'disparar run'}
        </Button>
      </div>
    </Card>
  );
}
