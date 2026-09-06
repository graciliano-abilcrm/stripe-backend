# R4 — Aba "Pagamentos": vincular subconta manualmente

Mexer **somente** na aba **"Pagamentos"**. Não tocar em "Visão Geral", "Repasses",
"Clientes" nem em nenhuma outra aba nesta rodada.

## Contexto

O backend passou a identificar a subconta sozinho em 95% dos casos (antes eram 73%).
Cada pagamento agora traz **`subconta_id`** e **`subconta_fonte`**, que diz de onde veio:

| `subconta_fonte` | significado | como exibir |
|---|---|---|
| `metadata` | ID exato vindo da Stripe | normal, sem marcação |
| `manual` | vínculo feito por você | normal, com ícone de vínculo |
| `email` | casou pelo domínio do e-mail | normal |
| `nome` | casou por semelhança de nome | etiqueta discreta "por nome" |
| `nao_aplicavel` | verificação de cartão, não é venda | "—" apagado |
| `nao_identificado` | ninguém achou | **botão "Vincular"** |

## O que fazer

**1. Coluna "Subconta / Link"**: quando `subconta_fonte === 'nao_identificado'`,
em vez do traço, mostrar um botão **"Vincular"**.

**2. Ao clicar em "Vincular"**, abrir um modal com busca de subconta:
- `GET /api/ghl/locations?search=<termo>` → `{ total, locations: [{id, nome, email}] }`
- Buscar a cada digitação (a partir de 2 caracteres), listar `nome` e `email`
- São 436 subcontas: sempre buscar pela API, nunca carregar tudo de uma vez

**3. Ao escolher a subconta**, salvar com:
```
POST /api/vinculos
{ "chave": "<chave>", "subconta_id": "<id escolhido>", "origem_nome": "<nome do pagador>" }
```
Como montar a `chave`, nesta ordem de preferência:
- tem `email` no pagamento → `"email:" + email`
- senão, plataforma Stripe → `"stripe:" + stripe_customer_id`
- senão, plataforma PagBank → `"pagbank:" + id`

Usar `email:` quando houver faz o vínculo valer para os pagamentos futuros do mesmo
cliente, não só para aquela linha.

**4. Depois de salvar**, recarregar a lista. A linha deve voltar com
`subconta_fonte === 'manual'`.

**5. Desfazer**: `DELETE /api/vinculos?chave=<chave>`. Mostrar essa opção só nas linhas
com `subconta_fonte === 'manual'`.

## Proibições

- Não criar tela nem rota nova: o modal vive dentro da aba "Pagamentos".
- Não montar a lista de subcontas no front a partir dos pagamentos — usar o endpoint.
- Não mexer nas colunas Data, Plataforma, Valor, Status ou Recebimento.
- Não esconder linhas com `nao_identificado`: elas são o trabalho a fazer.

## Verificação

Ao terminar, confirme: (a) arquivo e linha de cada alteração; (b) que ao abrir a aba
"Pagamentos" as linhas sem subconta mostram "Vincular"; (c) que após vincular um
pagamento a linha volta com o nome da subconta e o ícone de vínculo manual.
