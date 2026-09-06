# R2 — Aba "Repasses": separar o dinheiro em 3 estágios

Mexer **somente** na aba **"Repasses"**. Não tocar em "Visão Geral", "PagBank",
"Dashboard" nem em nenhuma outra aba nesta rodada.

## Problema

Hoje a aba mistura "dinheiro que ainda está liberando na plataforma" com
"dinheiro que já está a caminho do banco". São coisas diferentes, com datas
diferentes, e o usuário não consegue responder "quando cai no Santander?".

## O que fazer

Endpoint novo (já no ar): `GET /api/recebimentos/estagios`

Montar **três blocos empilhados, nessa ordem**, cada um com título e valor total:

**Bloco 1 — "Liberando na plataforma"** → `liberando.total`
- Sub-valores: `liberando.stripe` e `liberando.pagbank`
- Lista por data a partir de `liberando.por_data[]`, com os campos
  `data_br`, `stripe`, `pagbank`, `total`, `atrasado`
- Linha com `atrasado === true` recebe etiqueta âmbar "atrasado"

**Bloco 2 — "Em trânsito para o banco"** → `em_transito.total`
- Destaque no topo: `em_transito.proxima_chegada.valor` chegando em
  `em_transito.proxima_chegada.data_chegada_br`
- Lista de `em_transito.itens[]` com `valor`, `data_chegada_br` e `status`
- Traduzir `status`: `in_transit` → "a caminho", `pending` → "agendado"
- `em_transito.pagbank` vem **null** de propósito. Nesse caso mostrar "—" com
  tooltip usando o texto de `em_transito.pagbank_nota`. Nunca renderizar R$ 0,00.

**Bloco 3 — "Já caiu no banco"** → `recebido.total`
- Lista de `recebido.itens[]` com `valor` e `data_chegada_br`
- Respeita o filtro de período que já existe no topo da tela

Fora dos blocos, mostrar o saldo já liberado e parado: `disponivel.stripe`.
`disponivel.pagbank` também vem **null** — mesmo tratamento de "—" com tooltip
vindo de `disponivel.pagbank_nota`.

## Proibições

- Não remover o que já existe na aba antes de confirmar que os 3 blocos renderizam.
- Não criar rota nova nem alterar o menu de abas.
- Não somar `liberando.total` com `em_transito.total`: é o mesmo dinheiro em
  estágios diferentes, somar conta em dobro.
- Não inventar valor para os campos que vêm `null`.

## Verificação

Ao terminar, confirme: (a) arquivo e linha de cada alteração; (b) que os 3
blocos aparecem ao abrir a aba "Repasses" sem clicar em mais nada; (c) que o
bloco 2 lista os repasses com a data de chegada de cada um; (d) que os campos
`null` do PagBank aparecem como "—" e não como zero.
