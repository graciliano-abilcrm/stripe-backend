# R5 — Aba "Pagamentos": corrigir o tipo manualmente

Só rodar **depois** que o R4 estiver publicado e funcionando.

Mexer **somente** na aba **"Pagamentos"**. Não tocar em nenhuma outra aba.

## Contexto

A coluna **"Tipo"** é calculada por heurística de valor e descrição. Ela acerta a regra
mas erra alguns casos reais: cliente que paga a **mensalidade** por PIX ou boleto no
PagBank aparece como "Impl. Básica" ou "Impl. Personalizada", porque o valor cai na
faixa de implementação. Ex.: Divinal Vidros paga R$ 2.550 de mensalidade por boleto.

Cada pagamento agora traz **`tipo_fonte`**:

| `tipo_fonte` | significado |
|---|---|
| `heuristica` | calculado por valor/descrição — pode estar errado |
| `invoice` | veio da assinatura da Stripe — confiável |
| `manual_cliente` | regra que você criou para esse cliente |
| `manual_transacao` | correção que você fez nessa linha |

## O que fazer

**1. Na coluna "Tipo"**, quando `tipo_fonte === 'heuristica'`, deixar a etiqueta
clicável (cursor de ponteiro + leve sublinhado tracejado). Quando for
`manual_cliente` ou `manual_transacao`, mostrar um ponto/ícone indicando que foi
ajustado à mão.

**2. Ao clicar na etiqueta**, abrir um menu pequeno com:
- os tipos disponíveis, vindos de `GET /api/tipo-overrides` campo `tipos_validos`
  (`assinatura`, `variavel`, `implementacao`, `implementacao_basica`,
  `implementacao_personalizada`, `implementacao_avancada`)
- duas opções de alcance, com estes rótulos exatos:
  - **"Só este pagamento"**
  - **"Sempre que este cliente pagar"**

**3. Ao confirmar:**
```
POST /api/tipo-overrides
```
- "Só este pagamento" → `{ "tipo": "<escolhido>", "escopo": "transacao", "tx_id": "<id do pagamento>" }`
- "Sempre que este cliente pagar" → `{ "tipo": "<escolhido>", "escopo": "cliente", "subconta_id": "<subconta_id do pagamento>" }`
  - se o pagamento **não** tiver `subconta_id`, mandar `"email"` no lugar; sem e-mail,
    mandar `"nome"`. Preferir sempre `subconta_id`: é a identidade que não muda.

**4. Depois de salvar**, recarregar a lista: a linha deve voltar com o tipo novo e
`tipo_fonte` começando com `manual_`.

**5. Desfazer**: `DELETE /api/tipo-overrides?escopo=cliente|transacao&chave=<chave>`.
A `chave` vem na resposta do POST e também na listagem do `GET`.

## Proibições

- Não recalcular tipo nenhum no front: o tipo vem pronto do backend.
- Não criar tela de administração de regras nesta rodada — só o menu na linha.
- Não mexer na coluna "Subconta / Link" (foi o R4) nem em Valor/Status.

## Verificação

Ao terminar, confirme: (a) arquivo e linha de cada alteração; (b) que ao abrir a aba
"Pagamentos" as etiquetas de tipo com `tipo_fonte: heuristica` são clicáveis; (c) que
marcar "Sempre que este cliente pagar" em um pagamento da Divinal muda o tipo dela e a
linha volta com `tipo_fonte: manual_cliente`.
